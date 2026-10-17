# StoreBase App Publisher CLI

A Node.js CLI for validating signed Android releases and storing APKs, optional deltas, app icons, and version metadata directly in a Telegram broadcast channel. Release manifests are immutable and versioned; the CLI preserves every release and can keep a separate Telegram record identifying an app's default pinned version.

The gateway provides encrypted Telegram settings at runtime. The CLI decrypts them in memory, connects directly to Telegram, and never writes Telegram credentials to disk. The gateway does not relay APKs or catalog metadata.

## Requirements

- Node.js 18 or newer
- Java 21 or newer `keytool` for the signing-profile import workflow (tested with Java 21; supports password delivery through `:env`)
- Android SDK Build Tools `apksigner` (on `PATH`, or under `$ANDROID_SDK_ROOT/build-tools/` or `$ANDROID_HOME/build-tools/`)
- A Telegram bot that is an administrator of the broadcast channel with permission to post
- Telegram API ID and API hash, a stored bot MTProto session, and a separate personal-user read session

## Install and test

For local development:

```sh
cd cli
npm install
npm test
```

Install the published package globally with:

```sh
npm install --global storebase-cli
```

To install this checkout globally:

```sh
npm install --global ./cli
```

## Agent skill: complete end-to-end workflows

Version 1.3 bundles a real agent skill with YAML frontmatter and detailed workflow references. It covers CLI setup, runtime publisher keys, encrypted gateway bootstrap, signing-profile import/reuse/replacement/rekey/removal, approved APK/icon/metadata publishing, immutable Telegram history and deltas, default-version pins, catalog downloads, Apps/Explore limitations, Android direct Telegram access and install approval/reopen behavior, local Wasmer deployment, and source/release testing.

```sh
storebase-skill path
storebase-skill install --dir ./agent-skills
```

`path` prints the installed `SKILL.md`. `install --dir <skills-root>` copies the skill into `<skills-root>/storebase/` and refuses to overwrite an existing destination. Choose the skills root supported by your agent and enable/reload it there when required; this command does not change agent configuration. Upgrading npm updates the bundled skill, not previously copied installations. The skill's entry point is [`skills/storebase/SKILL.md`](skills/storebase/SKILL.md); its linked references contain full command examples and troubleshooting. Multi-line shell examples in this README use POSIX syntax; use a single line or PowerShell continuations on Windows. Native Windows APK-tool discovery and Android installation must be verified separately.

## Runtime configuration

Gateway mode is the default. `storebase-telegram list`, `metadata`, and `download` use the read-only catalog bootstrap and do not require publisher credentials. `storebase-publish` and `storebase-telegram pin` use the separate publisher bootstrap and require the same high-entropy `STOREBASE_GATEWAY_PUBLISH_TOKEN` in the gateway's secret environment and the CLI runtime. Keep that token in a secret manager or mode-0600 `.env` file; do not commit it. In an interactive terminal, these write commands prompt for it without echoing it when the environment variable is absent; non-interactive runs must set the environment variable. The gateway URL is optional and defaults to `https://storebase.wasmer.app`.

```dotenv
STOREBASE_GATEWAY_URL=https://storebase.wasmer.app
STOREBASE_GATEWAY_PUBLISH_TOKEN=<same-secret-configured-on-the-gateway>
```

