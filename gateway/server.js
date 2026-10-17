'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {
  APP_ID,
  LEGACY_TELEGRAM_BOOTSTRAP_PATH,
  PUBLISHER_BOOTSTRAP_PATH,
  TELEGRAM_BOOTSTRAP_PATH,
  authenticateRequest,
  createEncryptedEnvelope,
  publicKeyFingerprint,
} = require('./protocol');

const WEB_ROOT = path.resolve(__dirname, '..', 'www');
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};
const BODY_LIMIT_BYTES = 32 * 1024;
const MAX_REPLAY_ENTRIES = 50_000;
const MAX_RATE_IDENTITIES = 10_000;
const PUBLISHER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

function loadTelegramSettings(env = process.env) {
  const { readTelegramReaderConfig } = require('../cli/lib/telegram-client');
  const config = readTelegramReaderConfig(env);
  return {
    schemaVersion: 1,
    settingsVersion: 1,
    telegram: {
      apiId: config.apiId,
      apiHash: config.apiHash,
      readSession: config.readSession,
      channel: config.channel,
    },
  };
}

function loadPublisherSettings(env = process.env) {
  const { readTelegramConfig } = require('../cli/lib/telegram-client');
  const config = readTelegramConfig(env);
  if (!config.session) throw new Error('A stored Telegram bot session is required for publisher bootstrap.');
  return {
    schemaVersion: 1,
    settingsVersion: 1,
    telegram: {
      apiId: config.apiId,
      apiHash: config.apiHash,
      botSession: config.session,
      readSession: config.readSession,
      channel: config.channel,
    },
  };
}

function tokensMatch(supplied, expected) {
  if (typeof supplied !== 'string' || !PUBLISHER_TOKEN_PATTERN.test(supplied)
      || typeof expected !== 'string' || !PUBLISHER_TOKEN_PATTERN.test(expected)) return false;
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return suppliedBytes.length === expectedBytes.length
    && require('node:crypto').timingSafeEqual(suppliedBytes, expectedBytes);
}

