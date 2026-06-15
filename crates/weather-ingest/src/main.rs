//! Fetches live weather and publishes JSON snapshots for the map to consume.
//!
//! Sources:
//!   - NWS active alerts (api.weather.gov, public domain)
//!   - Open-Meteo current conditions on a grid over BBOX (CC-BY 4.0)
//!
//! Runs in two modes:
//!   - AWS Lambda (AWS_LAMBDA_RUNTIME_API set): writes to s3://$BUCKET/weather/,
//!     invoked by EventBridge Scheduler with {"job": "alerts" | "grid" | "all"}
//!   - CLI (`cargo run -p weather-ingest -- all`): writes to $LOCAL_OUT
//!     (default web/public/weather/) so `just dev` has live data.

mod contract;
mod s3;

use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, ensure, Context, Result};
use contract::{AlertProps, GridProps, Severity, Snapshot};
use typed_geojson::{Feature, Point};
use lambda_runtime::LambdaEvent;
use serde_json::{json, Value};
use tracing::{info, warn};

#[derive(Clone)]
struct Config {
    /// NWS area code; empty means every active alert in the US.
    nws_area: String,
    bbox: [f64; 4], // west, south, east, north
    grid_cols: usize,
    grid_rows: usize,
    /// Spacing of the whole-planet conditions lattice, in degrees.
    global_step: f64,
}

impl Config {
    fn from_env() -> Result<Self> {
        let bbox_raw =
            std::env::var("BBOX").unwrap_or_else(|_| "-98.2,31.8,-95.8,33.6".to_string());
        let parts: Vec<f64> = bbox_raw
            .split(',')
            .map(|p| p.trim().parse())
            .collect::<Result<_, _>>()
            .context("BBOX must be numeric: minLon,minLat,maxLon,maxLat")?;
        ensure!(parts.len() == 4, "BBOX must have exactly 4 numbers");
        let global_step = env_f64("GLOBAL_STEP_DEG", 6.0);
        ensure!(
            (1.0..=30.0).contains(&global_step),
            "GLOBAL_STEP_DEG must be between 1 and 30"
        );
        Ok(Self {
            nws_area: std::env::var("NWS_AREA").unwrap_or_default(),
            bbox: [parts[0], parts[1], parts[2], parts[3]],
            grid_cols: env_usize("GRID_COLS", 8),
            grid_rows: env_usize("GRID_ROWS", 6),
            global_step,
        })
    }
}

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_f64(key: &str, default: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_millis() as u64
}

