const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STOREBASE_APP_ID = 'storebase';
const STOREBASE_PACKAGE = 'com.nexuss0781.storebase';

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = bytes / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(amount)} ${units[unit]}`;
}

export function initializeUpdateManager(nativeUpdateCall) {
  const dialog = document.getElementById('update-dialog');
  const title = document.getElementById('update-title');
  const message = document.getElementById('update-message');
  const install = document.getElementById('update-install');
  const later = document.getElementById('update-later');
  if (!dialog || !title || !message || !install || !later) return;

  let lastCheckAt = 0;
  let isRequired = false;
  let permissionPending = false;
  let checking = false;
  let pendingUpdate = null;
  let stagedArtifact = null;

  const discardPending = () => {
    if (!isRequired) {
      pendingUpdate = null;
      stagedArtifact = null;
      permissionPending = false;
    }
    if (dialog.open) dialog.close();
  };

  async function readLatestUpdate(forceRefresh) {
    const telegram = window.storeBaseTelegram;
    if (!telegram) return null;
    if (forceRefresh) await telegram.refreshCatalog();
    else await window.storeBaseTelegramReady;

    const release = await telegram.getRelease(STOREBASE_APP_ID);
    const manifest = release?.manifest;
    const android = manifest?.androidUpdate;
    if (!manifest || !android || android.packageName !== STOREBASE_PACKAGE) return null;

    const installed = await nativeUpdateCall('getInstalledVersion');
    if (installed?.packageName !== STOREBASE_PACKAGE
        || !Number.isSafeInteger(Number(installed.versionCode))) return null;
    const installedVersionCode = Number(installed.versionCode);
    if (android.versionCode <= installedVersionCode) return null;

    const apk = manifest.artifacts?.apk;
    if (!apk || !Number.isSafeInteger(Number(apk.size)) || !/^[a-f\d]{64}$/i.test(apk.sha256 || '')) return null;
    const delta = manifest.artifacts?.delta;
    const useDelta = Boolean(delta
      && delta.fromVersionCode === installedVersionCode
      && delta.size < apk.size);
    const artifact = useDelta ? delta : apk;
    return {
      release,
      manifest,
      android,
      installedVersionCode,
      artifact,
      artifactKind: useDelta ? 'delta' : 'apk',
      required: android.minimumVersionCode > installedVersionCode,
    };
  }

  async function checkForUpdate(forceRefresh = false) {
    if (checking || document.visibilityState === 'hidden') return;
    checking = true;
    lastCheckAt = Date.now();
    try {
      const candidate = await readLatestUpdate(forceRefresh);
      if (!candidate) {
        pendingUpdate = null;
        stagedArtifact = null;
        isRequired = false;
        later.hidden = false;
        if (dialog.open) dialog.close();
        return;
      }
      pendingUpdate = candidate;
      stagedArtifact = null;
      isRequired = candidate.required;
      const isPatch = candidate.artifactKind === 'delta';
      title.textContent = isRequired ? 'Important update required' : 'Update available';
      const releaseNotes = candidate.manifest.releaseNotes ? ` ${candidate.manifest.releaseNotes}` : '';
      message.textContent = `StoreBase ${candidate.manifest.version} is available. ${isPatch ? 'Small patch' : 'Full upgrade'} — ${formatBytes(candidate.artifact.size)} from Telegram.${releaseNotes}`;
      install.textContent = 'Install update';
      later.hidden = isRequired;
      if (!dialog.open) dialog.showModal();
    } catch {
      // Telegram update checks are best-effort and do not interrupt normal app startup.
    } finally {
      checking = false;
    }
  }

  async function installPendingUpdate() {
    if (!pendingUpdate) throw new Error('The selected Telegram release is no longer available.');
    if (!stagedArtifact) {
      stagedArtifact = await window.storeBaseTelegram.downloadArtifact(
        STOREBASE_APP_ID,
        pendingUpdate.manifest.version,
        pendingUpdate.artifactKind,
        { storage: 'updates' },
      );
    }
    const delta = pendingUpdate.artifactKind === 'delta';
    return nativeUpdateCall('installUpdate', {
      artifactPath: stagedArtifact.path,
      artifactSize: pendingUpdate.artifact.size,
      artifactSha256: pendingUpdate.artifact.sha256,
      type: delta ? 'delta' : 'apk',
      baseVersionCode: delta ? pendingUpdate.artifact.fromVersionCode : 0,
      apkSize: pendingUpdate.manifest.artifacts.apk.size,
      apkSha256: pendingUpdate.manifest.artifacts.apk.sha256,
      versionCode: pendingUpdate.android.versionCode,
      versionName: pendingUpdate.manifest.version,
    });
  }

  install.addEventListener('click', async () => {
    install.disabled = true;
    install.textContent = permissionPending ? 'Opening installer…' : 'Downloading from Telegram…';
    message.textContent = 'Downloading and verifying the Telegram artifact. Your installed app will remain unchanged unless Android completes installation.';
    try {
      const result = await installPendingUpdate();
      if (result?.needsPermission) {
        permissionPending = true;
        install.disabled = false;
        install.textContent = 'Continue installation';
        message.textContent = 'Android opened Install unknown apps settings. Allow StoreBase there, return here, then tap Continue installation.';
        return;
      }
      if (result?.installerLaunched) {
        permissionPending = false;
        install.disabled = false;
        install.textContent = 'Installer opened';
        message.textContent = 'Approve the update in Android’s installer. Android will attempt to reopen StoreBase after installation; if it does not, tap Open in the installer or launch StoreBase normally.';
        return;
      }
      if (!result?.available) {
        pendingUpdate = null;
        stagedArtifact = null;
        if (dialog.open) dialog.close();
        return;
      }
      install.disabled = false;
      install.textContent = 'Install update';
    } catch {
      install.disabled = false;
      install.textContent = 'Try again';
      message.textContent = 'The update could not be downloaded from Telegram or verified. Your current StoreBase installation is unchanged. Check your connection and try again.';
    }
  });

  later.addEventListener('click', discardPending);
  dialog.addEventListener('cancel', (event) => {
    if (isRequired) event.preventDefault();
    else discardPending();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheckAt >= CHECK_INTERVAL_MS) {
      void checkForUpdate(true);
    }
  });

  void checkForUpdate(false);
}
