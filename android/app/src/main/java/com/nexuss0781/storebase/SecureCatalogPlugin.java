package com.nexuss0781.storebase;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.os.Environment;
import android.util.Base64;
import androidx.core.util.AtomicFile;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.spec.MGF1ParameterSpec;
import java.util.Arrays;
import java.util.Date;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;
import javax.security.auth.x500.X500Principal;

@CapacitorPlugin(name = "SecureCatalog")
public class SecureCatalogPlugin extends Plugin {
    private static final String APP_ID = "com.nexuss0781.storebase";
    private static final String PROTOCOL = "STOREBASE_GATEWAY_V1";
    private static final String TELEGRAM_BOOTSTRAP_PATH = "/api/v1/telegram/bootstrap";
    private static final String GATEWAY_ORIGIN = "https://storebase.wasmer.app";
    private static final String IDENTITY_KEY_ALIAS = "storebase.gateway.identity.v1";
    private static final String SETTINGS_KEY_ALIAS = "storebase.telegram.settings.v1";
    private static final String SETTINGS_FILE_NAME = "storebase-telegram-settings.bin";
    private static final String SETTINGS_AAD = "STOREBASE_TELEGRAM_SETTINGS_V1";
    private static final int BOOTSTRAP_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
    private static final int DOWNLOAD_CHUNK_LIMIT_BYTES = 512 * 1024;
    private static final long DOWNLOAD_LIMIT_BYTES = 1024L * 1024L * 1024L;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String, DirectDownload> directDownloads = new ConcurrentHashMap<>();

    @PluginMethod
    public void getTelegramSettings(PluginCall call) {
        executor.execute(() -> {
            JSONObject cached = readTelegramSettingsQuietly();
            if (cached != null) {
                call.resolve(settingsResult(cached, "cache"));
                return;
            }
            try {
                JSONObject fresh = fetchTelegramSettings();
                writeTelegramSettings(fresh);
                call.resolve(settingsResult(fresh, "gateway"));
            } catch (Exception error) {
                call.reject("Secure Telegram setup is temporarily unavailable.");
            }
        });
    }

    @PluginMethod
    public void createDirectDownload(PluginCall call) {
        executor.execute(() -> {
            try {
                String fileName = safeFileName(call.getString("fileName"));
                String mimeType = call.getString("mimeType");
                String storage = call.getString("storage");
                String expectedSha256 = call.getString("expectedSha256");
                Long sizeValue = call.getLong("expectedSize");
                long expectedSize = sizeValue == null ? 0L : sizeValue;
                if (fileName == null || mimeType == null || mimeType.length() > 128
                        || expectedSize <= 0 || expectedSize > DOWNLOAD_LIMIT_BYTES
                        || !isSha256(expectedSha256)) {
                    call.reject("Invalid Telegram download metadata.");
                    return;
                }
                File directory;
                if ("updates".equals(storage)) {
                    directory = new File(getContext().getFilesDir(), "updates");
                } else if (storage == null || "downloads".equals(storage)) {
                    directory = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (directory == null) directory = new File(getContext().getFilesDir(), "downloads");
                } else {
                    call.reject("Invalid Telegram download storage location.");
                    return;
                }
                if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("Download directory unavailable.");
                String handle = UUID.randomUUID().toString();
                File temporary = new File(directory, ".storebase-" + handle + ".part");
                DirectDownload download = new DirectDownload(handle, fileName, mimeType, expectedSize, expectedSha256.toLowerCase(java.util.Locale.ROOT), temporary);
                directDownloads.put(handle, download);
                JSObject result = new JSObject();
                result.put("handle", handle);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Could not prepare the Telegram download.");
            }
        });
    }

    @PluginMethod
    public void appendDirectDownload(PluginCall call) {
        executor.execute(() -> {
            String handle = call.getString("handle");
            String encoded = call.getString("chunkBase64");
            DirectDownload download = handle == null ? null : directDownloads.get(handle);
            if (download == null || encoded == null || encoded.length() > (DOWNLOAD_CHUNK_LIMIT_BYTES * 4L / 3L) + 16L) {
                call.reject("Invalid Telegram download chunk.");
                return;
            }
            byte[] chunk = null;
            try {
                chunk = decodeBase64(encoded);
                if (chunk.length == 0 || chunk.length > DOWNLOAD_CHUNK_LIMIT_BYTES) throw new IllegalArgumentException("Invalid chunk size.");
                synchronized (download) {
                    if (download.output == null || download.received + chunk.length > download.expectedSize) {
                        throw new IllegalStateException("Unexpected Telegram download size.");
                    }
                    download.output.write(chunk);
                    download.digest.update(chunk);
                    download.received += chunk.length;
                }
                JSObject result = new JSObject();
                result.put("received", download.received);
                call.resolve(result);
            } catch (Exception error) {
                removeDirectDownload(download);
                call.reject("Could not store a Telegram download chunk.");
            } finally {
                if (chunk != null) Arrays.fill(chunk, (byte) 0);
            }
        });
    }

