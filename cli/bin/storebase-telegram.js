#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { stdout, stderr } = require('node:process');
const {
  connectTelegramFromGateway,
  connectTelegramReaderFromGateway,
} = require('../lib/gateway-client');
const { getPublisherEnvironment } = require('../lib/publisher-token');
const {
  connectTelegram,
  connectTelegramReader,
  disconnectTelegram,
} = require('../lib/telegram-client');
const { createTelegramStorage } = require('../lib/telegram-storage');

function showHelp() {
  stdout.write(`StoreBase Telegram catalog tools

Usage:
  storebase-telegram list [--telegram-config gateway|local]
  storebase-telegram metadata <app-id> [--version <version>] [--telegram-config gateway|local]
  storebase-telegram download <app-id> [--version <version>] [--kind apk|avatar|delta|all] [--out <directory>] [--telegram-config gateway|local]
  storebase-telegram pin <app-id> <version> [--telegram-config gateway|local]

Catalog reads use the read-only gateway bootstrap. pin and APK publishing use the
separate token-protected publisher bootstrap. With no --version, metadata and
downloads use the app's pinned default, or the newest release if none is pinned.
Gateway settings are decrypted in memory only.
`);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const equals = arg.indexOf('=');
    const key = arg.slice(2, equals < 0 ? undefined : equals);
    if (!['version', 'kind', 'out', 'telegram-config'].includes(key)) throw new Error(`Unknown option: --${key}`);
    const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error(`Option --${key} requires a value.`);
    options[key] = value;
  }
  return options;
}

async function releaseConnection(mode, needsWrite) {
  if (mode === 'local') return needsWrite ? connectTelegram() : connectTelegramReader();
  if (mode !== 'gateway') throw new Error('--telegram-config must be either gateway or local.');
  return needsWrite
    ? connectTelegramFromGateway(await getPublisherEnvironment())
    : connectTelegramReaderFromGateway();
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') return showHelp();
  if (!['list', 'metadata', 'download', 'pin'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const needsApp = ['metadata', 'download', 'pin'].includes(command);
  const appId = needsApp ? args.shift() : undefined;
  if (needsApp && (!appId || appId.startsWith('--'))) throw new Error(`${command} requires an app ID.`);
  const pinVersion = command === 'pin' ? args.shift() : undefined;
  if (command === 'pin' && (!pinVersion || pinVersion.startsWith('--'))) throw new Error('pin requires an app ID and version.');
  const options = parseOptions(args);
  const mode = options['telegram-config'] || 'gateway';
  const connection = await releaseConnection(mode, command === 'pin');
  try {
    const storage = createTelegramStorage(connection.client, connection.channelEntity, {
      readerClient: connection.readerClient,
      readerChannel: connection.readerChannel,
      writerChannel: connection.channelEntity,
    });
    if (command === 'list') {
      const apps = await storage.getCatalog();
      if (!apps.length) {
        stdout.write('No StoreBase releases were found in the configured Telegram channel.\n');
        return;
      }
      const rows = apps.map(({ appId: id, app, defaultVersion, defaultPinned, versions }) => ({
        appId: id,
        name: app.name,
        category: app.category,
        defaultVersion,
        defaultPinned,
        versions: versions.map(({ manifest, messageId }) => ({
          version: manifest.version,
          publishedAt: manifest.publishedAt,
          manifestMessageId: messageId,
        })),
      }));
      stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    if (command === 'pin') {
      const result = await storage.pinVersion(appId, pinVersion);
      stdout.write(`Default version ${result.idempotent ? 'already set' : 'set'}: ${appId} ${pinVersion}\n`);
      stdout.write(`Telegram message ID: ${result.messageId}\n`);
      return;
    }
    if (command === 'metadata') {
      const [release, apps] = await Promise.all([storage.getMetadata(appId, options.version), storage.getCatalog()]);
      const app = apps.find((entry) => entry.appId === appId);
      stdout.write(`${JSON.stringify({ ...release, defaultVersion: app?.defaultVersion }, null, 2)}\n`);
      return;
    }
    const kind = options.kind || 'all';
    const result = await storage.download(appId, options.version, kind, options.out || './storebase-downloads');
    stdout.write(`Release: ${result.release.manifest.app.name} ${result.release.manifest.version}\n`);
    for (const artifact of result.downloaded) stdout.write(`${artifact.kind}: ${artifact.path} (${artifact.size} bytes, sha256 ${artifact.sha256})\n`);
  } finally {
    await disconnectTelegram(connection);
  }
}

main().catch((error) => {
  stderr.write(`storebase-telegram: ${error.message}\n`);
  process.exitCode = 1;
});
