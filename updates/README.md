# StoreBase Android updates (Telegram)

After the one-time settings bootstrap, update checks use the existing direct Telegram client and the versioned StoreBase manifests in the configured Telegram channel. The gateway is not used for update metadata or bytes.

## Stage a delta locally

Build a higher-version signed APK, then create a patch against the preceding APK:

```sh
python3 tools/create_update_release.py \
  --apk delivery/StoreBase-updater-debug.apk \
  --version-code 2 \
  --version-name 1.1.0 \
  --base-apk delivery/StoreBase-direct-telegram-debug.apk \
  --base-version-code 1
```

The helper writes a gzip-compressed `.sbd` patch only when it is smaller than the new APK, and verifies the patch can reconstruct the APK byte-for-byte. Keep both the full APK and patch locally for the publisher.

## Publish to Telegram (manual release step)

`storebase-publish` uploads the signed APK, optional delta, and icon as Telegram channel documents, verifies each artifact hash, then posts the versioned manifest last. For the StoreBase app, supply the new Android version code and the patch's exact base code, for example:

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

This task stages files and code locally; it does **not** publish to Telegram or deploy the gateway.

## Client behavior

On startup and on foreground return after six hours, the app fetches the current versioned Telegram release metadata directly. It downloads a matching, smaller delta directly from Telegram, reconstructs the APK from the installed base, and verifies the APK hash, package ID, version, and Android signing continuity. If there is no matching/smaller delta, it downloads the full APK directly from Telegram. Android still requires the user to approve sideloaded installation; StoreBase attempts to reopen after package replacement, subject to Android's background-launch restrictions.