The gateway must also have its existing Telegram environment configured: `STOREBASE_TELEGRAM_API_ID`, `STOREBASE_TELEGRAM_API_HASH`, `STOREBASE_TELEGRAM_SESSION` (the bot's stored MTProto session), `STOREBASE_TELEGRAM_READ_SESSION` (a personal-user session with channel access), and `STOREBASE_TELEGRAM_CHANNEL`. The publisher bootstrap returns only the API ID/hash, bot session, reader session, and channel; it excludes the bot token. The shared publisher token is checked before those settings are returned. Do not place credentials in source code, command-line arguments, or this npm package.

At runtime, the CLI creates an ephemeral RSA keypair, requests settings over HTTPS, decrypts the AES-GCM envelope in memory, and passes the values directly to the Telegram client. It does not persist decrypted settings or include them in CLI output. This remains a personal-use design, not a production identity or device-attestation system. Anyone who obtains the publisher token can obtain the encrypted bot session; keep that token restricted and rotate it if exposed.

For a direct local Telegram connection instead, place the Telegram variables above in the CLI environment and pass `--telegram-config local`. The gateway remains the default for publishing and catalog commands.

## Publish a release

The publisher prompts for missing app details. The signing-keystore password is read through hidden terminal input or from `STOREBASE_KEYSTORE_PASSWORD`; it is never accepted as a CLI option. If a keystore has multiple private-key aliases, use `--alias` or select one interactively.

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

For the `StoreBase` app, provide `--android-version-code` on every release. A matching `.sbd` patch can be attached using `--delta <file.sbd> --delta-base-version-code <installed-code>`; the CLI stores the patch in the same Telegram channel and includes its message ID, hash, size, base code, package ID, and release code in the versioned manifest.

Supported categories: Education, Social, Productivity, Communication, Entertainment, Games, Business, Shopping, Finance, Utilities, Health & Fitness, Travel & Navigation, and AI & Machine Learning.

Use `--storage local` to opt into the older local JSON/files workflow. Its `--catalog` and `--assets-dir` options are only used in local mode.

## Import a signing keystore once

Version 1.2 adds a local encrypted signing vault. Create a named profile once, then select that profile for any app tag or release instead of repeatedly supplying a keystore file:

```sh
storebase-keystore import release --file /path/to/release.jks --alias release
storebase-keystore list
storebase-publish --signing-profile release \
  --name "Example App" --version 2.0.0 --apk ./app-release.apk \
  --avatar ./icon.png --category Productivity --description "Updated release."
```

Import prompts without echo for a vault passphrase (at least 12 characters, confirmed on creation), the keystore password, and the private-key password. Press Enter at the private-key prompt to reuse the keystore password. Use a long, unique vault passphrase; there is no saved unlock key or recovery service. Profile operations and profile-based publishing require an interactive terminal. Password arguments, password files, and environment variables are not accepted by these new profile commands. The older one-off `--keystore` workflow remains compatible, including its legacy runtime password variable; do not save signing passwords in `.env` or shell history.

Java `keytool` validates the imported keystore, private-key alias, private-key password, and certificate. Multiple private-key entries require `--alias`. The CLI stores an encrypted copy rather than a source path, so the source keystore need not remain at the original location. `--signing-profile` cannot be combined with `--keystore` or `--alias`. Profiles are explicit, not automatically tied to app names or selected as a default.

Publishing continues to **verify an already-signed APK**, not sign or re-sign it. It compares the APK certificate to the certificate validated when the profile was imported. Profile-based publishing never extracts the stored private key to disk. A different signer is rejected. Neither the keystore nor its passwords are uploaded to Telegram or the gateway; only the public certificate fingerprint belongs in release metadata.

### Update, rotate, or remove

```sh
# Update passwords or replace the stored key after validating the replacement
storebase-keystore import release --file /path/to/replacement.jks --alias release --replace

# Re-encrypt every profile under a new vault passphrase
storebase-keystore rekey

# Delete a profile from the current encrypted vault
storebase-keystore remove release

# Print the location without unlocking the vault
storebase-keystore location
```

Replacing and removing profiles require an explicit typed confirmation. Replacement validates the new keystore before atomically updating the vault; a failed import leaves the old profile intact. Changing the vault passphrase does not change the keystore's own passwords or signing key. Replacing a key does not generate Android signing lineage, change Play App Signing, or make existing installations accept a different certificate. Keep the old key backed up before rotation; otherwise updates to existing installs may become impossible.

### Where secrets are stored

The vault is `signing-vault.json` under `~/.local/share/storebase-cli/` on Linux, `~/Library/Application Support/storebase-cli/` on macOS, or `~/AppData/Local/storebase-cli/` on Windows. The CLI does not use the current project, repository, npm install directory, Telegram, or an environment-selected path for its production vault. It does not use an OS keychain: the separate master passphrase is requested for every command and is never stored.

The complete profile collection—including keystore bytes, store password, private-key password, alias, and certificate—is encrypted with AES-256-GCM. A fresh random salt and nonce are used for each write; scrypt derives the encryption key from the master passphrase (N=32768, r=8, p=1). Authentication detects wrong passphrases and modified vaults. Writes are locked and atomic. On POSIX, the dedicated directory is mode 0700 and files are mode 0600; unsafe permissions, ownership, or symlink paths are refused. On Windows, keep the user-data directory restricted to your account using Windows permissions; ciphertext encryption is not a substitute for protecting the account.

Import briefly creates a private mode-0700 temporary directory containing a mode-0600 copy of the keystore so Java can validate exactly the bytes being imported. It overwrites that copy best-effort and removes the directory in `finally`, on success or failure. Passwords are passed to Java through its child-process environment, never arguments, logs, or plaintext password files. Decrypted data exists in process memory while unlocked. Buffers are cleared best-effort, but JavaScript strings, OS swap, privileged process inspection, crashes, and malicious code running as your user cannot be made safe by this vault. Temporary files may remain after an uncatchable termination; remove orphaned `storebase-signing-import-*` directories from your OS temporary directory securely.

Keep encrypted-vault backups and your master passphrase safe and separate. Losing the passphrase cannot be recovered by the CLI. Removing a profile or rekeying replaces the current vault but does not erase originals, old snapshots, filesystem journals, or backups; no forensic erasure is promised. The npm file allowlist contains only CLI JavaScript and documentation, never local vaults, `.env`, `.jks`, `.keystore`, `.p12`, or `.pfx` files.

## Telegram storage and versions

Each release adds an APK document, an icon document, an optional delta document, then a JSON manifest text post. The manifest is posted last, so an incomplete upload is not listed as a release. The artifacts and metadata stay in Telegram; publishing a later version does not delete older versions.

Each manifest begins with `STOREBASE_MANIFEST_V1` and includes app metadata, version, publish time, signing-certificate fingerprint, and Telegram message IDs, sizes, and SHA-256 hashes for its artifacts. StoreBase Android releases also include the package name, Android `versionCode`, and optional minimum required code. Publishing the same app/version and content is idempotent; changed content cannot overwrite an existing version.

An optional `STOREBASE_DEFAULT_VERSION_V1` message stores the default-version pointer separately, so pinning a release never edits or replaces its immutable manifest. If no explicit pin exists, the newest release is the default. Use `storebase-telegram pin <app-id> <version>` to set or change the default. The CLI list shows every version and the default; metadata and downloads without `--version` use that default.

```sh
# See all apps, versions, and each app's default version
storebase-telegram list

# Select a default version; this adds a small metadata record in Telegram
storebase-telegram pin storebase 1.2.0

# Omit --version to use the pinned default (or newest release if unpinned)
storebase-telegram metadata storebase
storebase-telegram download storebase --kind apk --out ./downloads

# Select a specific historical version
storebase-telegram metadata storebase --version 1.1.0
storebase-telegram download storebase --version 1.1.0 --kind all --out ./downloads
```

Downloads are size- and SHA-256-verified. Filenames include the app ID, version, artifact kind, and content hash to avoid replacing a different release.

## Development

```sh
cd cli
npm test
```
