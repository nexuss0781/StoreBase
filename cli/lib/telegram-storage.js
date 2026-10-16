'use strict';

const { mkdir, rm, stat } = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MANIFEST_MARKER = 'STOREBASE_MANIFEST_V1';
const ARTIFACT_MARKER = 'STOREBASE_ARTIFACT_V1';
const MANIFEST_FORMAT = 'storebase.app-release';
const MANIFEST_SCHEMA_VERSION = 1;
const MANIFEST_MESSAGE_PREFIX = `${MANIFEST_MARKER}\n`;

function fail(message) {
  throw new Error(message);
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function safeMessageId(value, label = 'Telegram message ID') {
  const id = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) fail(`${label} is invalid.`);
  return id;
}

function parseManifestMessage(message) {
  const text = typeof message?.message === 'string' ? message.message : '';
  if (!text.startsWith(MANIFEST_MESSAGE_PREFIX)) return null;
  let manifest;
  try {
    manifest = JSON.parse(text.slice(MANIFEST_MESSAGE_PREFIX.length));
  } catch (error) {
    fail(`Manifest in Telegram message ${message.id} is invalid JSON: ${error.message}`);
  }
  validateManifest(manifest, message.id);
  return { manifest, messageId: safeMessageId(message.id) };
}

function validateManifest(manifest, messageId) {
  if (!manifest || manifest.format !== MANIFEST_FORMAT || manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(`Unsupported StoreBase manifest in Telegram message ${messageId}.`);
  }
  if (typeof manifest.appId !== 'string' || !manifest.appId || typeof manifest.version !== 'string' || !manifest.version) {
    fail(`Manifest in Telegram message ${messageId} is missing its app ID or version.`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.appId)
    || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(manifest.version)) {
    fail(`Manifest in Telegram message ${messageId} has an unsafe app ID or version.`);
  }
  if (!manifest.app || typeof manifest.app.name !== 'string' || !manifest.artifacts) {
    fail(`Manifest in Telegram message ${messageId} is missing app metadata or artifacts.`);
  }
  for (const kind of ['apk', 'avatar']) {
    const artifact = manifest.artifacts[kind];
    if (!artifact || !Number.isSafeInteger(Number(artifact.messageId)) || Number(artifact.messageId) <= 0
      || !/^[a-f\d]{64}$/i.test(artifact.sha256 || '') || !Number.isSafeInteger(Number(artifact.size)) || Number(artifact.size) <= 0) {
      fail(`Manifest in Telegram message ${messageId} has invalid ${kind} artifact metadata.`);
    }
  }
  if (typeof manifest.publishedAt !== 'string' || Number.isNaN(Date.parse(manifest.publishedAt))) {
    fail(`Manifest in Telegram message ${messageId} has an invalid publish timestamp.`);
  }
}

function equivalentRelease(a, b) {
  return a.format === b.format
    && a.schemaVersion === b.schemaVersion
    && a.appId === b.appId
    && a.version === b.version
    && JSON.stringify(a.app) === JSON.stringify(b.app)
    && a.signingCertificateSha256 === b.signingCertificateSha256
    && a.artifacts.apk.sha256 === b.artifacts.apk.sha256
    && a.artifacts.avatar.sha256 === b.artifacts.avatar.sha256;
}

async function getReleaseMessages(client, channel) {
  const releases = [];
  for await (const message of client.iterMessages(channel, { search: MANIFEST_MARKER })) {
    const release = parseManifestMessage(message);
    if (release) releases.push(release);
  }
  releases.sort((a, b) => Date.parse(b.manifest.publishedAt) - Date.parse(a.manifest.publishedAt)
    || b.messageId - a.messageId);
  return releases;
}

function selectRelease(releases, appId, version) {
  const matches = releases.filter(({ manifest }) => manifest.appId === appId
    && (!version || manifest.version === version));
  if (!matches.length) fail(`No Telegram release found for app "${appId}"${version ? ` version ${version}` : ''}.`);
  return matches[0];
}

