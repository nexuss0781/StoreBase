'use strict';

const {
  createCipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  constants,
  verify,
} = require('node:crypto');

const PROTOCOL = 'STOREBASE_GATEWAY_V1';
const APP_ID = 'com.nexuss0781.storebase';
const TELEGRAM_BOOTSTRAP_PATH = '/api/v1/catalog/bootstrap';
const LEGACY_TELEGRAM_BOOTSTRAP_PATH = '/api/v1/telegram/bootstrap';
const PUBLISHER_BOOTSTRAP_PATH = '/api/v1/publisher/bootstrap';
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_PUBLIC_KEY_BYTES = 12 * 1024;
const MAX_SIGNATURE_BYTES = 4 * 1024;

function canonicalRequest({ appId, requestId, timestamp, publicKey, publishToken, path = TELEGRAM_BOOTSTRAP_PATH }) {
  const fields = [PROTOCOL, 'POST', path, appId, requestId, String(timestamp), publicKey];
  if (path === PUBLISHER_BOOTSTRAP_PATH) fields.push(publishToken || '');
  return fields.join('\n');
}

function envelopeAad({ appId = APP_ID, requestId, issuedAt }) {
  return [PROTOCOL, appId, requestId, issuedAt].join('\n');
}

function decodeBase64(value, label, maxBytes) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes * 4 / 3) + 8) {
    throw new Error(`Invalid ${label}.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length || decoded.length > maxBytes || decoded.toString('base64') !== value) {
    throw new Error(`Invalid ${label}.`);
  }
  return decoded;
}

function authenticateRequest(body, now = Date.now(), appId = APP_ID, expectedPath = TELEGRAM_BOOTSTRAP_PATH) {
  if (!body || body.appId !== appId) throw new Error('Invalid app identity.');
  if (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) {
    throw new Error('Invalid request ID.');
  }
  if (!Number.isSafeInteger(body.timestamp) || Math.abs(now - body.timestamp) > MAX_CLOCK_SKEW_MS) {
    throw new Error('Request timestamp is expired.');
  }
  const publicKeyDer = decodeBase64(body.publicKey, 'public key', MAX_PUBLIC_KEY_BYTES);
  const signature = decodeBase64(body.signature, 'signature', MAX_SIGNATURE_BYTES);
  let publicKey;
  try {
    publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
  } catch {
    throw new Error('Invalid public key.');
  }
  const details = publicKey.asymmetricKeyDetails || {};
  if (publicKey.asymmetricKeyType !== 'rsa' || (details.modulusLength || 0) < 2048) {
    throw new Error('Unsupported public key.');
  }
  const valid = verify(
    'RSA-SHA256',
    Buffer.from(canonicalRequest({ ...body, appId, path: expectedPath }), 'utf8'),
    publicKey,
    signature,
  );
  if (!valid) throw new Error('Request signature is invalid.');
  return { publicKey, publicKeyDer, requestId: body.requestId, timestamp: body.timestamp };
}

function createEncryptedEnvelope(payload, recipient, options = {}) {
  const appId = options.appId || APP_ID;
  const requestId = recipient.requestId;
  const issuedAt = options.issuedAt || new Date().toISOString();
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  if (plaintext.length > (options.maxPayloadBytes || 2 * 1024 * 1024)) {
    throw new Error('Response exceeds the configured size limit.');
  }
  const contentKey = randomBytes(32);
  const iv = randomBytes(12);
  const aad = envelopeAad({ appId, requestId, issuedAt });
  const cipher = createCipheriv('aes-256-gcm', contentKey, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encryptedKey = publicEncrypt({
    key: recipient.publicKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, contentKey);
  contentKey.fill(0);
  return {
    protocol: PROTOCOL,
    appId,
    requestId,
    issuedAt,
    keyWrap: 'RSA-OAEP-SHA256',
    contentEncryption: 'AES-256-GCM',
    encryptedKey: encryptedKey.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function publicKeyFingerprint(publicKeyDer) {
  return createHash('sha256').update(publicKeyDer).digest('hex');
}

module.exports = {
  APP_ID,
  LEGACY_TELEGRAM_BOOTSTRAP_PATH,
  TELEGRAM_BOOTSTRAP_PATH,
  PUBLISHER_BOOTSTRAP_PATH,
  MAX_CLOCK_SKEW_MS,
  PROTOCOL,
  authenticateRequest,
  canonicalRequest,
  createEncryptedEnvelope,
  envelopeAad,
  publicKeyFingerprint,
};
