'use strict';

function fail(message) {
  throw new Error(message);
}

function readTelegramConfig(env = process.env, options = {}) {
  const apiIdText = env.STOREBASE_TELEGRAM_API_ID;
  const apiHash = env.STOREBASE_TELEGRAM_API_HASH;
  const botToken = env.STOREBASE_TELEGRAM_BOT_TOKEN;
  const session = env.STOREBASE_TELEGRAM_SESSION || '';
  const readSession = env.STOREBASE_TELEGRAM_READ_SESSION || '';
  const channelValue = env.STOREBASE_TELEGRAM_CHANNEL;
  const apiId = Number(apiIdText);

  if (!apiIdText || !Number.isSafeInteger(apiId) || apiId <= 0) {
    fail('Set STOREBASE_TELEGRAM_API_ID to the Telegram application API ID.');
  }
  if (typeof apiHash !== 'string' || !apiHash.trim()) {
    fail('Set STOREBASE_TELEGRAM_API_HASH to the Telegram application API hash.');
  }
  if (options.requireChannel !== false && (!channelValue || !String(channelValue).trim())) {
    fail('Set STOREBASE_TELEGRAM_CHANNEL to the target channel username (for example @StoreBaseApps) or channel ID.');
  }
  if (!session && !botToken) {
    fail('Set STOREBASE_TELEGRAM_BOT_TOKEN for initial MTProto bot authorization, or provide an authorized STOREBASE_TELEGRAM_SESSION.');
  }
  if (options.requireReader !== false && !readSession) {
    fail('Set STOREBASE_TELEGRAM_READ_SESSION to an authorized personal MTProto StringSession with read access to the channel. Telegram bots cannot read channel history.');
  }

  return {
    apiId,
    apiHash: apiHash.trim(),
    botToken: botToken?.trim(),
    session,
    readSession,
    channel: channelValue ? String(channelValue).trim() : undefined,
  };
}

function createClient(StringSession, TelegramClient, session, config) {
  return new TelegramClient(new StringSession(session), config.apiId, config.apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
  });
}

function requireBroadcastChannel(entity, label) {
  if (!entity || entity.className !== 'Channel' || entity.broadcast !== true) {
    fail(`${label} must resolve to a Telegram broadcast channel.`);
  }
}

async function disconnectTelegram(connection) {
  if (!connection) return;
  const clients = [...new Set([connection.client, connection.readerClient].filter(Boolean))];
  await Promise.allSettled(clients.map((client) => client.disconnect()));
}

async function disconnectTelegramReader(connection) {
  if (!connection?.client) return;
  await Promise.allSettled([connection.client.disconnect()]);
}

function readTelegramReaderConfig(env = process.env) {
  const apiIdText = env.STOREBASE_TELEGRAM_API_ID;
  const apiHash = env.STOREBASE_TELEGRAM_API_HASH;
  const readSession = env.STOREBASE_TELEGRAM_READ_SESSION;
  const channelValue = env.STOREBASE_TELEGRAM_CHANNEL;
  const apiId = Number(apiIdText);
  if (!apiIdText || !Number.isSafeInteger(apiId) || apiId <= 0) {
    fail('Set STOREBASE_TELEGRAM_API_ID to the Telegram application API ID.');
  }
  if (typeof apiHash !== 'string' || !apiHash.trim()) {
    fail('Set STOREBASE_TELEGRAM_API_HASH to the Telegram application API hash.');
  }
  if (typeof readSession !== 'string' || !readSession.trim()) {
    fail('Set STOREBASE_TELEGRAM_READ_SESSION to an authorized personal MTProto StringSession with read access to the channel.');
  }
  if (!channelValue || !String(channelValue).trim()) {
    fail('Set STOREBASE_TELEGRAM_CHANNEL to the target channel username or channel ID.');
  }
  return { apiId, apiHash: apiHash.trim(), readSession: readSession.trim(), channel: String(channelValue).trim() };
}

