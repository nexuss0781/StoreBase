package com.nexuss0781.storebase;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;
import org.json.JSONObject;

@CapacitorPlugin(name = "StoreBaseUpdate")
public class StoreBaseUpdatePlugin extends Plugin {
    private static final String APP_ID = "com.nexuss0781.storebase";
    private static final long MAX_ARTIFACT_BYTES = 256L * 1024L * 1024L;
    private static final long MAX_APK_BYTES = 1024L * 1024L * 1024L;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void getInstalledVersion(PluginCall call) {
        executor.execute(() -> {
            try {
                PackageInfo info = getContext().getPackageManager().getPackageInfo(APP_ID, 0);
                JSObject result = new JSObject();
                result.put("packageName", APP_ID);
                result.put("versionCode", packageVersionCode(info));
                result.put("versionName", info.versionName == null ? "" : info.versionName);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("StoreBase could not read its installed version.");
            }
        });
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        executor.execute(() -> {
            try {
                String type = call.getString("type");
                String artifactPath = call.getString("artifactPath");
                String artifactSha256 = call.getString("artifactSha256");
                Long artifactSizeValue = call.getLong("artifactSize");
                Long apkSizeValue = call.getLong("apkSize");
                String apkSha256 = call.getString("apkSha256");
                Long versionCodeValue = call.getLong("versionCode");
                String versionName = call.getString("versionName");
                Long baseVersionCodeValue = call.getLong("baseVersionCode", 0L);
                long artifactSize = artifactSizeValue == null ? 0L : artifactSizeValue;
                long apkSize = apkSizeValue == null ? 0L : apkSizeValue;
                long targetVersionCode = versionCodeValue == null ? 0L : versionCodeValue;
                long baseVersionCode = baseVersionCodeValue == null ? 0L : baseVersionCodeValue;
                boolean isDelta = "delta".equals(type);
                if ((!isDelta && !"apk".equals(type)) || artifactPath == null
                        || !isSha256(artifactSha256) || !isSha256(apkSha256)
                        || artifactSize <= 0 || artifactSize > (isDelta ? MAX_ARTIFACT_BYTES : MAX_APK_BYTES)
                        || apkSize <= 0 || apkSize > MAX_APK_BYTES
                        || targetVersionCode <= 0 || targetVersionCode > Integer.MAX_VALUE
                        || versionName == null || versionName.isEmpty() || versionName.length() > 64
                        || (isDelta && (baseVersionCode <= 0 || baseVersionCode >= targetVersionCode))) {
                    throw new SecurityException("Invalid Telegram release metadata.");
                }

                PackageManager manager = getContext().getPackageManager();
                PackageInfo installed = manager.getPackageInfo(APP_ID, 0);
                long installedVersionCode = packageVersionCode(installed);
                if (targetVersionCode <= installedVersionCode) {
                    JSObject result = new JSObject();
                    result.put("available", false);
                    call.resolve(result);
                    return;
                }
                if (isDelta && installedVersionCode != baseVersionCode) {
                    throw new SecurityException("Telegram delta does not match the installed StoreBase version.");
                }

                File artifact = resolveUpdateFile(artifactPath);
                if (artifact.length() != artifactSize || !artifactSha256.equalsIgnoreCase(sha256File(artifact))) {
                    throw new SecurityException("Telegram artifact does not match its versioned manifest.");
                }

                File stagedApk;
                if (isDelta) {
                    File updatesDirectory = updatesDirectory();
                    stagedApk = new File(updatesDirectory, "StoreBase-v" + targetVersionCode + "-"
                            + apkSha256.substring(0, 12) + ".apk");
                    applyDelta(new File(installed.applicationInfo.sourceDir), artifact, stagedApk, apkSize);
                    if (!apkSha256.equalsIgnoreCase(sha256File(stagedApk))) {
                        stagedApk.delete();
                        throw new SecurityException("Reconstructed Telegram update APK failed integrity verification.");
                    }
                } else {
                    if (artifactSize != apkSize || !artifactSha256.equalsIgnoreCase(apkSha256)) {
                        throw new SecurityException("Full Telegram APK metadata is inconsistent.");
                    }
                    stagedApk = artifact;
                }
                verifyApkPackage(stagedApk, targetVersionCode, versionName);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        && !manager.canRequestPackageInstalls()) {
                    Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + getContext().getPackageName()));
                    settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getActivity().runOnUiThread(() -> getActivity().startActivity(settings));
                    JSObject result = new JSObject();
                    result.put("available", true);
                    result.put("needsPermission", true);
                    result.put("versionName", versionName);
                    result.put("type", isDelta ? "update" : "upgrade");
                    call.resolve(result);
                    return;
                }

                Uri apkUri = FileProvider.getUriForFile(getContext(), APP_ID + ".fileprovider", stagedApk);
                Intent installer = new Intent(Intent.ACTION_VIEW);
                installer.setDataAndType(apkUri, "application/vnd.android.package-archive");
                installer.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().runOnUiThread(() -> {
                    try {
                        getActivity().startActivity(installer);
                        JSObject result = new JSObject();
                        result.put("available", true);
                        result.put("installerLaunched", true);
                        result.put("versionName", versionName);
                        result.put("type", isDelta ? "update" : "upgrade");
                        call.resolve(result);
                    } catch (Exception error) {
                        call.reject("Android could not open the update installer.");
                    }
                });
            } catch (Exception error) {
                call.reject("StoreBase could not prepare the Telegram update. Your installed app has not been changed.");
            }
        });
    }

    private File updatesDirectory() throws Exception {
        File directory = new File(getContext().getFilesDir(), "updates");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("Private update storage is unavailable.");
        return directory.getCanonicalFile();
    }

    private File resolveUpdateFile(String suppliedPath) throws Exception {
        File directory = updatesDirectory();
        File candidate = new File(suppliedPath).getCanonicalFile();
        String root = directory.getCanonicalPath() + File.separator;
        if (!candidate.getPath().startsWith(root) || !candidate.isFile()) {
            throw new SecurityException("Telegram update artifact is outside private app storage.");
        }
        return candidate;
    }

    private void applyDelta(File baseApk, File patchFile, File outputApk, long expectedOutputSize) throws Exception {
        if (!baseApk.isFile() || expectedOutputSize <= 0 || expectedOutputSize > MAX_APK_BYTES) {
            throw new SecurityException("Invalid installed APK or update size.");
        }
        File temporary = new File(outputApk.getParentFile(), "." + outputApk.getName() + ".part");
        long written = 0;
        try (DataInputStream patch = new DataInputStream(new GZIPInputStream(
                     new BufferedInputStream(new FileInputStream(patchFile))));
             RandomAccessFile base = new RandomAccessFile(baseApk, "r");
             FileOutputStream fileOutput = new FileOutputStream(temporary, false);
             OutputStream output = new BufferedOutputStream(fileOutput)) {
            byte[] magic = new byte[4];
            patch.readFully(magic);
            if (!Arrays.equals(magic, new byte[] { 'S', 'B', 'D', '1' }) || patch.readLong() != expectedOutputSize) {
                throw new SecurityException("Unsupported or mismatched Telegram delta.");
            }
            byte[] buffer = new byte[64 * 1024];
            while (written < expectedOutputSize) {
                int operation = patch.readUnsignedByte();
                if (operation == 0) {
                    long offset = patch.readLong();
                    int length = patch.readInt();
                    if (offset < 0 || length <= 0 || offset > base.length() - length
                            || written + length > expectedOutputSize) throw new SecurityException("Invalid delta copy operation.");
                    base.seek(offset);
                    int remaining = length;
                    while (remaining > 0) {
                        int read = base.read(buffer, 0, Math.min(buffer.length, remaining));
                        if (read < 0) throw new SecurityException("Delta base APK is truncated.");
                        output.write(buffer, 0, read);
                        remaining -= read;
                    }
                    written += length;
                } else if (operation == 1) {
                    int length = patch.readInt();
                    if (length <= 0 || written + length > expectedOutputSize) throw new SecurityException("Invalid delta data operation.");
                    int remaining = length;
                    while (remaining > 0) {
                        int read = patch.read(buffer, 0, Math.min(buffer.length, remaining));
                        if (read < 0) throw new SecurityException("Delta data is truncated.");
                        output.write(buffer, 0, read);
                        remaining -= read;
                    }
                    written += length;
                } else {
                    throw new SecurityException("Invalid Telegram delta operation.");
                }
            }
            if (patch.read() != -1) throw new SecurityException("Telegram delta has trailing data.");
            output.flush();
            fileOutput.getFD().sync();
        } catch (Exception error) {
            temporary.delete();
            throw error;
        }
        if (outputApk.exists() && !outputApk.delete()) {
            temporary.delete();
            throw new IllegalStateException("Cannot replace reconstructed APK.");
        }
        if (!temporary.renameTo(outputApk)) {
            temporary.delete();
            throw new IllegalStateException("Cannot finalize reconstructed APK.");
        }
    }

    private void verifyApkPackage(File apkFile, long expectedVersionCode, String expectedVersionName) throws Exception {
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = getContext().getPackageManager().getPackageArchiveInfo(apkFile.getAbsolutePath(), flags);
        if (archive == null || !APP_ID.equals(archive.packageName)
                || packageVersionCode(archive) != expectedVersionCode
                || !expectedVersionName.equals(archive.versionName)) {
            throw new SecurityException("Telegram APK identity does not match its release manifest.");
        }
    }

    private long packageVersionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    private String sha256File(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        return toHex(digest.digest());
    }

    private boolean isSha256(String value) {
        return value != null && value.matches("(?i)[0-9a-f]{64}");
    }

    private String toHex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }
}
