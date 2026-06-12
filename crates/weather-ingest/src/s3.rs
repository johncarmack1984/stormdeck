//! Minimal SigV4-signed S3 PutObject over reqwest.
//!
//! Deliberately not aws-sdk-s3: this lambda only ever PUTs a couple of small
//! JSON objects, and as of aws-runtime 1.7.4 + aws-smithy-runtime-api 1.12.3
//! the SDK doesn't even compile (E0282 version skew). One signed PUT is ~80
//! lines and cuts the binary and cold start dramatically.

use anyhow::{ensure, Context, Result};
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use time::format_description::BorrowedFormatItem;
use time::macros::format_description;
use time::OffsetDateTime;

const AMZ_DATE: &[BorrowedFormatItem] =
    format_description!("[year][month][day]T[hour][minute][second]Z");
const SHORT_DATE: &[BorrowedFormatItem] = format_description!("[year][month][day]");

#[derive(Clone)]
struct Creds {
    access_key: String,
    secret_key: String,
    session_token: Option<String>,
}

impl Creds {
    /// Lambda injects the execution role's credentials into these env vars.
    fn from_env() -> Result<Self> {
        Ok(Self {
            access_key: std::env::var("AWS_ACCESS_KEY_ID").context("AWS_ACCESS_KEY_ID not set")?,
            secret_key: std::env::var("AWS_SECRET_ACCESS_KEY")
                .context("AWS_SECRET_ACCESS_KEY not set")?,
            session_token: std::env::var("AWS_SESSION_TOKEN").ok(),
        })
    }
}

#[derive(Clone)]
pub struct S3Writer {
    http: reqwest::Client,
    creds: Creds,
    region: String,
    pub bucket: String,
}

impl S3Writer {
    pub fn from_env(http: reqwest::Client) -> Result<Self> {
        Ok(Self {
            http,
            creds: Creds::from_env()?,
            region: std::env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".to_string()),
            bucket: std::env::var("BUCKET").context("BUCKET env var is required in Lambda")?,
        })
    }
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k = hmac(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k = hmac(&k, region.as_bytes());
    let k = hmac(&k, service.as_bytes());
    hmac(&k, b"aws4_request")
}

impl S3Writer {
    pub async fn put(
        &self,
        key: &str,
        body: Vec<u8>,
        content_type: &str,
        cache_control: &str,
    ) -> Result<()> {
        // Keys here are [a-z0-9/._-] only, which need no percent-encoding;
        // keep it that way rather than dragging in an encoder.
        ensure!(
            key.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b)),
            "key '{key}' has characters this minimal signer doesn't encode"
        );

        let (region, bucket) = (&self.region, &self.bucket);
        let host = format!("{bucket}.s3.{region}.amazonaws.com");
        let uri = format!("/{key}");
        let now = OffsetDateTime::now_utc();
        let amz_date = now.format(AMZ_DATE)?;
        let date = now.format(SHORT_DATE)?;
        let payload_hash = sha256_hex(&body);

        // Canonical headers must be sorted; only host + x-amz-* need signing.
        let mut canonical_headers =
            format!("host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n");
        let mut signed_headers = String::from("host;x-amz-content-sha256;x-amz-date");
        if let Some(token) = &self.creds.session_token {
            canonical_headers.push_str(&format!("x-amz-security-token:{token}\n"));
            signed_headers.push_str(";x-amz-security-token");
        }

        let canonical_request =
            format!("PUT\n{uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
        let scope = format!("{date}/{region}/s3/aws4_request");
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
            sha256_hex(canonical_request.as_bytes())
        );
        let key_material = signing_key(&self.creds.secret_key, &date, region, "s3");
        let signature = hex::encode(hmac(&key_material, string_to_sign.as_bytes()));
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.creds.access_key
        );

        let mut req = self
            .http
            .put(format!("https://{host}{uri}"))
            .header("authorization", authorization)
            .header("x-amz-date", amz_date)
            .header("x-amz-content-sha256", payload_hash)
            .header("content-type", content_type)
            .header("cache-control", cache_control)
            .body(body);
        if let Some(token) = &self.creds.session_token {
            req = req.header("x-amz-security-token", token);
        }

        let resp = req
            .send()
            .await
            .with_context(|| format!("PUT https://{host}{uri}"))?;
        let status = resp.status();
        if !status.is_success() {
            let detail = resp.text().await.unwrap_or_default();
            anyhow::bail!("S3 PUT {uri} failed: {status} {detail}");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Known vector from the AWS SigV4 documentation ("Deriving the signing key").
    #[test]
    fn signing_key_matches_aws_documented_example() {
        let key = signing_key(
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "20150830",
            "us-east-1",
            "iam",
        );
        assert_eq!(
            hex::encode(key),
            "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"
        );
    }
}
