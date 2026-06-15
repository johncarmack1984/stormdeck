// SES inbound -> iCloud forwarder. The SES receipt rule stores the raw message
// in S3 (ordered before this Lambda action); we read it, rewrite the few
// headers SES requires, and re-send via SES to the address in SSM.
//
// SES will only send "From" a domain we own, so From becomes MAIL_FROM (showing
// the original sender's display name), the original sender goes to Reply-To, and
// To becomes the forwarding destination. The body is left byte-for-byte intact.
//
// The destination address lives ONLY in SSM (SecureString), read at runtime —
// never in this repo or the CloudFormation template.
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendRawEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const s3 = new S3Client({});
const ses = new SESClient({});
const ssm = new SSMClient({});

const { BUCKET, PREFIX = '', FORWARD_TO_PARAM, MAIL_FROM } = process.env;

let forwardTo;
async function destination() {
  if (!forwardTo) {
    const r = await ssm.send(
      new GetParameterCommand({ Name: FORWARD_TO_PARAM, WithDecryption: true }),
    );
    forwardTo = r.Parameter.Value.trim();
  }
  return forwardTo;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export const handler = async (event) => {
  const dest = await destination();
  for (const record of event.Records ?? []) {
    const mail = record.ses?.mail;
    if (!mail) continue;
    const Key = `${PREFIX}${mail.messageId}`;
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key }));
    const raw = await streamToBuffer(obj.Body);
    const rewritten = rewrite(raw, mail, dest);
    await ses.send(
      new SendRawEmailCommand({ Destinations: [dest], RawMessage: { Data: rewritten } }),
    );
    console.log(
      `forwarded ${mail.messageId} "${mail.commonHeaders?.subject ?? ''}" -> ${dest}`,
    );
  }
  return { disposition: 'STOP_RULE' };
};

// 'binary' (latin1) keeps every byte of the body untouched; we only edit headers.
function rewrite(raw, mail, dest) {
  const text = raw.toString('binary');
  const m = text.match(/\r?\n\r?\n/);
  const at = m ? m.index : text.length;
  const headerRegion = text.slice(0, at);
  const body = m ? text.slice(at + m[0].length) : '';

  const origFrom = mail.commonHeaders?.from?.[0] ?? 'unknown sender';

  const lines = headerRegion.split(/\r?\n/);
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) line += `\r\n${lines[++i]}`;
    // Drop headers that conflict with re-sending; we re-add From/To/Reply-To.
    if (/^(from|to|cc|bcc|return-path|sender|reply-to|message-id|dkim-signature):/i.test(line))
      continue;
    headers.push(line);
  }
  headers.unshift(`Reply-To: ${origFrom}`);
  headers.unshift(`To: ${dest}`);
  headers.unshift(`From: ${displayName(origFrom)} <${MAIL_FROM}>`);

  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'binary');
}

// "Name <addr>" -> RFC2047-encoded "Name"; bare addr -> the addr.
function displayName(from) {
  const lt = from.indexOf('<');
  const name = (lt > 0 ? from.slice(0, lt) : from).trim().replace(/^"|"$/g, '');
  if (/^[\x20-\x7e]*$/.test(name) && !/["\\]/.test(name)) return `"${name}"`;
  return `=?UTF-8?B?${Buffer.from(name, 'utf8').toString('base64')}?=`;
}