/// Active NWS alerts, slimmed to what the map renders. With no NWS_AREA
/// set this is every active alert in the US — the camera roams the planet,
/// so the feed covers everything the NWS publishes.
async fn fetch_alerts(http: &reqwest::Client, cfg: &Config) -> Result<Value> {
    let mut url =
        String::from("https://api.weather.gov/alerts/active?status=actual&message_type=alert");
    if !cfg.nws_area.is_empty() {
        url.push_str(&format!("&area={}", cfg.nws_area));
    }
    info!("fetching NWS alerts: {url}");
    let started = Instant::now();
    let body: Value = http
        .get(&url)
        .header("accept", "application/geo+json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
        .context("NWS alerts response was not JSON")?;

    let features = match body.get("features").and_then(Value::as_array) {
        Some(f) => f.clone(),
        None => bail!("NWS alerts response missing 'features'"),
    };
    let total = features.len();
    // Zone-based alerts ship without geometry; the map can't draw those.
    let drawable: Vec<Feature<Value, AlertProps>> = features
        .into_iter()
        .filter(|f| !f["geometry"].is_null())
        .map(|mut f| {
            let p = &f["properties"];
            let props = AlertProps {
                id: p["id"].as_str().unwrap_or_default().to_owned(),
                event: p["event"].as_str().unwrap_or_default().to_owned(),
                severity: Severity::from(p["severity"].as_str()),
                headline: p["headline"].as_str().map(str::to_owned),
                area_desc: p["areaDesc"].as_str().map(str::to_owned),
                onset: p["onset"].as_str().map(str::to_owned),
                expires: p["expires"].as_str().map(str::to_owned),
            };
            Feature::new(f["geometry"].take(), props)
        })
        .collect();
    let scope = if cfg.nws_area.is_empty() {
        "US"
    } else {
        &cfg.nws_area
    };
    info!(
        "NWS alerts: {total} active in {scope}, {} with geometry, fetched in {:.1?}",
        drawable.len(),
        started.elapsed()
    );
    if drawable.len() < total {
        warn!(
            "dropped {} zone-based alerts without geometry",
            total - drawable.len()
        );
    }
    Ok(serde_json::to_value(Snapshot::new(now_ms(), drawable))?)
}

const OPEN_METEO_CURRENT: &str =
    "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code";

fn open_meteo_url(lats: &[String], lons: &[String]) -> String {
    format!(
        "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}\
         &current={OPEN_METEO_CURRENT}&temperature_unit=fahrenheit&wind_speed_unit=mph",
        lats.join(","),
        lons.join(",")
    )
}

/// Single location -> object, multiple -> array.
fn open_meteo_cells(body: Value) -> Result<Vec<Value>> {
    match body {
        Value::Array(a) => Ok(a),
        v @ Value::Object(_) => Ok(vec![v]),
        other => bail!("unexpected Open-Meteo response shape: {other}"),
    }
}

/// `lattice` carries the cell's column/row so the frontend can thin the
/// global grid at low zooms without re-deriving the layout.
fn cell_feature(
    cell: &Value,
    lattice: Option<(usize, usize)>,
) -> Result<Feature<Point, GridProps>> {
    let cur = &cell["current"];
    let lon = cell["longitude"]
        .as_f64()
        .context("Open-Meteo cell missing longitude")?;
    let lat = cell["latitude"]
        .as_f64()
        .context("Open-Meteo cell missing latitude")?;
    Ok(Feature::new(
        Point::new(vec![lon, lat]),
        GridProps {
            temp_f: cur["temperature_2m"].as_f64(),
            rh: cur["relative_humidity_2m"].as_f64(),
            wind_mph: cur["wind_speed_10m"].as_f64(),
            wind_dir: cur["wind_direction_10m"].as_f64(),
            code: cur["weather_code"].as_f64(),
            i: lattice.map(|(i, _)| i as u32),
            j: lattice.map(|(_, j)| j as u32),
        },
    ))
}

/// Current conditions on a grid_cols x grid_rows lattice over the bbox,
/// fetched as a single multi-location Open-Meteo request.
async fn fetch_grid(http: &reqwest::Client, cfg: &Config) -> Result<Value> {
    let [west, south, east, north] = cfg.bbox;
    let (cols, rows) = (cfg.grid_cols, cfg.grid_rows);
    let mut lats = Vec::with_capacity(cols * rows);
    let mut lons = Vec::with_capacity(cols * rows);
    for r in 0..rows {
        for c in 0..cols {
            lats.push(format!(
                "{:.3}",
                south + (north - south) * ((r as f64 + 0.5) / rows as f64)
            ));
            lons.push(format!(
                "{:.3}",
                west + (east - west) * ((c as f64 + 0.5) / cols as f64)
            ));
        }
    }
    info!(
        "fetching Open-Meteo grid: {cols}x{rows} points over {:?}",
        cfg.bbox
    );
    let started = Instant::now();
    let body: Value = http
        .get(open_meteo_url(&lats, &lons))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
        .context("Open-Meteo response was not JSON")?;
    let cells = open_meteo_cells(body)?;
    let features = cells
        .iter()
        .map(|c| cell_feature(c, None))
        .collect::<Result<Vec<_>>>()?;
    info!(
        "Open-Meteo grid: {} cells fetched in {:.1?}",
        features.len(),
        started.elapsed()
    );
    Ok(serde_json::to_value(Snapshot::new(now_ms(), features))?)
}

/// Current conditions on a whole-planet lattice (global_step degrees apart,
/// poles trimmed for mercator), batched into URL-sized Open-Meteo requests.
async fn fetch_global_grid(http: &reqwest::Client, cfg: &Config) -> Result<Value> {
    let step = cfg.global_step;
    let mut points = Vec::new(); // (lat, lon, col, row)
    let mut lat = -78.0;
    let mut row = 0usize;
    while lat <= 78.0 {
        let mut lon = -177.0;
        let mut col = 0usize;
        while lon <= 177.0 {
            points.push((lat, lon, col, row));
            lon += step;
            col += 1;
        }
        lat += step;
        row += 1;
    }

    // Open-Meteo counts every location as one API call (free tier: 600/min,
    // 10k/day). 140-point batches 15s apart stay near 560/min, and the
    // schedules (regional 30 min, global 6 h) keep the day under ~9k calls.
    const BATCH: usize = 140;
    const BATCH_GAP: Duration = Duration::from_secs(15);
    let batches = points.len().div_ceil(BATCH);
    info!(
        "fetching Open-Meteo global lattice: {} points at {step}° in {batches} paced batches (~{}s)",
        points.len(),
        (batches as u64 - 1) * BATCH_GAP.as_secs()
    );
    let started = Instant::now();
    let mut features = Vec::with_capacity(points.len());
    for (b, chunk) in points.chunks(BATCH).enumerate() {
        if b > 0 {
            tokio::time::sleep(BATCH_GAP).await;
        }
        let lats: Vec<String> = chunk.iter().map(|p| format!("{:.1}", p.0)).collect();
        let lons: Vec<String> = chunk.iter().map(|p| format!("{:.1}", p.1)).collect();
        let mut attempt = 0;
        let body: Value = loop {
            attempt += 1;
            let resp = http.get(open_meteo_url(&lats, &lons)).send().await?;
            if resp.status().as_u16() == 429 && attempt <= 2 {
                warn!(
                    "Open-Meteo 429 on batch {}/{batches}, backing off 70s",
                    b + 1
                );
                tokio::time::sleep(Duration::from_secs(70)).await;
                continue;
            }
            break resp.error_for_status()?.json().await.with_context(|| {
                format!("Open-Meteo global batch {}/{batches} was not JSON", b + 1)
            })?;
        };
        let cells = open_meteo_cells(body)?;
        ensure!(
            cells.len() == chunk.len(),
            "Open-Meteo returned {} cells for {} points in batch {}/{batches}",
            cells.len(),
            chunk.len(),
            b + 1
        );
        for (cell, (_, _, col, row)) in cells.iter().zip(chunk) {
            features.push(cell_feature(cell, Some((*col, *row)))?);
        }
        info!("global batch {}/{batches}: {} cells", b + 1, cells.len());
    }
    info!(
        "Open-Meteo global lattice: {} cells fetched in {:.1?}",
        features.len(),
        started.elapsed()
    );
    Ok(serde_json::to_value(Snapshot::new(now_ms(), features))?)
}

#[derive(Clone)]
enum Sink {
    S3(s3::S3Writer),
    Local { dir: PathBuf },
}

impl Sink {
    async fn publish(&self, name: &str, body: &Value, max_age: u32) -> Result<()> {
        let bytes = serde_json::to_vec(body)?;
        let len = bytes.len();
        match self {
            Sink::S3(writer) => {
                let key = format!("weather/{name}");
                writer
                    .put(
                        &key,
                        bytes,
                        "application/json",
                        &format!("public, max-age={max_age}"),
                    )
                    .await?;
                info!("published s3://{}/{key} ({len} bytes)", writer.bucket);
            }
            Sink::Local { dir } => {
                std::fs::create_dir_all(dir)?;
                let path = dir.join(name);
                std::fs::write(&path, &bytes)?;
                info!("wrote {} ({len} bytes)", path.display());
            }
        }
        Ok(())
    }
}

async fn run_job(job: &str, cfg: &Config, http: &reqwest::Client, sink: &Sink) -> Result<Value> {
    let mut done = Vec::new();
    if matches!(job, "alerts" | "all") {
        let alerts = fetch_alerts(http, cfg).await?;
        sink.publish("alerts.json", &alerts, 60).await?;
        done.push("alerts");
    }
    if matches!(job, "grid" | "all") {
        let grid = fetch_grid(http, cfg).await?;
        sink.publish("grid.json", &grid, 300).await?;
        done.push("grid");
    }
    if matches!(job, "global" | "all") {
        let global = fetch_global_grid(http, cfg).await?;
        sink.publish("global.json", &global, 3600).await?;
        done.push("global");
    }
    if done.is_empty() {
        bail!("unknown job '{job}' (expected alerts | grid | global | all)");
    }
    Ok(json!({ "ok": true, "jobs": done }))
}

#[tokio::main]
async fn main() -> Result<(), lambda_runtime::Error> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let cfg = Config::from_env()?;
    // NWS requires an identifying User-Agent with a contact in it.
    let contact = std::env::var("CONTACT")
        .unwrap_or_else(|_| "github.com/johncarmack1984/stormdeck".to_string());
    let http = reqwest::Client::builder()
        .user_agent(format!("stormdeck/0.1 ({contact})"))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(anyhow::Error::from)?;

    if std::env::var("AWS_LAMBDA_RUNTIME_API").is_ok() {
        let sink = Sink::S3(s3::S3Writer::from_env(http.clone())?);
        lambda_runtime::run(lambda_runtime::service_fn(
            move |event: LambdaEvent<Value>| {
                let (cfg, http, sink) = (cfg.clone(), http.clone(), sink.clone());
                async move {
                    let job = event
                        .payload
                        .get("job")
                        .and_then(Value::as_str)
                        .unwrap_or("all")
                        .to_string();
                    run_job(&job, &cfg, &http, &sink)
                        .await
                        .map_err(lambda_runtime::Error::from)
                }
            },
        ))
        .await
    } else {
        let job = std::env::args().nth(1).unwrap_or_else(|| "all".to_string());
        let dir = std::env::var("LOCAL_OUT").unwrap_or_else(|_| "web/public/weather".to_string());
        let sink = Sink::Local {
            dir: PathBuf::from(dir),
        };
        run_job(&job, &cfg, &http, &sink).await?;
        Ok(())
    }
}