    @PluginMethod
    public void finishDirectDownload(PluginCall call) {
        executor.execute(() -> {
            String handle = call.getString("handle");
            DirectDownload download = handle == null ? null : directDownloads.get(handle);
            if (download == null) {
                call.reject("Telegram download is not available.");
                return;
            }
            try {
                synchronized (download) {
                    if (download.output == null) throw new IllegalStateException("Download already closed.");
                    download.output.flush();
                    download.output.getFD().sync();
                    download.output.close();
                    download.output = null;
                    byte[] actualDigest = download.digest.digest();
                    String actualSha256 = toHex(actualDigest);
                    Arrays.fill(actualDigest, (byte) 0);
                    if (download.received != download.expectedSize || !download.expectedSha256.equals(actualSha256)) {
                        throw new SecurityException("Telegram artifact verification failed.");
                    }
                    File target = uniqueDownloadTarget(download.temporary.getParentFile(), download.fileName);
                    if (!download.temporary.renameTo(target)) throw new IllegalStateException("Unable to finalize Telegram download.");
                    directDownloads.remove(handle);
                    JSObject result = new JSObject();
                    result.put("fileName", target.getName());
                    result.put("mimeType", download.mimeType);
                    result.put("size", download.received);
                    result.put("path", target.getAbsolutePath());
                    call.resolve(result);
                }
            } catch (Exception error) {
                removeDirectDownload(download);
                call.reject("Telegram artifact verification or storage failed.");
            }
        });
    }

    @PluginMethod
    public void abortDirectDownload(PluginCall call) {
        executor.execute(() -> {
            String handle = call.getString("handle");
            DirectDownload download = handle == null ? null : directDownloads.get(handle);
            if (download != null) removeDirectDownload(download);
            call.resolve();
        });
    }

    private JSONObject fetchTelegramSettings() throws Exception {
        JSONObject settings = fetchGatewayPayload(TELEGRAM_BOOTSTRAP_PATH);
        validateTelegramSettings(settings);
        return settings;
    }

