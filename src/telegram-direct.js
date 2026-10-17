import { convertFromTelethonSession } from '@mtcute/convert';
import { MemoryStorage, TelegramClient } from '@mtcute/web';
import { initializeUpdateManager } from './update-manager.js';

const MANIFEST_PREFIX = 'STOREBASE_MANIFEST_V1\n';
const ARTIFACT_PREFIX = 'STOREBASE_ARTIFACT_V1 ';
const MAX_RELEASES = 5000;

let clientPromise;
let channelName;
let settingsSource;
let cachedReleases = [];

function nativeCall(method, options = {}) {
  const capacitor = window.Capacitor;
  if (!capacitor || typeof capacitor.nativePromise !== 'function') {
    throw new Error('Native StoreBase bridge is unavailable.');
  }
  return capacitor.nativePromise('SecureCatalog', method, options);
}

function safeMessageId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid release message identifier.');
  return id;
}

function validateManifest(manifest, messageId) {
  if (!manifest || manifest.format !== 'storebase.app-release' || manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported release manifest ${messageId}.`);
  }
  if (typeof manifest.appId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.appId)
      || typeof manifest.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(manifest.version)) {
    throw new Error(`Invalid app identity in release manifest ${messageId}.`);
  }
  if (!manifest.app || typeof manifest.app.name !== 'string' || !manifest.artifacts
      || typeof manifest.publishedAt !== 'string' || Number.isNaN(Date.parse(manifest.publishedAt))) {
    throw new Error(`Incomplete release manifest ${messageId}.`);
  }
  for (const kind of ['apk', 'avatar']) {
    const artifact = manifest.artifacts[kind];
    if (!artifact || !Number.isSafeInteger(Number(artifact.size)) || Number(artifact.size) <= 0
        || !/^[a-f\d]{64}$/i.test(artifact.sha256 || '') || !artifact.fileName
        || typeof artifact.mimeType !== 'string') {
      throw new Error(`Invalid ${kind} metadata in release manifest ${messageId}.`);
    }
    artifact.messageId = safeMessageId(artifact.messageId);
    artifact.size = Number(artifact.size);
  }
  const androidUpdate = manifest.androidUpdate;
  if (androidUpdate !== undefined && (manifest.appId !== 'storebase'
      || androidUpdate?.packageName !== 'com.nexuss0781.storebase'
      || !Number.isSafeInteger(androidUpdate.versionCode) || androidUpdate.versionCode <= 0
      || androidUpdate.versionCode > 2147483647
      || !Number.isSafeInteger(androidUpdate.minimumVersionCode) || androidUpdate.minimumVersionCode < 0
      || androidUpdate.minimumVersionCode > androidUpdate.versionCode)) {
    throw new Error(`Invalid Android update metadata in release manifest ${messageId}.`);
  }
  if (manifest.artifacts.delta !== undefined) {
    const delta = manifest.artifacts.delta;
    if (!androidUpdate || !Number.isSafeInteger(Number(delta.messageId)) || Number(delta.messageId) <= 0
        || !Number.isSafeInteger(Number(delta.size)) || Number(delta.size) <= 0
        || !/^[a-f\d]{64}$/i.test(delta.sha256 || '') || !delta.fileName
        || typeof delta.mimeType !== 'string' || !Number.isSafeInteger(Number(delta.fromVersionCode))
        || Number(delta.fromVersionCode) <= 0 || Number(delta.fromVersionCode) >= androidUpdate.versionCode) {
      throw new Error(`Invalid delta metadata in release manifest ${messageId}.`);
    }
    delta.messageId = safeMessageId(delta.messageId);
    delta.size = Number(delta.size);
    delta.fromVersionCode = Number(delta.fromVersionCode);
  }
}

export function parseManifestMessage(message) {
  const text = typeof message?.text === 'string' ? message.text : '';
  if (!text.startsWith(MANIFEST_PREFIX)) return null;
  const messageId = safeMessageId(message.id);
  const manifest = JSON.parse(text.slice(MANIFEST_PREFIX.length));
  validateManifest(manifest, messageId);
  return { manifest, messageId };
}

function publicArtifact(artifact) {
  const result = {
    fileName: artifact.fileName,
    mimeType: artifact.mimeType,
    size: artifact.size,
    sha256: artifact.sha256.toLowerCase(),
    messageId: artifact.messageId,
  };
  if (artifact.fromVersionCode !== undefined) result.fromVersionCode = artifact.fromVersionCode;
  return result;
}

export function buildCatalog(releases) {
  const sorted = [...releases].sort((a, b) => Date.parse(b.manifest.publishedAt) - Date.parse(a.manifest.publishedAt)
    || b.messageId - a.messageId);
  const byId = new Map();
  for (const release of sorted) {
    const manifest = release.manifest;
    let app = byId.get(manifest.appId);
    if (!app) {
      app = {
        id: manifest.appId,
        name: manifest.app.name,
        category: typeof manifest.app.category === 'string' ? manifest.app.category : '',
        description: typeof manifest.app.description === 'string' ? manifest.app.description : '',
        version: manifest.version,
        publishedAt: manifest.publishedAt,
        signingCertificateSha256: manifest.signingCertificateSha256 || null,
        androidUpdate: manifest.androidUpdate || null,
        artifacts: {
          apk: publicArtifact(manifest.artifacts.apk),
          avatar: publicArtifact(manifest.artifacts.avatar),
          ...(manifest.artifacts.delta ? { delta: publicArtifact(manifest.artifacts.delta) } : {}),
        },
        versions: [],
      };
      byId.set(manifest.appId, app);
    }
    app.versions.push({
      version: manifest.version,
      publishedAt: manifest.publishedAt,
      messageId: release.messageId,
      signingCertificateSha256: manifest.signingCertificateSha256 || null,
      androidUpdate: manifest.androidUpdate || null,
      artifacts: {
        apk: publicArtifact(manifest.artifacts.apk),
        avatar: publicArtifact(manifest.artifacts.avatar),
        ...(manifest.artifacts.delta ? { delta: publicArtifact(manifest.artifacts.delta) } : {}),
      },
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    apps: [...byId.values()],
  };
}

function findRelease(appId, version) {
  for (const release of cachedReleases) {
    if (release.manifest.appId === appId && (!version || release.manifest.version === version)) return release;
  }
  throw new Error('The requested app version is not available in the Telegram catalog.');
}

async function getRelease(appId, version) {
  if (!cachedReleases.length) await refreshCatalog();
  return findRelease(appId, version);
}

function toBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

async function initializeClient() {
  const bootstrap = await nativeCall('getTelegramSettings');
  const telegram = bootstrap?.settings?.telegram;
  if (!telegram || !Number.isSafeInteger(telegram.apiId) || typeof telegram.apiHash !== 'string'
      || typeof telegram.readSession !== 'string' || typeof telegram.channel !== 'string') {
    throw new Error('Telegram reader settings are invalid.');
  }
  channelName = telegram.channel;
  settingsSource = bootstrap.source || 'native';

  // Keep the converted authorization only in this process. IndexedDB/localStorage are not used.
  const client = new TelegramClient({
    apiId: telegram.apiId,
    apiHash: telegram.apiHash,
    storage: new MemoryStorage(),
  });
  const convertedSession = convertFromTelethonSession(telegram.readSession);
  await client.importSession(convertedSession);
  await client.connect();
  const account = await client.getMe();
  if (!account || account.isBot) throw new Error('A Telegram reader user session is required.');
  return client;
}

function getClient() {
  if (!clientPromise) clientPromise = initializeClient();
  return clientPromise;
}

async function refreshCatalog() {
  const client = await getClient();
  const releases = [];
  for await (const message of client.iterSearchMessages({
    query: 'STOREBASE_MANIFEST_V1',
    chatId: channelName,
    limit: MAX_RELEASES,
    chunkSize: 100,
  })) {
    const release = parseManifestMessage(message);
    if (release) releases.push(release);
  }
  cachedReleases = releases.sort((a, b) => Date.parse(b.manifest.publishedAt) - Date.parse(a.manifest.publishedAt)
    || b.messageId - a.messageId);
  const catalog = buildCatalog(cachedReleases);
  window.storeBaseCatalog = catalog;
  window.dispatchEvent(new CustomEvent('storebase:catalog-ready', {
    detail: { catalog, source: 'telegram' },
  }));
  return catalog;
}

async function downloadArtifact(appId, version, kind = 'apk', options = {}) {
  if (!['apk', 'avatar', 'delta'].includes(kind)) throw new Error('Unsupported Telegram artifact type.');
  const client = await getClient();
  if (!cachedReleases.length) await refreshCatalog();
  const release = findRelease(appId, version);
  const manifest = release.manifest;
  const artifact = manifest.artifacts[kind];
  if (!artifact) throw new Error(`The Telegram release has no ${kind} artifact.`);
  const [message] = await client.getMessages(channelName, [artifact.messageId]);
  if (!message?.media) throw new Error('The Telegram artifact message is unavailable.');

  const caption = typeof message.text === 'string' ? message.text : '';
  if (!caption.startsWith(ARTIFACT_PREFIX)) throw new Error('Telegram artifact metadata does not match the release.');
  const artifactTag = JSON.parse(caption.slice(ARTIFACT_PREFIX.length));
  if (artifactTag.appId !== manifest.appId || artifactTag.version !== manifest.version
      || artifactTag.kind !== kind || String(artifactTag.sha256).toLowerCase() !== artifact.sha256.toLowerCase()
      || (kind === 'delta' && Number(artifactTag.fromVersionCode) !== artifact.fromVersionCode)) {
    throw new Error('Telegram artifact integrity metadata does not match the release.');
  }

  const fileName = `${manifest.appId}-${manifest.version}-${kind}-${artifact.sha256.slice(0, 12)}-${artifact.fileName}`
    .replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180);
  const started = await nativeCall('createDirectDownload', {
    fileName,
    mimeType: artifact.mimeType,
    expectedSize: artifact.size,
    expectedSha256: artifact.sha256,
    storage: options.storage === 'updates' ? 'updates' : 'downloads',
  });
  const handle = started?.handle;
  if (!handle) throw new Error('Native download storage could not be created.');

  let received = 0;
  let completed = false;
  try {
    const abortSignal = options.signal;
    for await (const chunk of client.downloadAsIterable(message.media, {
      fileSize: artifact.size,
      partSize: 256,
      abortSignal,
    })) {
      if (abortSignal?.aborted) throw new DOMException('Download cancelled.', 'AbortError');
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (received + bytes.byteLength > artifact.size) throw new Error('Telegram artifact is larger than its manifest.');
      await nativeCall('appendDirectDownload', { handle, chunkBase64: toBase64(bytes) });
      received += bytes.byteLength;
      window.dispatchEvent(new CustomEvent('storebase:telegram-download-progress', {
        detail: { appId, version: manifest.version, kind, received, total: artifact.size },
      }));
    }
    if (received !== artifact.size) throw new Error('Telegram artifact size does not match its manifest.');
    const result = await nativeCall('finishDirectDownload', { handle });
    completed = true;
    return result;
  } finally {
    if (!completed) {
      try { await nativeCall('abortDirectDownload', { handle }); } catch { /* best-effort cleanup */ }
    }
  }
}

async function disconnect() {
  if (!clientPromise) return;
  try {
    const client = await clientPromise;
    await client.disconnect();
  } catch {
    // The app is closing; no user-facing technical message is needed.
  }
  clientPromise = undefined;
}

const isAndroidApp = typeof window !== 'undefined' && Boolean(window.Capacitor?.nativePromise);
if (isAndroidApp) {
  window.storeBaseTelegram = Object.freeze({
    refreshCatalog,
    getRelease,
    downloadArtifact,
    disconnect,
    get settingsSource() { return settingsSource; },
  });
  window.storeBaseTelegramReady = refreshCatalog().catch(() => {
    window.storeBaseTelegramStatus = 'unavailable';
    return null;
  });
  initializeUpdateManager((method, options = {}) => window.Capacitor.nativePromise('StoreBaseUpdate', method, options));
  window.addEventListener('pagehide', () => { void disconnect(); }, { once: true });
}
