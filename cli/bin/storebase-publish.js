#!/usr/bin/env node
'use strict';

const { createInterface } = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { connectTelegramFromGateway } = require('../lib/gateway-client');
const { getPublisherEnvironment } = require('../lib/publisher-token');
const { loadProfileEntry } = require('../lib/signing-profiles');
const { hidden } = require('../lib/secure-prompt');
const {
  CATEGORIES,
  inspectKeystore,
  releaseApp,
  validateInput,
  verifyApkSignature,
} = require('../lib/publisher');
const { connectTelegram, disconnectTelegram } = require('../lib/telegram-client');
const { createTelegramStorage } = require('../lib/telegram-storage');

const OPTION_NAMES = new Set([
  'name', 'avatar', 'version', 'apk', 'category', 'description', 'keystore', 'alias', 'storage', 'catalog', 'assets-dir',
  'telegram-config', 'signing-profile',
  'android-version-code', 'minimum-android-version-code', 'delta', 'delta-base-version-code',
]);

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return { help: true, options };
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const equals = argument.indexOf('=');
    const name = argument.slice(2, equals < 0 ? undefined : equals);
    if (!OPTION_NAMES.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = equals < 0 ? args[++index] : argument.slice(equals + 1);
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new Error(`Option --${name} requires a value.`);
    }
    options[name] = value;
  }
  return { help: false, options };
}

function showHelp() {
  stdout.write(`StoreBase app publisher

Usage:
  storebase-publish [options]

Options (omitted app details are prompted interactively):
  --name <name>                         App name
  --avatar <file>                       PNG, JPEG, or WebP avatar file
  --version <version>                   App version
  --apk <file>                          Signed Android APK
  --android-version-code <n>            Required for StoreBase Android releases
  --minimum-android-version-code <n>    Optional required-upgrade floor
  --delta <file.sbd>                    Optional StoreBase patch artifact
  --delta-base-version-code <n>         Installed base code for the patch
  --category <category>                 One of the 13 StoreBase categories
  --description <text>                  App description
  --signing-profile <profile>           Reuse a profile from storebase-keystore
  --keystore <file>                     One-off signing keystore (no profile)
  --alias <name>                        Private-key alias, if the keystore has multiple
  --storage <backend>                   telegram (default) or local
  --telegram-config <mode>              gateway (default) or local direct Telegram settings
  --catalog <file>                      Local app-list JSON (local mode only)
  --assets-dir <directory>              Local artifact directory (local mode only)
  -h, --help                            Show this help

Gateway mode uses STOREBASE_GATEWAY_URL (optional; defaults to the StoreBase gateway)
and STOREBASE_GATEWAY_PUBLISH_TOKEN. The gateway sends encrypted Telegram settings
to this run only; settings are decrypted in memory and are never written to disk.
Use --telegram-config local only when supplying Telegram settings directly in the environment.
The bot must be a channel administrator. Keystore passwords are entered in a hidden
prompt or read from STOREBASE_KEYSTORE_PASSWORD.
`);
}


async function collectInput(options) {
  const required = [
    ['name', 'App name'],
    ['avatar', 'Avatar file path'],
    ['version', 'Version'],
    ['apk', 'APK file path'],
    ['category', 'Category'],
    ['description', 'Description'],
    ['keystore', 'Signed keystore file path'],
  ];
  if (options['signing-profile']) required.splice(required.findIndex(([key]) => key === 'keystore'), 1);
  const missing = required.filter(([key]) => !options[key]);
  if (missing.length && (!stdin.isTTY || !stdout.isTTY)) {
    throw new Error(`Missing required options: ${missing.map(([key]) => `--${key}`).join(', ')}. Prompts require an interactive terminal.`);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (const [key, label] of required) {
      if (!options[key]) {
        if (key === 'category') {
          stdout.write('\nAvailable categories:\n');
          CATEGORIES.forEach((category, index) => stdout.write(`  ${index + 1}. ${category}\n`));
        }
        options[key] = (await rl.question(`${label}${key === 'category' ? ' (number or name)' : ''}: `)).trim();
        if (key === 'category' && /^\d+$/.test(options[key])) {
          const category = CATEGORIES[Number(options[key]) - 1];
          if (category) options[key] = category;
        }
      }
    }
  } finally {
    rl.close();
  }
  return {
    name: options.name,
    avatar: options.avatar,
    version: options.version,
    apk: options.apk,
    category: options.category,
    description: options.description,
    keystore: options.keystore,
    alias: options.alias,
    androidVersionCode: options['android-version-code'],
    minimumAndroidVersionCode: options['minimum-android-version-code'],
    delta: options.delta,
    deltaBaseVersionCode: options['delta-base-version-code'],
  };
}

