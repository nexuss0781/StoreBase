# CLI workflows

## Install and inspect

Use Node.js 18+ for the published CLI. Use Java 21+ `keytool` and Android SDK Build Tools `apksigner` for signing verification/import. Node 22.12+ or another version supported by Vite 8 is needed for the frontend source build; do not confuse that with the CLI's Node 18 floor.

```sh
npm install --global storebase-cli
storebase-publish --help
storebase-keystore --help
storebase-telegram --help
storebase-skill --help
storebase-skill path
storebase-skill install --dir ./agent-skills
```

`path` prints the installed `SKILL.md` path. `install --dir` treats the argument as a skills **root**, creates its `storebase` child, and refuses an existing destination. Choose the real root supported by the target agent; the command does not edit agent settings or activate skills. To update an existing copy, review/back it up and remove or move it explicitly before installing again. Global npm upgrades update the bundled skill, not separate copies.

For this source checkout use `npm ci` inside `cli/`, `npm test`, and optionally `npm install --global ./cli` from the repository root. Use quoted paths for spaces. Command examples below use POSIX line continuations; in PowerShell put each command on one line (or use PowerShell's backtick continuation). Profile prompts require a real interactive terminal.

## Choose configuration and authority

| Operation | Gateway default | Credentials on CLI side |
| --- | --- | --- |
| `list`, `metadata`, `download` | Encrypted reader bootstrap | No publisher token |
| `storebase-publish`, `pin` | Token-protected publisher bootstrap | Publisher token via hidden prompt or runtime environment |
| `--telegram-config local` reads | No gateway | API ID/hash, personal read session, channel |
| `--telegram-config local` writes | No gateway | API ID/hash, bot session (or initial bot token), personal read session, channel |
| `--storage local` publish | No Telegram storage | Signing input; writes local catalog/assets |

Use `STOREBASE_GATEWAY_URL` to override the default `https://storebase.wasmer.app`. Keep `STOREBASE_GATEWAY_PUBLISH_TOKEN` identical to the gateway secret. It must be a high-entropy value accepted by the gateway; use at least 32 URL-safe characters. Prefer a secret manager injecting environment values. Interactive write commands request a missing key without echo; non-interactive writes require it in the environment. Never put it in CLI arguments, output, source, or npm configuration.

For direct Telegram mode supply these **runtime environment** values:

- `STOREBASE_TELEGRAM_API_ID`: positive numeric Telegram app ID.
- `STOREBASE_TELEGRAM_API_HASH`: Telegram app hash.
- `STOREBASE_TELEGRAM_READ_SESSION`: authorized personal-user MTProto StringSession with channel read access; a bot cannot read history.
- `STOREBASE_TELEGRAM_CHANNEL`: broadcast channel username or ID.
- For writes, `STOREBASE_TELEGRAM_SESSION`: authorized admin-bot MTProto StringSession; alternatively `STOREBASE_TELEGRAM_BOT_TOKEN` can authorize a bot initially in local mode.

The bot must be channel administrator with posting permission. Reader and bot must resolve the same broadcast channel. A gateway deployment needs pre-provisioned bot and reader sessions; there is no `storebase login` or session-export CLI command. Provision them privately through trusted Telegram tooling, not repository files. The encrypted publisher envelope does not include the bot token or publisher token. The reader envelope excludes the bot session.

`dotenv` loads a current-directory `.env` for legacy/runtime configuration; do not print or commit it. Never save profile passphrases/signing passwords in it. Separate shell sessions are safer than switching production and local credentials in the same shell.

## Import and reuse a signing profile

```sh
storebase-keystore import release --file "/secure/path/release.jks" --alias release
storebase-keystore list
storebase-keystore location
```

Import requests: a new vault passphrase (at least 12 characters, confirmed) or existing vault passphrase, keystore password, and private-key password. Enter at the private-key prompt to reuse the store password. Specify `--alias` when multiple private keys exist. Import validates keystore and private-key access with Java and copies the keystore into the encrypted vault; the original path need not remain available. Never upload the keystore.

Use a profile explicitly with `--signing-profile release`. Profiles are not automatically associated with an app/tag and there is no automatic default. Profile publishing verifies the APK's public signer certificate without extracting the stored private key. It cannot be combined with `--keystore` or `--alias`.

All profile operations except `location` need hidden interactive input. Do not pipe passphrases, invent password flags, set environment passwords for profile operations, or promise unattended profile publishing. For an explicitly approved non-interactive one-off workflow, the legacy `--keystore` path supports `STOREBASE_KEYSTORE_PASSWORD` at runtime; it still never signs an APK.

### Replace, rotate, rekey, remove

```sh
storebase-keystore import release --file "/secure/path/replacement.jks" --alias release --replace
storebase-keystore rekey
storebase-keystore remove release
```

`--replace` requires an existing profile and typed `REPLACE release`; failed validation leaves the existing entry intact. Use replacement to update stored passwords or validated signing material. `rekey` unlocks with the old vault passphrase and asks for a new confirmed passphrase; it re-encrypts every profile without changing the keystore passwords or signing identity. `remove` requires typed `REMOVE release` and deletes only the current vault entry, not original files or backups.

Do not conflate these operations with Android key rotation: no signing lineage, APK re-signing, or Play App Signing migration is generated. A genuinely different certificate may prevent upgrades for existing users. Keep old key backups before replacing anything.

### Vault protection and recovery

Use `location` rather than guessing the path. Defaults:

- Linux: `~/.local/share/storebase-cli/signing-vault.json`.
- macOS: `~/Library/Application Support/storebase-cli/signing-vault.json`.
- Windows: `~/AppData/Local/storebase-cli/signing-vault.json`.

The vault lives outside the project and npm install directory, uses AES-256-GCM and scrypt (N=32768, r=8, p=1), and gets a fresh salt/nonce on write. Its contents include keystore bytes, passwords, alias and certificate. The master passphrase is never saved, and there is no recovery service or OS-keychain unlock. Keep encrypted backups and the passphrase separately. Writes are atomic/locked; POSIX requires private ownership/permissions (directory 0700, files 0600), rejecting unsafe or symlink paths. Restrict Windows user-data ACLs yourself.

Import uses a private temporary keystore copy for Java, removed and overwritten best-effort in cleanup. Java receives passwords in its child environment, not arguments/files. Abrupt termination may leave `storebase-signing-import-*` temporary directories; remove orphans securely. Encryption does not protect against compromised user processes, privileged memory inspection, swap, or all JS string copies. Removal/rekey do not erase old backups, journals, or snapshots.

## Publish an ordinary Android app

First obtain approval for this exact release. Build and sign it with the application's own build system; StoreBase does not provide a signing command.

```sh
storebase-publish --name "Example App" --avatar ./icon.png --version 1.0.0 --apk ./app-release.apk --category Productivity --description "A useful offline tool." --signing-profile release
```

One-off alternative: replace `--signing-profile release` with `--keystore /secure/path/release.jks --alias release`. Enter the store password at its hidden prompt (or inject the legacy runtime password variable for an authorized unattended run).

Input rules:

- Name: nonempty, at most 100 characters. The normalized lowercase name creates the catalog app ID (`Example App` → `example-app`), not the Android package name. Preserve it across releases; conflicting names with the same slug are refused.
- Version: 1–64 characters, starting with a letter/digit; subsequent letters/digits, `.`, `+`, `_`, `-` are allowed. It need not be semantic versioning.
- Icon (`--avatar`): actual PNG, JPEG, or WebP bytes, not just a renamed extension.
- APK: nonempty `.apk` with APK/ZIP header and valid signature accepted by `apksigner`.
- Description: nonempty, at most 1,000 characters; total manifest also must fit Telegram's 4,096-character message limit.
- Category: case-insensitive match to Education, Social, Productivity, Communication, Entertainment, Games, Business, Shopping, Finance, Utilities, Health & Fitness, Travel & Navigation, or AI & Machine Learning. Quote multiword categories.

Missing required app details prompt interactively; non-interactive runs must supply all. `keytool` inspects the selected private-key certificate and `apksigner verify --verbose --print-certs` must find a matching APK signer. A mismatch fails without catalog publication. This proves certificate matching, not ownership approval, malware safety, or the app's full runtime behavior.

### What publishing writes

The CLI uploads APK, icon, optional delta, and finally the `STOREBASE_MANIFEST_V1` JSON text message. The manifest is the release visibility boundary: interrupted uploads may leave orphan documents but are not listed as releases without a valid manifest. Store app metadata, signing-certificate SHA-256, timestamps, artifact message IDs, sizes and SHA-256 hashes. Never upload a keystore/password.

An identical app/version, metadata, signer and artifact content returns an idempotent existing release. Changed content under that version is rejected; publish a new version. Older manifests/artifacts remain. Newest means publish timestamp (message ID breaks ties), not highest semantic version. Inspect before retrying an ambiguous failure.

### StoreBase self-update release

Only the `storebase` app ID supports updater metadata and `.sbd` deltas. Supply the real APK version code, higher than every previously published StoreBase release. Optional minimum code must be nonnegative and no higher than target code. The code is supplied metadata; separately confirm it matches the APK/build.

```sh
storebase-publish --name StoreBase --avatar ./storebase-icon.png --version 2.0.0 --apk /secure/releases/StoreBase-release.apk --android-version-code 20 --category Utilities --description "Approved StoreBase update." --signing-profile storebase-release
```

Optionally append `--minimum-android-version-code 10` and/or `--delta /secure/releases/base-to-target.sbd --delta-base-version-code 19`. A delta requires a lower positive base code, correct gzip `.sbd` format, and the exact signed target APK. Follow the updates reference; publishing does not validate every native patch operation or infer the actual APK version code. Do not use these flags for ordinary third-party apps.

## List, inspect, pin and download

```sh
storebase-telegram list
storebase-telegram metadata example-app
storebase-telegram metadata example-app --version 1.0.0
storebase-telegram download example-app --kind apk --out ./downloads
storebase-telegram download example-app --version 1.0.0 --kind all --out ./downloads
storebase-telegram pin example-app 1.0.0
storebase-telegram metadata example-app
```

`list` prints JSON app IDs/names/categories, all versions, default version and whether pinned. `metadata` prints the selected manifest/message ID and current default. Reads use reader credentials only. `pin` requires write authority and an already existing exact release version. It appends a separate `STOREBASE_DEFAULT_VERSION_V1` record, never edits a manifest, and is idempotent for an already pinned target. There is no unpin/delete command. To choose a newer version later, pin it explicitly.

Omitting `--version` selects the latest pin, else the newest published release. Publishing a new release does not override an existing pin. A dangling pin to a missing release is an error. CLI pinning is a catalog pointer, not a Telegram UI pinned message, Android downgrade permission, or deletion of other releases.

Download kinds are `apk`, `avatar`, `delta`, `all` (default). Output defaults to `./storebase-downloads`. `all` includes an optional delta only when present; requesting a missing delta errors. Content-addressed filenames include app ID/version/kind/hash. Size and SHA-256 mismatches fail and remove the invalid output. These catalog hashes are integrity checks against the channel manifest, not independent signatures from a trusted authority.

For a local runtime Telegram environment append `--telegram-config local` to any catalog command or publisher command. Do not pass gateway credentials to a command that does not need them.

## Legacy local files mode

```sh
storebase-publish --storage local --name "Example App" --avatar ./icon.png --version 1.0.0 --apk ./app-release.apk --category Productivity --description "Local test release." --signing-profile release --catalog /private/output/catalog.json --assets-dir /private/output/assets
```

Local mode performs the same APK certificate matching but writes JSON/files, not Telegram. Defaults are `storebase-app-list.json` and `storebase-app-assets` under the working directory. The catalog keeps one current record per app ID; content-addressed older artifact files may remain. This is **not** Telegram's immutable version-history/pin model, and catalog commands do not read this JSON. StoreBase Android version metadata/deltas are rejected in local storage mode. Keep generated APK/assets/catalog output outside Git and npm.

## Complete option checklist

- `storebase-publish`: `--name`, `--avatar`, `--version`, `--apk`, `--category`, `--description`, `--signing-profile` OR `--keystore`/`--alias`, `--storage telegram|local`, `--telegram-config gateway|local`, `--catalog`, `--assets-dir`, `--android-version-code`, `--minimum-android-version-code`, `--delta`, `--delta-base-version-code`, `--help`/`-h`.
- `storebase-keystore`: `import <profile> --file <keystore> [--alias <alias>] [--replace]`, `list`, `location`, `rekey`, `remove <profile>`, `--help`/`-h`. No password flags.
- `storebase-telegram`: `list`; `metadata <app-id> [--version <version>]`; `download <app-id> [--version <version>] [--kind apk|avatar|delta|all] [--out <directory>]`; `pin <app-id> <version>`. All accept `--telegram-config gateway|local`; top-level `--help`/`-h` shows usage.
- `storebase-skill`: `path`, `install --dir <skills-root>`, `--help`/`-h`.

## Troubleshoot in order

| Symptom | Action |
| --- | --- |
| Missing options or prompts unavailable | Use a TTY for profile operations; provide all nonsecret app flags for unattended one-off runs. |
| Gateway publisher authentication failure | Check runtime key and gateway secret match; never dump either. Reads do not need that key. |
| Reader cannot load history | Use an authorized personal-user session with channel access, not a bot session. |
| Bot cannot post | Check admin/post rights and broadcast channel identity; confirm both sessions resolve the same channel. |
| `keytool`/`apksigner` missing | Install Java/SDK tools; expose PATH or `ANDROID_SDK_ROOT`/`ANDROID_HOME`. Native Windows apksigner discovery is not validated by this release; do not claim full Windows publishing support. |
| Signer mismatch | Use the actual matching signing profile and correctly signed APK; never bypass verification or rotate a profile merely to silence it. |
| Wrong vault passphrase/corrupted vault | Retry correct passphrase or restore a known-good encrypted backup; there is no reset/recovery command. |
| Unsafe permissions/symlink/lock | Inspect user-data ownership and legitimate running processes; do not disable vault protections or blindly delete active locks. |
| Same version changed content | Increment version; do not overwrite immutable Telegram metadata. |
| Unexpected default after new publication | Inspect pin; explicitly pin approved new target if desired. |
| Hash/size mismatch | Stop, inspect source artifact/manifest and network outcome; do not install the bad file. |
| Delta unavailable or base mismatch | Use full APK fallback; regenerate from the exact installed base if preparing a release. |
| Existing skill destination | Review/move/back up the existing copy, then install; installer refuses overwrites. |