    private JSONObject fetchGatewayPayload(String endpointPath) throws Exception {
        if (!APP_ID.equals(getContext().getPackageName())) throw new SecurityException("Unexpected Android package.");
        KeyPair identity = getOrCreateIdentityKeyPair();
        String publicKey = Base64.encodeToString(identity.getPublic().getEncoded(), Base64.NO_WRAP);
        String requestId = UUID.randomUUID().toString();
        long timestamp = System.currentTimeMillis();
        String canonical = joinLines(PROTOCOL, "POST", endpointPath, APP_ID, requestId, Long.toString(timestamp), publicKey);
        Signature signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(identity.getPrivate());
        signer.update(canonical.getBytes(StandardCharsets.UTF_8));
        String signature = Base64.encodeToString(signer.sign(), Base64.NO_WRAP);

        JSONObject requestBody = new JSONObject();
        requestBody.put("appId", APP_ID);
        requestBody.put("requestId", requestId);
        requestBody.put("timestamp", timestamp);
        requestBody.put("publicKey", publicKey);
        requestBody.put("signature", signature);

        HttpsURLConnection connection = null;
        try {
            connection = (HttpsURLConnection) new URL(GATEWAY_ORIGIN + endpointPath).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(20000);
            connection.setInstanceFollowRedirects(false);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            byte[] body = requestBody.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }
            int status = connection.getResponseCode();
            if (status != 200) throw new IllegalStateException("Gateway rejected the authenticated request.");
            byte[] responseBytes;
            try (InputStream input = connection.getInputStream()) {
                responseBytes = readBounded(input, BOOTSTRAP_RESPONSE_LIMIT_BYTES);
            }
            JSONObject envelope = new JSONObject(new String(responseBytes, StandardCharsets.UTF_8));
            return decryptEnvelope(envelope, identity.getPrivate(), requestId);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private JSONObject decryptEnvelope(JSONObject envelope, PrivateKey privateKey, String requestId) throws Exception {
        if (!PROTOCOL.equals(envelope.optString("protocol"))
                || !APP_ID.equals(envelope.optString("appId"))
                || !requestId.equals(envelope.optString("requestId"))
                || !"RSA-OAEP-SHA256".equals(envelope.optString("keyWrap"))
                || !"AES-256-GCM".equals(envelope.optString("contentEncryption"))) {
            throw new SecurityException("Invalid gateway envelope.");
        }
        String issuedAt = envelope.getString("issuedAt");
        if (issuedAt.length() > 64) throw new SecurityException("Invalid gateway envelope time.");
        byte[] encryptedKey = decodeBase64(envelope.getString("encryptedKey"));
        byte[] iv = decodeBase64(envelope.getString("iv"));
        byte[] ciphertext = decodeBase64(envelope.getString("ciphertext"));
        byte[] tag = decodeBase64(envelope.getString("tag"));
        if (iv.length != 12 || tag.length != 16 || ciphertext.length > BOOTSTRAP_RESPONSE_LIMIT_BYTES) {
            throw new SecurityException("Invalid encrypted catalog payload.");
        }
        OAEPParameterSpec oaep = new OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT);
        Cipher keyCipher = Cipher.getInstance("RSA/ECB/OAEPPadding");
        keyCipher.init(Cipher.DECRYPT_MODE, privateKey, oaep);
        byte[] contentKey = keyCipher.doFinal(encryptedKey);
        if (contentKey.length != 32) throw new SecurityException("Invalid catalog key.");
        byte[] combined = new byte[ciphertext.length + tag.length];
        System.arraycopy(ciphertext, 0, combined, 0, ciphertext.length);
        System.arraycopy(tag, 0, combined, ciphertext.length, tag.length);
        Cipher contentCipher = Cipher.getInstance("AES/GCM/NoPadding");
        contentCipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(contentKey, "AES"), new GCMParameterSpec(128, iv));
        String aad = joinLines(PROTOCOL, APP_ID, requestId, issuedAt);
        contentCipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
        byte[] plaintext;
        try {
            plaintext = contentCipher.doFinal(combined);
        } finally {
            Arrays.fill(contentKey, (byte) 0);
        }
        try {
            return new JSONObject(new String(plaintext, StandardCharsets.UTF_8));
        } finally {
            Arrays.fill(plaintext, (byte) 0);
        }
    }

    private void validateTelegramSettings(JSONObject settings) throws Exception {
        if (settings.optInt("schemaVersion", -1) != 1 || settings.optInt("settingsVersion", -1) != 1) {
            throw new SecurityException("Unsupported Telegram settings.");
        }
        JSONObject telegram = settings.getJSONObject("telegram");
        int apiId = telegram.getInt("apiId");
        String apiHash = telegram.getString("apiHash");
        String readSession = telegram.getString("readSession");
        String channel = telegram.getString("channel");
        if (apiId <= 0 || apiHash.length() < 16 || apiHash.length() > 64
                || readSession.length() < 32 || readSession.length() > 8192
                || channel.trim().isEmpty() || channel.length() > 128) {
            throw new SecurityException("Invalid Telegram reader settings.");
        }
    }

    private JSObject settingsResult(JSONObject settings, String source) {
        JSObject result = new JSObject();
        result.put("settings", settings);
        result.put("source", source);
        return result;
    }

    private SecretKey getOrCreateSettingsKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(SETTINGS_KEY_ALIAS)) return (SecretKey) keyStore.getKey(SETTINGS_KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(SETTINGS_KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    private void writeTelegramSettings(JSONObject settings) throws Exception {
        validateTelegramSettings(settings);
        byte[] plaintext = settings.toString().getBytes(StandardCharsets.UTF_8);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSettingsKey());
        cipher.updateAAD(joinLines(PROTOCOL, SETTINGS_AAD, APP_ID).getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        byte[] ciphertext;
        try {
            ciphertext = cipher.doFinal(plaintext);
        } finally {
            Arrays.fill(plaintext, (byte) 0);
        }
        ByteArrayOutputStream payload = new ByteArrayOutputStream();
        payload.write(1);
        payload.write(iv.length);
        payload.write(iv);
        payload.write(ciphertext);
        byte[] encoded = payload.toByteArray();
        AtomicFile atomicFile = new AtomicFile(settingsFile());
        FileOutputStream output = null;
        try {
            output = atomicFile.startWrite();
            output.write(encoded);
            output.getFD().sync();
            atomicFile.finishWrite(output);
        } catch (Exception error) {
            if (output != null) atomicFile.failWrite(output);
            throw error;
        } finally {
            Arrays.fill(ciphertext, (byte) 0);
            Arrays.fill(encoded, (byte) 0);
        }
    }

    private JSONObject readTelegramSettingsQuietly() {
        File file = settingsFile();
        if (!file.isFile()) return null;
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] encoded = readBounded(input, 20 * 1024);
            if (encoded.length < 30 || encoded[0] != 1 || (encoded[1] & 0xff) != 12) throw new SecurityException("Invalid settings cache.");
            byte[] iv = Arrays.copyOfRange(encoded, 2, 14);
            byte[] ciphertext = Arrays.copyOfRange(encoded, 14, encoded.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateSettingsKey(), new GCMParameterSpec(128, iv));
            cipher.updateAAD(joinLines(PROTOCOL, SETTINGS_AAD, APP_ID).getBytes(StandardCharsets.UTF_8));
            byte[] plaintext = cipher.doFinal(ciphertext);
            try {
                JSONObject settings = new JSONObject(new String(plaintext, StandardCharsets.UTF_8));
                validateTelegramSettings(settings);
                return settings;
            } finally {
                Arrays.fill(plaintext, (byte) 0);
                Arrays.fill(ciphertext, (byte) 0);
                Arrays.fill(encoded, (byte) 0);
            }
        } catch (Exception error) {
            new AtomicFile(file).delete();
            return null;
        }
    }

    private File settingsFile() {
        return new File(getContext().getNoBackupFilesDir(), SETTINGS_FILE_NAME);
    }

    private void removeDirectDownload(DirectDownload download) {
        directDownloads.remove(download.handle, download);
        synchronized (download) {
            try {
                if (download.output != null) download.output.close();
            } catch (Exception ignored) {
                // The partial file is removed below regardless.
            }
            download.output = null;
            if (download.temporary.exists()) download.temporary.delete();
        }
    }

    private static String safeFileName(String input) {
        if (input == null || input.trim().isEmpty() || input.length() > 200) return null;
        String name = input.trim().replaceAll("[^A-Za-z0-9._-]", "_");
        while (name.contains("..")) name = name.replace("..", ".");
        if (name.isEmpty() || name.equals(".")) return null;
        return name;
    }

    private static boolean isSha256(String value) {
        return value != null && value.matches("(?i)[0-9a-f]{64}");
    }

    private static String toHex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }

    private static File uniqueDownloadTarget(File directory, String fileName) {
        File target = new File(directory, fileName);
        if (!target.exists()) return target;
        int dot = fileName.lastIndexOf('.');
        String stem = dot > 0 ? fileName.substring(0, dot) : fileName;
        String extension = dot > 0 ? fileName.substring(dot) : "";
        return new File(directory, stem + "-" + UUID.randomUUID().toString().substring(0, 8) + extension);
    }

    private KeyPair getOrCreateIdentityKeyPair() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(IDENTITY_KEY_ALIAS)) {
            Certificate certificate = keyStore.getCertificate(IDENTITY_KEY_ALIAS);
            PrivateKey privateKey = (PrivateKey) keyStore.getKey(IDENTITY_KEY_ALIAS, null);
            return new KeyPair(certificate.getPublicKey(), privateKey);
        }
        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore");
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                IDENTITY_KEY_ALIAS,
                KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY | KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(2048)
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP, KeyProperties.ENCRYPTION_PADDING_RSA_PKCS1)
                .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
                .setCertificateSubject(new X500Principal("CN=StoreBase Install Key"))
                .setCertificateSerialNumber(java.math.BigInteger.ONE)
                .setCertificateNotBefore(new Date(System.currentTimeMillis() - 86400000L))
                .setCertificateNotAfter(new Date(System.currentTimeMillis() + 10L * 365L * 86400000L))
                .build();
        generator.initialize(spec);
        return generator.generateKeyPair();
    }

    private byte[] decodeBase64(String input) {
        byte[] decoded = Base64.decode(input, Base64.DEFAULT);
        if (!Base64.encodeToString(decoded, Base64.NO_WRAP).equals(input)) throw new IllegalArgumentException("Invalid base64 payload.");
        return decoded;
    }

    private byte[] readBounded(InputStream input, int limit) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) != -1) {
            if (output.size() + read > limit) throw new IllegalStateException("Response too large.");
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static String joinLines(String... values) {
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < values.length; i++) {
            if (i > 0) result.append('\n');
            result.append(values[i]);
        }
        return result.toString();
    }

    private static final class DirectDownload {
        final String handle;
        final String fileName;
        final String mimeType;
        final long expectedSize;
        final String expectedSha256;
        final File temporary;
        final MessageDigest digest;
        FileOutputStream output;
        long received;

        DirectDownload(String handle, String fileName, String mimeType, long expectedSize, String expectedSha256, File temporary) throws Exception {
            this.handle = handle;
            this.fileName = fileName;
            this.mimeType = mimeType;
            this.expectedSize = expectedSize;
            this.expectedSha256 = expectedSha256;
            this.temporary = temporary;
            this.digest = MessageDigest.getInstance("SHA-256");
            this.output = new FileOutputStream(temporary, false);
        }
    }
}
