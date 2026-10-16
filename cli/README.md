# StoreBase App Publisher CLI

A dependency-free npm CLI for validating and releasing a signed Android APK into a local StoreBase app-list catalog. This package is intentionally isolated under `cli/`; it does not change the StoreBase frontend.

## Requirements

- Node.js 18 or newer
- Java `keytool`
- Android SDK Build Tools `apksigner` (on `PATH`, or under `$ANDROID_SDK_ROOT/build-tools/` or `$ANDROID_HOME/build-tools/`)

## Install from this repository

```sh
npm install --global ./cli
storebase-publish
```

The CLI prompts for the app name, avatar image, version, APK, category, description, and signing keystore. The supported categories match StoreBase Explore:

- Education
- Social
- Productivity
- Communication
- Entertainment
- Games
- Business
- Shopping
- Finance
- Utilities
- Health & Fitness
- Travel & Navigation
- AI & Machine Learning

The keystore password is requested with hidden terminal input. For automation, set `STOREBASE_KEYSTORE_PASSWORD` in the process environment instead. **Do not put the password in a command-line argument.** If the keystore contains more than one private-key alias, the CLI asks which alias to use (or accepts `--alias`).

The CLI runs `keytool` and `apksigner`, and refuses to add the release unless the APK is signed and its signer certificate matches the selected private-key certificate in the provided keystore. The password is written briefly to a mode-0600 temporary file for `keytool`, then the file is overwritten best-effort and removed. The keystore itself is never copied to the catalog.

## Non-interactive example

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

Available options: `--name`, `--avatar`, `--version`, `--apk`, `--category`, `--description`, `--keystore`, `--alias`, `--catalog`, `--assets-dir`, and `--help`.

## Output

By default, running from a project directory creates or updates:

- `storebase-app-list.json` — schema version 1, with one latest-version listing per app name/slug.
- `storebase-app-assets/<app-id>/<version>/` — content-addressed APK and avatar files referenced by the JSON manifest.

The catalog entry contains the app name, avatar path, version, APK path, category, description, the public SHA-256 signing-certificate fingerprint, and publish timestamp. Releasing the same app again updates its catalog entry; a different version gets a separate artifact path. The previous artifacts are not removed.

The current StoreBase repository has no app-list API or deployment endpoint. Therefore this CLI creates a **local app-list release artifact only**; it does not upload to a server, publish the npm package, or make the app appear in the existing UI yet. A later frontend/backend change can consume `storebase-app-list.json` without changing this CLI's input contract.

## Development

```sh
cd cli
npm test
```
