# StoreBase App Publisher CLI

A Node.js CLI for validating signed Android releases and storing their APKs, app icons, and structured metadata in a Telegram broadcast channel. Each release is immutable and independently versioned; Telegram message IDs in the manifest let the CLI fetch metadata and artifacts again later.

This change is scoped to the publisher/catalog CLI. The existing StoreBase frontend is not switched to Telegram yet.

## Requirements

- Node.js 18 or newer
- Java `keytool`
- Android SDK Build Tools `apksigner` (on `PATH`, or under `$ANDROID_SDK_ROOT/build-tools/` or `$ANDROID_HOME/build-tools/`)
- A Telegram bot added as an administrator to a broadcast channel, with permission to post messages
- Telegram application API ID and API hash for MTProto

## Install

From this repository:

```sh
npm install --global ./cli
```

Or install dependencies in the CLI directory for development:

```sh
cd cli
npm install
npm test
```

## Configure Telegram

Set the following environment variables in the shell or secret manager used to run the CLI, or put them in a mode-0600 `.env` file in the working directory. The CLI loads `.env` automatically; the StoreBase repository ignores it. Never put credentials in command-line arguments, source files, or committed files.

| Variable | Purpose |
| --- | --- |
| `STOREBASE_TELEGRAM_API_ID` | Telegram application API ID |
| `STOREBASE_TELEGRAM_API_HASH` | Telegram application API hash |
| `STOREBASE_TELEGRAM_BOT_TOKEN` | Bot token used for initial MTProto bot authorization; optional when a valid bot session is already configured |
| `STOREBASE_TELEGRAM_SESSION` | Teleproto StringSession for the authorized bot; optional on first use because the bot token can create an MTProto session |
| `STOREBASE_TELEGRAM_READ_SESSION` | Authorized personal-user Teleproto StringSession with access to the channel, required for listing metadata and downloading artifacts |
| `STOREBASE_TELEGRAM_CHANNEL` | Channel username such as `@StoreBaseApps`, or a channel ID such as `-100…` |

The channel must be a **broadcast channel**, and the bot must be its admin with permission to post. The CLI authenticates through Teleproto/MTProto, not the HTTP Bot API. It uses the bot session for uploads and a separate personal-user session for channel history and downloads, because Telegram does not allow bot accounts to read channel history. The bot session must be a bot; the read session must be a user who can access the channel.

To explicitly create/export a bot StringSession after setting the API ID, API hash, and bot token:

```sh
storebase-telegram session
```

That command prints a reusable bot Teleproto StringSession secret. Store it in `STOREBASE_TELEGRAM_SESSION`; do not share or commit it. Teleproto can read legacy GramJS/Telethon session strings. Keeping a valid bot session means later runs can omit the bot token. If no session is configured, the CLI can authorize from the bot token each time.

## Publish a release

The default storage is Telegram. The publisher asks for any missing app details interactively. The signing-keystore password is read with hidden terminal input or from `STOREBASE_KEYSTORE_PASSWORD`; it is never accepted as a CLI option. If a keystore has multiple private-key aliases, use `--alias` or select one interactively.

```sh
STOREBASE_KEYSTORE_PASSWORD="$KEYSTORE_PASSWORD" storebase-publish \
  --name "Example App" \
  --avatar ./icon.png \
  --version 1.2.0 \
  --apk ./app-release.apk \
  --category Productivity \
  --description "A short description of the app." \
  --keystore ./release.jks \
  --alias release
```

The CLI runs `keytool` and `apksigner`, and refuses to publish unless the APK signer certificate matches the selected private-key certificate in the provided keystore. The keystore is used only for verification and is never uploaded.

Supported categories: Education, Social, Productivity, Communication, Entertainment, Games, Business, Shopping, Finance, Utilities, Health & Fitness, Travel & Navigation, and AI & Machine Learning.

Use `--storage local` to opt into the previous local JSON/files workflow. Its `--catalog` and `--assets-dir` options are only used in local mode.

## Telegram storage format

Each release adds three channel posts: an APK document, an icon document, then a JSON manifest text post. The manifest is posted last so incomplete uploads are not listed as releases. Artifacts are retained in the channel; publishing a later version does not delete older versions.

The manifest begins with `STOREBASE_MANIFEST_V1` and has this structured shape:

```json
{
  "format": "storebase.app-release",
  "schemaVersion": 1,
  "appId": "example-app",
  "app": {
    "name": "Example App",
    "category": "Productivity",
    "description": "A short description of the app."
  },
  "version": "1.2.0",
  "publishedAt": "2026-01-01T00:00:00.000Z",
  "signingCertificateSha256": "…",
  "artifacts": {
    "apk": {
      "fileName": "app-release.apk",
      "mimeType": "application/vnd.android.package-archive",
      "size": 123456,
      "sha256": "…",
      "messageId": 100
    },
    "avatar": {
      "fileName": "icon.png",
      "mimeType": "image/png",
      "size": 1234,
      "sha256": "…",
      "messageId": 101
    }
  }
}
```

`schemaVersion` versions the manifest contract; `version` identifies the app release. Publishing identical content for the same app/version is idempotent. A changed APK, icon, or metadata cannot overwrite an existing app/version; publish a new version instead.

## Retrieve metadata and artifacts

```sh
# All versions, newest first
storebase-telegram list

# A specific version, or the newest version if --version is omitted
storebase-telegram metadata example-app --version 1.2.0

# Download both APK and icon; both are SHA-256 and size-verified
storebase-telegram download example-app --version 1.2.0 --kind all --out ./downloads

# APK only
storebase-telegram download example-app --version 1.2.0 --kind apk
```

The catalog command uses the personal read session to scan the channel's versioned manifest posts, then uses each manifest's Telegram message IDs to fetch the corresponding artifacts. Downloaded names include the version and content hash to avoid replacing a different release.

## Development

```sh
cd cli
npm test
```