async function connectTelegramReader(env = process.env) {
  const config = readTelegramReaderConfig(env);
  const { TelegramClient } = require('teleproto');
  const { StringSession } = require('teleproto/sessions');
  const client = createClient(StringSession, TelegramClient, config.readSession, config);
  try {
    await client.connect();
    if (!await client.checkAuthorization()) {
      fail('STOREBASE_TELEGRAM_READ_SESSION is not authorized. Supply a valid user StringSession with access to the StoreBase channel.');
    }
    if (typeof client.isBot === 'function' && await client.isBot()) {
      fail('STOREBASE_TELEGRAM_READ_SESSION must be a personal user session. Bot sessions cannot read channel history.');
    }
    const channelEntity = await client.getEntity(config.channel);
    requireBroadcastChannel(channelEntity, 'STOREBASE_TELEGRAM_CHANNEL as seen by the reader session');
    await client.getMessages(channelEntity, { limit: 1 });
    return { client, channelEntity, channel: config.channel };
  } catch (error) {
    await disconnectTelegramReader({ client });
    throw error;
  }
}

async function connectTelegram(env = process.env, options = {}) {
  const config = readTelegramConfig(env, options);
  const { TelegramClient } = require('teleproto');
  const { StringSession } = require('teleproto/sessions');
  const client = createClient(StringSession, TelegramClient, config.session, config);
  let readerClient;

  try {
    if (config.session) {
      await client.connect();
      const authorized = await client.checkAuthorization();
      if (!authorized) {
        if (!config.botToken) fail('The saved Telegram bot session is not authorized. Set STOREBASE_TELEGRAM_BOT_TOKEN to authenticate it again.');
        await client.start({ botAuthToken: config.botToken });
      }
    } else {
      await client.start({ botAuthToken: config.botToken });
    }

    if (typeof client.isBot === 'function' && !await client.isBot()) {
      fail('STOREBASE_TELEGRAM_SESSION must belong to the StoreBase admin bot; use STOREBASE_TELEGRAM_READ_SESSION for a personal user session.');
    }
    const channelEntity = config.channel ? await client.getEntity(config.channel) : undefined;
    if (config.channel) requireBroadcastChannel(channelEntity, 'STOREBASE_TELEGRAM_CHANNEL');

    let readerChannel;
    if (options.requireReader !== false) {
      readerClient = createClient(StringSession, TelegramClient, config.readSession, config);
      await readerClient.connect();
      if (!await readerClient.checkAuthorization()) {
        fail('STOREBASE_TELEGRAM_READ_SESSION is not authorized. Supply a valid user StringSession with access to the StoreBase channel.');
      }
      if (typeof readerClient.isBot === 'function' && await readerClient.isBot()) {
        fail('STOREBASE_TELEGRAM_READ_SESSION must be a personal user session. Bot sessions cannot read channel history.');
      }
      readerChannel = await readerClient.getEntity(config.channel);
      requireBroadcastChannel(readerChannel, 'STOREBASE_TELEGRAM_CHANNEL as seen by the reader session');
      if (String(readerChannel.id) !== String(channelEntity.id)) {
        fail('The bot and reader sessions resolved STOREBASE_TELEGRAM_CHANNEL to different channels.');
      }
      // Bot accounts are barred from reading channel history; a personal MTProto session
      // performs this read-only check and handles catalog listing and artifact retrieval.
      await readerClient.getMessages(readerChannel, { limit: 1 });
    }

    return {
      client,
      readerClient,
      channelEntity,
      readerChannel,
      channel: config.channel,
      session: client.session.save(),
      readSession: config.readSession,
      hasStoredSession: Boolean(config.session),
    };
  } catch (error) {
    await disconnectTelegram({ client, readerClient });
    throw error;
  }
}

module.exports = {
  connectTelegram,
  connectTelegramReader,
  disconnectTelegram,
  disconnectTelegramReader,
  readTelegramConfig,
  readTelegramReaderConfig,
};