async function selectEntry(entries, aliasOption) {
  if (aliasOption) {
    const selected = entries.find((entry) => entry.alias === aliasOption);
    if (!selected) throw new Error(`Keystore alias "${aliasOption}" is not a private-key entry. Available aliases: ${entries.map((entry) => entry.alias).join(', ')}.`);
    return selected;
  }
  if (entries.length === 1) return entries[0];
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(`Keystore has multiple private-key aliases. Select one with --alias: ${entries.map((entry) => entry.alias).join(', ')}.`);
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`Keystore private-key aliases: ${entries.map((entry) => entry.alias).join(', ')}\n`);
    const alias = (await rl.question('Signing alias: ')).trim();
    const selected = entries.find((entry) => entry.alias === alias);
    if (!selected) throw new Error(`Unknown signing alias: ${alias}`);
    return selected;
  } finally {
    rl.close();
  }
}

async function main() {
  require('dotenv').config();
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) return showHelp();
  const options = parsed.options;
  options.storage = options.storage || 'telegram';
  if (!['telegram', 'local'].includes(options.storage)) {
    throw new Error('--storage must be either telegram or local.');
  }
  options['telegram-config'] = options['telegram-config'] || 'gateway';
  if (!['gateway', 'local'].includes(options['telegram-config'])) {
    throw new Error('--telegram-config must be either gateway or local.');
  }
  if (options['signing-profile'] && (options.keystore || options.alias)) {
    throw new Error('--signing-profile cannot be combined with --keystore or --alias.');
  }
  const rawInput = await collectInput(options);
  let entry = options['signing-profile'] ? await loadProfileEntry(options['signing-profile']) : undefined;
  const input = await validateInput(rawInput, { signingProfile: entry });
  if (!entry) {
    let password = process.env.STOREBASE_KEYSTORE_PASSWORD ?? await hidden('Keystore password');
    try { entry = await selectEntry(await inspectKeystore(input.keystorePath, password), input.alias); }
    finally { password = ''; }
  }
  const certificate = verifyApkSignature(input.apkPath, entry);
  if (options.storage === 'local') {
    if (input.androidVersionCode !== undefined || input.deltaPath) {
      throw new Error('StoreBase Android update metadata and delta artifacts must be published through Telegram storage.');
    }
    const result = await releaseApp(input, {
      catalogPath: options.catalog,
      assetsDir: options['assets-dir'],
      signingCertificateSha256: certificate,
    });
    stdout.write(`\nLocal release complete: ${result.app.name} ${result.app.version}\n`);
    stdout.write(`App list: ${result.catalogPath}\n`);
    stdout.write(`APK: ${result.app.apk}\n`);
    stdout.write(`Avatar: ${result.app.avatar}\n`);
  } else {
    const connection = options['telegram-config'] === 'local'
      ? await connectTelegram()
      : await connectTelegramFromGateway(await getPublisherEnvironment());
    try {
      const storage = createTelegramStorage(connection.client, connection.channelEntity, {
        readerClient: connection.readerClient,
        readerChannel: connection.readerChannel,
        writerChannel: connection.channelEntity,
        channelRef: connection.channel,
      });
      const result = await storage.publish(input, certificate);
      stdout.write(`\nTelegram release ${result.idempotent ? 'already exists' : 'published'}: ${input.name} ${input.version}\n`);
      stdout.write(`Channel: ${connection.channel}\n`);
      stdout.write(`Manifest message ID: ${result.messageId}\n`);
      stdout.write(`APK message ID: ${result.manifest.artifacts.apk.messageId}\n`);
      stdout.write(`Avatar message ID: ${result.manifest.artifacts.avatar.messageId}\n`);
      if (result.manifest.artifacts.delta) stdout.write(`Delta message ID: ${result.manifest.artifacts.delta.messageId}\n`);
    } finally {
      await disconnectTelegram(connection);
    }
  }
  stdout.write('APK signing certificate verified. No keystore or signing passwords were uploaded.\n');
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`storebase-publish: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { parseArguments, collectInput };
