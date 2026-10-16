#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { stdout, stderr } = require('node:process');
const { connectTelegram, disconnectTelegram } = require('../lib/telegram-client');
const { createTelegramStorage } = require('../lib/telegram-storage');

function showHelp() {
  stdout.write(`StoreBase Telegram catalog tools\n\nUsage:\n  storebase-telegram list\n  storebase-telegram metadata <app-id> [--version <version>]\n  storebase-telegram download <app-id> [--version <version>] [--kind apk|avatar|all] [--out <directory>]\n  storebase-telegram session\n\nThe session command explicitly prints the bot's MTProto StringSession. Treat it as a secret.\nCatalog commands read the versioned manifests in the configured Telegram channel.\n`);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const equals = arg.indexOf('=');
    const key = arg.slice(2, equals < 0 ? undefined : equals);
    if (!['version', 'kind', 'out'].includes(key)) throw new Error(`Unknown option: --${key}`);
    const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error(`Option --${key} requires a value.`);
    options[key] = value;
  }
  return options;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') return showHelp();
  if (!['list', 'metadata', 'download', 'session'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command === 'session') {
    if (args.length) throw new Error('The session command does not accept arguments.');
    const connection = await connectTelegram(process.env, { requireChannel: false });
    try {
      stdout.write('Telegram bot MTProto StringSession (secret):\n');
      stdout.write(`${connection.session}\n\n`);
      stdout.write('Store this as STOREBASE_TELEGRAM_SESSION. Do not share it or commit it.\n');
    } finally {
      await disconnectTelegram(connection);
    }
    return;
  }

  const appId = ['metadata', 'download'].includes(command) ? args.shift() : undefined;
  if (command !== 'list' && (!appId || appId.startsWith('--'))) throw new Error(`${command} requires an app ID.`);
  const options = parseOptions(args);
  const connection = await connectTelegram();
  try {
    const storage = createTelegramStorage(connection.client, connection.channelEntity, {
      readerClient: connection.readerClient,
      readerChannel: connection.readerChannel,
      writerChannel: connection.channelEntity,
    });
    if (command === 'list') {
      const releases = await storage.listReleases();
      if (!releases.length) {
        stdout.write('No StoreBase releases were found in the configured channel.\n');
        return;
      }
      const rows = releases.map(({ manifest, messageId }) => ({
        appId: manifest.appId,
        name: manifest.app.name,
        version: manifest.version,
        category: manifest.app.category,
        publishedAt: manifest.publishedAt,
        manifestMessageId: messageId,
      }));
      stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    if (command === 'metadata') {
      const release = await storage.getMetadata(appId, options.version);
      stdout.write(`${JSON.stringify(release, null, 2)}\n`);
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