async function readJsonBody(request) {
  const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw Object.assign(new Error('JSON required.'), { statusCode: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) throw Object.assign(new Error('Request too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), { statusCode: 400 });
  }
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function createGatewayServer(options = {}) {
  const appId = options.appId || APP_ID;
  const webRoot = path.resolve(options.webRoot || WEB_ROOT);
  const settingsLoader = options.settingsLoader || loadTelegramSettings;
  const publisherSettingsLoader = options.publisherSettingsLoader || loadPublisherSettings;
  const publisherToken = options.publisherToken ?? process.env.STOREBASE_GATEWAY_PUBLISH_TOKEN;
  const now = options.now || Date.now;
  const replayed = new Map();
  const rate = new Map();
  let cachedSettings;
  let settingsLoad;
  let cachedPublisherSettings;
  let publisherSettingsLoad;
  let requestCount = 0;

  async function getSettings() {
    if (!cachedSettings && !settingsLoad) {
      settingsLoad = Promise.resolve().then(settingsLoader).then((settings) => {
        if (!settings || settings.schemaVersion !== 1 || settings.settingsVersion !== 1
            || !settings.telegram || !Number.isSafeInteger(settings.telegram.apiId)
            || typeof settings.telegram.apiHash !== 'string'
            || typeof settings.telegram.readSession !== 'string'
            || typeof settings.telegram.channel !== 'string') {
          throw new Error('Telegram settings provider returned an invalid result.');
        }
        cachedSettings = settings;
        return settings;
      }).finally(() => { settingsLoad = undefined; });
    }
    return cachedSettings || settingsLoad;
  }

  async function getPublisherSettings() {
    if (!cachedPublisherSettings && !publisherSettingsLoad) {
      publisherSettingsLoad = Promise.resolve().then(publisherSettingsLoader).then((settings) => {
        if (!settings || settings.schemaVersion !== 1 || settings.settingsVersion !== 1
            || !settings.telegram || !Number.isSafeInteger(settings.telegram.apiId)
            || typeof settings.telegram.apiHash !== 'string'
            || typeof settings.telegram.botSession !== 'string'
            || typeof settings.telegram.readSession !== 'string'
            || typeof settings.telegram.channel !== 'string') {
          throw new Error('Telegram publisher settings provider returned an invalid result.');
        }
        cachedPublisherSettings = settings;
        return settings;
      }).finally(() => { publisherSettingsLoad = undefined; });
    }
    return cachedPublisherSettings || publisherSettingsLoad;
  }

  async function serveStatic(request, response, pathname) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'Method not allowed.' });
      return;
    }
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch {
      sendJson(response, 400, { error: 'Invalid path.' });
      return;
    }
    if (decoded.includes('\0') || decoded.split('/').some((part) => part.startsWith('.'))) {
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const filePath = path.resolve(webRoot, relative);
    if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${path.sep}`)) {
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }
    let stats;
    try { stats = await fs.promises.stat(filePath); } catch {
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }
    if (!stats.isFile()) {
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(filePath).pipe(response);
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Frame-Options', 'DENY');
    let pathname;
    try { pathname = new URL(request.url, 'http://gateway.local').pathname; } catch {
      sendJson(response, 400, { error: 'Invalid request.' });
      return;
    }
    if (pathname === '/api/v1/health') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
      return sendJson(response, 200, { ok: true });
    }
    const publisherBootstrap = pathname === PUBLISHER_BOOTSTRAP_PATH;
    const catalogBootstrap = pathname === TELEGRAM_BOOTSTRAP_PATH || pathname === LEGACY_TELEGRAM_BOOTSTRAP_PATH;
    if (!catalogBootstrap && !publisherBootstrap) return serveStatic(request, response, pathname);
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });

    try {
      const body = await readJsonBody(request);
      const identity = authenticateRequest(body, now(), appId, pathname);
      if (publisherBootstrap && (typeof publisherToken !== 'string' || !PUBLISHER_TOKEN_PATTERN.test(publisherToken))) {
        throw Object.assign(new Error('Publisher access is not configured.'), { statusCode: 503 });
      }
      if (publisherBootstrap && !tokensMatch(body.publishToken, publisherToken)) {
        throw Object.assign(new Error('Publisher request is unauthorized.'), { statusCode: 401 });
      }
      const fingerprint = publicKeyFingerprint(identity.publicKeyDer);
      const currentTime = now();
      for (const [id, expiry] of replayed) if (expiry <= currentTime) replayed.delete(id);
      const replayKey = `${fingerprint}:${identity.requestId}`;
      if (replayed.has(replayKey)) return sendJson(response, 409, { error: 'Request already used.' });
      if (replayed.size >= MAX_REPLAY_ENTRIES) return sendJson(response, 503, { error: 'Settings temporarily unavailable.' });
      replayed.set(replayKey, currentTime + 5 * 60 * 1000);

      const windowStart = Math.floor(currentTime / 60_000) * 60_000;
      let entry = rate.get(fingerprint);
      if (!entry || entry.windowStart !== windowStart) entry = { windowStart, count: 0 };
      entry.count += 1;
      if (!rate.has(fingerprint) && rate.size >= MAX_RATE_IDENTITIES) rate.delete(rate.keys().next().value);
      rate.set(fingerprint, entry);
      if (entry.count > (options.requestsPerMinute ?? 30)) {
        return sendJson(response, 429, { error: 'Too many requests.' });
      }
      requestCount += 1;
      if (requestCount % 256 === 0) {
        for (const [key, value] of rate) if (value.windowStart + 60_000 <= currentTime) rate.delete(key);
      }

      const payload = publisherBootstrap ? await getPublisherSettings() : await getSettings();
      const issuedAt = new Date(currentTime).toISOString();
      return sendJson(response, 200, createEncryptedEnvelope(payload, identity, { appId, issuedAt }));
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode
        : /signature|timestamp|identity|public key|request ID|unsupported/i.test(error?.message || '') ? 401
          : 503;
      if (statusCode === 503) return sendJson(response, 503, { error: 'Settings temporarily unavailable.' });
      return sendJson(response, statusCode, { error: statusCode === 401 ? 'Request could not be authenticated.' : 'Invalid request.' });
    }
  });

  return server;
}

if (require.main === module) {
  require('dotenv').config();
  const port = Number(process.env.PORT || 8080);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const host = '0.0.0.0';
  createGatewayServer().listen(port, host, () => {
    process.stdout.write(`StoreBase gateway listening on ${host}:${port}\n`);
  });
}

module.exports = {
  BODY_LIMIT_BYTES,
  createGatewayServer,
  loadPublisherSettings,
  loadTelegramSettings,
};