function safeFileName(value) {
  const base = path.basename(String(value || 'artifact.bin'));
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  return cleaned || 'artifact.bin';
}

function createTelegramStorage(client, channel, options = {}) {
  if (!client || !channel) fail('A connected Telegram client and channel are required.');
  const writerClient = options.writerClient || client;
  const readerClient = options.readerClient || client;
  const writerChannel = options.writerChannel || channel;
  const readerChannel = options.readerChannel || channel;

  async function listReleases() {
    return getReleaseMessages(readerClient, readerChannel);
  }

  async function getMetadata(appId, version) {
    if (typeof appId !== 'string' || !appId.trim()) fail('App ID is required.');
    const releases = await getReleaseMessages(readerClient, readerChannel);
    return selectRelease(releases, appId.trim(), version);
  }

  async function publish(input, signingCertificateSha256) {
    const certificate = String(signingCertificateSha256 || '').replace(/[^a-f\d]/gi, '').toUpperCase();
    if (!/^[A-F\d]{64}$/.test(certificate)) fail('A verified 64-character SHA-256 signing certificate is required before release.');
    if (!input || !input.id || !input.name || !input.version || !input.apkPath || !input.avatarPath) {
      fail('Validated StoreBase app input is required before release.');
    }

    const [apkHash, avatarHash, apkDetails, avatarDetails] = await Promise.all([
      sha256File(input.apkPath), sha256File(input.avatarPath), stat(input.apkPath), stat(input.avatarPath),
    ]);
    const publishedAt = options.publishedAt || new Date().toISOString();
    const manifest = {
      format: MANIFEST_FORMAT,
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      appId: input.id,
      app: {
        name: input.name,
        category: input.category,
        description: input.description,
      },
      version: input.version,
      publishedAt,
      signingCertificateSha256: certificate,
      artifacts: {
        apk: {
          fileName: path.basename(input.apkPath),
          mimeType: 'application/vnd.android.package-archive',
          size: apkDetails.size,
          sha256: apkHash,
        },
        avatar: {
          fileName: path.basename(input.avatarPath),
          mimeType: input.avatarExtension === '.jpg' ? 'image/jpeg' : `image/${input.avatarExtension.slice(1)}`,
          size: avatarDetails.size,
          sha256: avatarHash,
        },
      },
    };
    const sizeCheckManifest = {
      ...manifest,
      artifacts: {
        apk: { ...manifest.artifacts.apk, messageId: Number.MAX_SAFE_INTEGER },
        avatar: { ...manifest.artifacts.avatar, messageId: Number.MAX_SAFE_INTEGER },
      },
    };
    if (`${MANIFEST_MESSAGE_PREFIX}${JSON.stringify(sizeCheckManifest, null, 2)}`.length > 4096) {
      fail('StoreBase manifest exceeds Telegram’s 4096-character message limit. Reduce the app metadata before publishing.');
    }

    const existingReleases = await getReleaseMessages(readerClient, readerChannel);
    const conflictingIdentity = existingReleases.find(({ manifest: item }) => item.appId === input.id && item.app.name !== input.name);
    if (conflictingIdentity) fail(`App ID "${input.id}" is already used by "${conflictingIdentity.manifest.app.name}".`);
    const prior = existingReleases.find(({ manifest: item }) => item.appId === input.id && item.version === input.version);
    if (prior) {
      if (equivalentRelease(prior.manifest, manifest)) {
        return { ...prior, idempotent: true };
      }
      fail(`App ${input.id} version ${input.version} already exists in Telegram and is immutable. Publish a new version instead.`);
    }

    // Telegram keeps each artifact as a durable channel document. The manifest is posted last,
    // so readers never treat a partial upload as a complete StoreBase release.
    const apkMessage = await writerClient.sendFile(writerChannel, {
      file: input.apkPath,
      forceDocument: true,
      parseMode: undefined,
      caption: `${ARTIFACT_MARKER} ${JSON.stringify({ appId: input.id, version: input.version, kind: 'apk', sha256: apkHash })}`,
    });
    const avatarMessage = await writerClient.sendFile(writerChannel, {
      file: input.avatarPath,
      forceDocument: true,
      parseMode: undefined,
      caption: `${ARTIFACT_MARKER} ${JSON.stringify({ appId: input.id, version: input.version, kind: 'avatar', sha256: avatarHash })}`,
    });

    manifest.artifacts.apk.messageId = safeMessageId(apkMessage?.id, 'Uploaded APK message ID');
    manifest.artifacts.avatar.messageId = safeMessageId(avatarMessage?.id, 'Uploaded avatar message ID');
    const manifestText = `${MANIFEST_MESSAGE_PREFIX}${JSON.stringify(manifest, null, 2)}`;
    if (manifestText.length > 4096) fail('StoreBase manifest exceeds Telegram’s 4096-character message limit. Reduce the app metadata before publishing.');

    const manifestMessage = await writerClient.sendMessage(writerChannel, { message: manifestText, parseMode: undefined });
    const manifestMessageId = safeMessageId(manifestMessage?.id, 'Manifest message ID');
    return { manifest, messageId: manifestMessageId, idempotent: false };
  }

  async function download(appId, version, kind, outputDirectory) {
    if (!['apk', 'avatar', 'all'].includes(kind)) fail('Artifact must be apk, avatar, or all.');
    const release = await getMetadata(appId, version);
    const kinds = kind === 'all' ? ['apk', 'avatar'] : [kind];
    const directory = path.resolve(outputDirectory || process.cwd());
    await mkdir(directory, { recursive: true });
    const downloaded = [];

    for (const artifactKind of kinds) {
      const artifact = release.manifest.artifacts[artifactKind];
      const extension = path.extname(safeFileName(artifact.fileName));
      const destination = path.join(directory, `${release.manifest.appId}-${release.manifest.version}-${artifactKind}-${artifact.sha256.slice(0, 12)}${extension}`);
      const messageId = safeMessageId(artifact.messageId);
      const messages = await readerClient.getMessages(readerChannel, { ids: [messageId] });
      const message = messages?.[0];
      if (!message) fail(`Telegram artifact message ${messageId} is no longer available.`);
      if (await exists(destination)) {
        const existingSize = (await stat(destination)).size;
        const existingHash = await sha256File(destination);
        if (existingSize !== Number(artifact.size) || existingHash !== artifact.sha256.toLowerCase()) {
          fail(`Refusing to overwrite existing file with different content: ${destination}`);
        }
        downloaded.push({ kind: artifactKind, path: destination, size: existingSize, sha256: existingHash });
        continue;
      }
      try {
        const returned = await readerClient.downloadMedia(message, { outputFile: destination });
        if (returned && !await exists(destination)) {
          const bytes = Buffer.isBuffer(returned) ? returned : Buffer.from(returned);
          await require('node:fs/promises').writeFile(destination, bytes, { flag: 'wx' });
        }
        if (!await exists(destination)) fail(`Telegram did not produce the requested ${artifactKind} file.`);
        const actualSize = (await stat(destination)).size;
        const actualHash = await sha256File(destination);
        if (actualSize !== Number(artifact.size) || actualHash !== artifact.sha256.toLowerCase()) {
          fail(`Downloaded ${artifactKind} failed integrity verification against the Telegram manifest.`);
        }
        downloaded.push({ kind: artifactKind, path: destination, size: actualSize, sha256: actualHash });
      } catch (error) {
        await rm(destination, { force: true });
        throw error;
      }
    }
    return { release, downloaded };
  }

  return { listReleases, getMetadata, publish, download };
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  ARTIFACT_MARKER,
  MANIFEST_FORMAT,
  MANIFEST_MARKER,
  MANIFEST_SCHEMA_VERSION,
  createTelegramStorage,
  parseManifestMessage,
  validateManifest,
};
