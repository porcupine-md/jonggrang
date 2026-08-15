'use strict';

// S3-compatible object storage for file uploads (plan mode + design studio).
// Works with any S3 API: Cloudflare R2, MinIO, AWS S3, or a custom provider —
// the only difference is the endpoint (+ region/path-style). Config + secrets
// live in ~/.jonggrang/web/storage.json (user home, never the repo, never git).
// Uploads return a shareable link: a public URL when `publicUrl` is set, else a
// presigned GET URL (works even for private buckets like a default R2 bucket).

const fs = require('fs');
const path = require('path');
const os = require('os');

function configFile() {
  return path.join(os.homedir(), '.jonggrang', 'web', 'storage.json');
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; }
}

// Patch semantics mirror git-tokens: undefined = leave as-is; '' = clear.
function saveConfig(patch) {
  const next = { ...loadConfig() };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    if (v === '') delete next[k];
    else next[k] = v;
  }
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2));
  return next;
}

function isConfigured() {
  const c = loadConfig();
  return Boolean(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey);
}

// Non-secret view for the Settings UI — never leaks the keys, only whether set.
function publicConfig() {
  const c = loadConfig();
  return {
    provider: c.provider || 'none',            // 'r2' | 'minio' | 'custom' | 'none'
    endpoint: c.endpoint || '',
    bucket: c.bucket || '',
    region: c.region || 'auto',
    publicUrl: c.publicUrl || '',
    forcePathStyle: c.forcePathStyle !== false, // default true (MinIO/custom-safe; R2 ok too)
    has_access_key: !!c.accessKeyId,
    has_secret_key: !!c.secretAccessKey,
    configured: isConfigured(),
  };
}

function client() {
  const c = loadConfig();
  if (!isConfigured()) throw new Error('storage is not configured');
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: c.region || 'auto',
    endpoint: c.endpoint,
    forcePathStyle: c.forcePathStyle !== false,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  });
}

function sanitizeName(name) {
  return String(name || 'file').replace(/[^\w.\-]+/g, '_').replace(/^_+/, '').slice(-120) || 'file';
}

// Upload a buffer and return { key, url, filename }. url is a public URL when a
// publicUrl base is configured, otherwise a 7-day presigned GET URL.
async function upload(buffer, filename, contentType) {
  const c = loadConfig();
  if (!isConfigured()) throw new Error('storage is not configured');
  const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const safe = sanitizeName(filename);
  const stamp = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 10);
  const key = `uploads/${stamp}/${rand}-${safe}`;
  const s3 = client();
  await s3.send(new PutObjectCommand({
    Bucket: c.bucket, Key: key, Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
  let url;
  if (c.publicUrl) {
    url = `${String(c.publicUrl).replace(/\/+$/, '')}/${key}`;
  } else {
    url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: c.bucket, Key: key }), { expiresIn: 60 * 60 * 24 * 7 });
  }
  return { key, url, filename: safe };
}

// Cheap connectivity check for the Settings "Test" button.
async function testConnection() {
  const c = loadConfig();
  const { HeadBucketCommand } = require('@aws-sdk/client-s3');
  await client().send(new HeadBucketCommand({ Bucket: c.bucket }));
  return true;
}

module.exports = { configFile, loadConfig, saveConfig, isConfigured, publicConfig, upload, testConnection };
