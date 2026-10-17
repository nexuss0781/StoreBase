# StoreBase updates and development reference

## Telegram release/update flow

1. Produce a **new signed APK** and retain the previous released APK if generating a delta. The app update metadata belongs to a `storebase` release and uses package `com.nexuss0781.storebase`, a higher Android version code, and optionally `minimumVersionCode`.
2. Generate and verify a local patch (below). Keep the full APK and any smaller patch; the helper never publishes.
3. Manually publish artifacts and post the versioned manifest **last** with `storebase-publish`. The gateway does not publish automatically. The documented release command is:

```sh
storebase-publish \
  --name StoreBase --avatar delivery/storebase-icon.png \
  --version 1.1.0 --apk delivery/StoreBase-updater-debug.apk \
  --android-version-code 2 \
  --delta updates/releases/StoreBase-v1-to-v2-<hash>.sbd \
  --delta-base-version-code 1 \
  --category Utilities --description "StoreBase Android app" \
  --keystore <release-keystore>
```

Use the actual new APK, release version/code, prior base code and generated patch path; the names/values above are the example in `updates/README.md`, not a recommendation to ship a debug build or use those version numbers. Omit the two delta flags for a full-APK-only release. The publisher uploads APK, optional delta and icon as Telegram channel documents, verifies hashes, then posts the manifest. **No Telegram publish or gateway deployment is done by local staging/build checks.**

## Delta tooling: exact interfaces

### Preferred release helper

```sh
python3 tools/create_update_release.py \
  --apk NEW_SIGNED.apk \
  --version-code NEW_POSITIVE_CODE \
  --version-name NEW_VERSION_NAME \
  --base-apk PREVIOUS_RELEASED.apk \
  --base-version-code PREVIOUS_POSITIVE_CODE
```

`--apk`, `--version-code`, and `--version-name` are required. `--base-apk` and `--base-version-code` must either both be supplied or both omitted; a supplied base must exist, be non-empty, and have a positive code lower than the new code. Optional `--output-dir DIR` defaults to `updates/releases`. Without a base, it reports full-APK-only staging. With a base, it generates a deterministic gzip-compressed SBD1 copy/insert patch, applies it locally to verify byte-for-byte reconstruction, and writes a hash-named `.sbd` only if the patch is smaller than the full APK; otherwise publish only the full APK. It prints the APK path and, when applicable, patch path and SHA-256. It does not publish.

The lower-level exact interface is positional:

```sh
python3 tools/create_apk_delta.py OLD_APK NEW_APK OUTPUT_PATCH
```

It requires both APK inputs non-empty, writes the requested patch path (creating its parent directory), verifies round-trip reconstruction, and prints patch/full sizes. Unlike the release helper, it does **not** suppress a patch that is larger than the target APK; use the release helper for the supported release decision. Both scripts are source under `tools/`; tests are in `tools/test_apk_delta.py`.

The client uses a delta only if its manifest base code matches the installed version exactly and it is smaller than the APK; otherwise it downloads the full APK. Native reconstruction validates SBD1 structure, reconstructed APK size/hash, package ID and version before opening Android’s installer. Hashes prove agreement with the manifest metadata, not publisher identity by themselves. Android installer confirmation and signing rules still apply.

## Local build and checks

From the repository root, documented scripts are:

```sh
npm install
npm test
npm run build
npm run android:build
```

- `npm test` runs Node’s built-in test runner over `gateway/test/*.test.js` and `cli/test/*.test.js`, then Python `unittest` discovery for `tools/test_*.py`.
- `npm run build` copies `index.html` into `www/` and runs Vite to build `www/telegram-direct.js` and its assets.
- `npm run android:build` runs `npm run android:sync` (which builds and runs `cap sync android`) then `cd android && ./gradlew assembleDebug`. It produces a debug build, not a release-signed publishing APK.

Prerequisites evidenced by the project: Node.js/npm and installed project dependencies; Python 3 for the delta/unit tests; for Android, a working JDK/Android SDK with API 36 available and the Gradle wrapper’s configured Gradle 8.14.3 distribution (the wrapper can require network access). App min/target SDK values are 24/36. The root package does not declare a Node engine range; do not invent one. `npm test` does not run Gradle/Android instrumented tests.

For local gateway runtime, build the web assets first, then use the root `npm start` script (`node gateway/server.js`). It listens on `0.0.0.0`, using `PORT` or default `8080`, serves `www/`, and reads gateway runtime environment settings. This is a local Node run, not a Wasmer deployment. `app.yaml` contains only Wasmer App.v0 identity/package and a PostgreSQL capability; no local Wasmer deploy/run steps or gateway service entrypoint are specified in the inspected project. Do not guess a deploy command or perform deployment. Gateway configuration details and deployment/security boundary are in `gateway/README.md` and `runtime-and-android.md`.

## Common failure diagnosis

- **Release helper rejects arguments:** both base options are paired; base version is lower than the positive new version; version name matches `[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}`; APK files exist and are non-empty.
- **No `.sbd` produced:** no base supplied or the verified patch is not smaller than the APK. Publish a full APK.
- **Tests fail:** confirm Node dependencies are installed and Python 3 is available; inspect failing Node/Python tests before changing release behavior.
- **Android build fails:** check JDK, SDK/API 36, Gradle wrapper download/network, then run the documented `android:sync`/`android:build` path rather than assuming stale web assets are synced.
- **Updates do not appear:** client update checks require Android native bridge and a readable Telegram manifest for `storebase`; browser UI is only a mock shell. Check correct package/version metadata, Telegram reader access, delta `fromVersionCode`, artifact size/hash and app installer permission. The app checks on launch and foreground return after six hours; it does not poll continuously.
- **Publishing/bootstrap fails:** check gateway reader and bot session roles, channel identity, and the separately configured publisher token. Never print/copy sessions or tokens into logs or packaged artifacts.

Source trail: `updates/README.md`, `tools/create_update_release.py`, `tools/create_apk_delta.py`, `tools/test_apk_delta.py`, root `package.json`, `vite.config.mjs`, `app.yaml`, `android/variables.gradle`, and `android/gradle/wrapper/gradle-wrapper.properties`.