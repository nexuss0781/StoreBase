---
name: storebase
description: Operate StoreBase end to end. Use when installing or using storebase-cli, managing encrypted signing-keystore profiles, publishing signed Android APKs and icons to Telegram, listing or downloading immutable releases, pinning default versions, configuring the encrypted gateway or local Wasmer deployment, building the Apps/Explore Android frontend, or preparing and testing StoreBase incremental/full APK updates.
---

# StoreBase

## Start here

1. Identify the outcome: read a catalog, manage signing profiles, publish an approved app, operate a gateway, build Android, or release CLI software.
2. Read [CLI workflows](references/cli-workflows.md) for exact command syntax, configuration, signing, publishing, catalog operations, and troubleshooting.
3. Read [Runtime and Android](references/runtime-and-android.md) before gateway deployment, bootstrap changes, direct Telegram operations, or frontend work.
4. Read [Updates and development](references/updates-and-development.md) before patch generation, Android self-updates, source builds, or release testing.
5. Use the installed CLI's `--help` as the final authority when versions differ. Do not invent commands for unimplemented features.

Resolve references relative to this `SKILL.md`, not a fixed installation path. Install with `npm install --global storebase-cli`. Locate this skill with `storebase-skill path`; copy it into an agent's chosen skills root with `storebase-skill install --dir <skills-root>`. This copies files only; enable or reload the skill using that agent's own mechanism when required.

## Keep the architecture straight

- Treat the npm CLI release, an Android APK release, and a gateway deployment as separate operations with separate authorization.
- Use the gateway only to bootstrap encrypted runtime settings. Publish APKs, icons, optional deltas, immutable manifests, and default-version records directly to Telegram.
- Use the bot session for writes and a separate personal-user session for history reads. Catalog reads do not require the publisher key.
- Distinguish `--telegram-config local` (direct Telegram environment configuration) from `--storage local` (legacy local JSON/files storage).
- Distinguish signing profiles from signing itself. StoreBase **verifies already-signed APKs; it never signs or re-signs them**.
- Distinguish Apps/Explore demo listings from the Telegram-backed StoreBase self-updater. Do not promise a fully wired dynamic marketplace or general app installer where controls are only demo UI.

## Follow the common end-to-end flow

### First-time approved publisher

1. Install Node.js, Java `keytool`, Android SDK Build Tools `apksigner`, and the CLI; inspect command help.
2. Confirm owner approval for the exact APK release and metadata. Collect a signed APK, PNG/JPEG/WebP icon, stable app name, unique version, supported category, description, and matching keystore or existing profile.
3. Select gateway mode (default). Supply the publisher token through a secret manager/runtime environment or hidden prompt, never an argument. Do not ask for Telegram credentials if the configured gateway can supply them.
4. Import a named profile once with `storebase-keystore import`. Unlock the vault interactively; never put profile passwords/passphrases in arguments, environment variables, or files.
5. Run `storebase-publish --signing-profile <profile>` with app metadata. For StoreBase itself, include an increasing Android version code. Inspect actual success/failure rather than assuming an upload succeeded.
6. Verify with `storebase-telegram list`, `metadata <app-id> --version <version>`, and download into a chosen directory. Check version, certificate, artifact hashes/sizes, and message IDs.
7. Pin the approved version if it should be default; verify without `--version`. Preserve older immutable releases.
8. Report the app ID/version, new versus idempotent publication, manifest ID, verification results, and default state. Never return credentials.

### Routine app update

1. Preserve stable app identity and a compatible signer. Increment the release version; increment Android `versionCode` for StoreBase self-updates.
2. Build and sign outside the publisher. Reuse the matching profile, not an unrelated replacement key.
3. For StoreBase only, optionally prepare an `.sbd` patch from the exact installed base APK to the exact signed target APK; always keep the full APK fallback.
4. Publish a new immutable release, download/verify it, then change the default pointer if authorized.
5. Test a real Android device: unknown-source permission, system install approval, signer/version acceptance, and reopening. Do not promise silent installation or guaranteed foreground relaunch.

### Read/download only

1. Install the CLI and use default gateway mode; do not request a publisher token.
2. Run `storebase-telegram list`; use its app ID rather than an Android package name.
3. Inspect metadata, then download the default or explicit historical release. Downloads verify size and SHA-256.
4. Do not pin or publish during a read-only task.

### Keystore maintenance

1. List profiles and compare public fingerprints.
2. Import a new name for a separate key; use `import <profile> ... --replace` only for approved replacement.
3. Use `rekey` to change the vault master passphrase, not Android signing identity.
4. Securely back up the encrypted vault and original signing material before replacing/removing anything. Read the vault warnings in the CLI reference.
5. Preserve Android compatibility: profile replacement does not create signing lineage.

### Gateway, frontend, and source work

1. Read both runtime/development references before deployment or Android settings changes.
2. Keep secrets server-side and separate reader/publisher bootstrap. Verify `/api/v1/health` and encrypted bootstrap behavior without logging decrypted settings.
3. Build frontend assets before Android sync; preserve native plugins and manifest permissions.
4. Use local Wasmer deployment only when requested, never just to demonstrate this skill.
5. Test device behavior separately from unit tests; distinguish demo controls from working updater functionality.

## Protect secrets and release boundaries

- Never put `.env`, tokens, Telegram sessions, vaults, keystores, private keys, APKs, generated patches, or local credential files in Git/npm. Use documentation placeholders only.
- Restrict publisher keys and read sessions. Encrypted bootstrap is not production identity, device attestation, or protection against a compromised client.
- Never print decrypted Telegram settings or copy them into Android assets, frontend bundles, release metadata, shell history, diagnostics, or chat.
- Obtain owner approval before publishing third-party APKs; pending builds are not approval. Leave any unapproved SnapBase APK unpublished.
- Stop on signer mismatch, immutable-version conflict, failed integrity check, or ambiguous publication. Inspect existing releases before retrying.
- Never delete artifacts or rewrite manifests to fix releases; publish a new version. Pinning an old release does not make Android accept a downgrade.
- Report only verified outcomes. Unit tests do not prove device installation/relaunch; publishing a skill to npm/Git does not activate it automatically in every agent.

## Release this CLI and skill

1. Inspect all non-secret project changes and the target branch. Keep the skill in `cli/skills/storebase/` and its install command in `cli/bin/`.
2. Validate skill frontmatter when a validator is available; run root `npm test`, `npm run build`, and CLI package/install tests.
3. Bump public CLI package and lockfile together. Inspect `npm pack --dry-run --json --ignore-scripts`; permit only CLI JavaScript, README/package metadata, and explicitly listed skill Markdown files.
4. Test the exact tarball with an isolated install, `storebase-skill path`, `install`, and command help. Publish that inspected tarball with a runtime npm credential, never a repository token file.
5. Commit approved non-secret source/docs, push the intended branch, and verify GitHub commit and npm version. Do not publish APKs or deploy a gateway as side effects.
6. Return npm version, commit/link, skill location/install commands, passing tests, and any untested platforms or blockers.
