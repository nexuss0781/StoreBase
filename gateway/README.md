# StoreBase gateway

The gateway returns encrypted Telegram configuration for two clients; it never relays app catalog metadata or release files.

- `POST /api/v1/catalog/bootstrap` is the Android app's read-only settings bootstrap. `/api/v1/telegram/bootstrap` remains a compatibility alias for the current Android native bridge.
- `POST /api/v1/publisher/bootstrap` is for the npm CLI. It returns the minimum Telegram settings needed to upload and inspect releases, and only after a signed request includes the configured publisher token.

## Runtime configuration

The read-only catalog bootstrap uses:

- `STOREBASE_TELEGRAM_API_ID`
- `STOREBASE_TELEGRAM_API_HASH`
- `STOREBASE_TELEGRAM_READ_SESSION` — personal-user MTProto session with read access to the broadcast channel
- `STOREBASE_TELEGRAM_CHANNEL`

The publisher bootstrap additionally requires:

- `STOREBASE_TELEGRAM_SESSION` — stored bot MTProto session; the bot must be an administrator allowed to post
- `STOREBASE_GATEWAY_PUBLISH_TOKEN` — high-entropy shared secret, configured as a Wasmer secret and separately in the CLI's runtime environment

Do not configure the publisher token in the Android app or include it in the npm package. The gateway compares it in constant time, and the CLI signs it into the publisher request. If the token is missing or malformed, the publisher route remains closed. The publisher response contains API ID/hash, bot session, reader session, and channel; it does not return the bot token.

## Encryption and handling

The request is bound to a timestamp, endpoint, public key, and replay-protected request ID. The gateway encrypts each response to the request's ephemeral RSA key using RSA-OAEP-SHA256 and AES-256-GCM. The CLI decrypts publisher settings in memory and passes them directly to the Telegram client; it does not write them to disk or print them. Gateway settings are cached only in the gateway process memory and refreshed when that process restarts.

## Android and Telegram flow

1. On first launch, the Android native bridge requests read-only settings with a signed request, validates and decrypts them, then caches them encrypted with a separate Keystore AES-GCM key in Android's `noBackupFilesDir`.
2. The WebView converts the Telethon-compatible StringSession in memory and connects directly to Telegram with `@mtcute/web`/MTProto.
3. The app reads version manifests and artifacts directly from Telegram. The CLI stores APKs, optional `.sbd` patches, icons, manifests, and default-version pointers as Telegram channel messages.

The gateway does not relay catalog metadata, APKs, patches, or other release files. Uploading through the CLI is a separate action; the gateway does not publish automatically.

## Personal-use security boundary

This is a personal-use design, not a production credential-distribution system. The Android bootstrap uses a per-install signature to prove possession of an installation key, but it does not prove that the caller is the official StoreBase APK; a caller able to obtain the read-only settings can extract the reader session. The publisher route adds a separate shared token, but anyone who obtains that token can request the bot session and publish to the channel. Restrict and rotate the publisher token if exposed; do not use this design for production distribution.

## Local checks

```sh
npm install
npm test
npm run build
npm run android:build
```

These checks do not change the public gateway or Telegram channel.
