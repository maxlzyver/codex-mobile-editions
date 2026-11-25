package io.github.maxlzyver.codexmobile;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class MobileClient {
    private static final String PROTOCOL = "Codex Mobile Android v1";
    private static final String DEVICE_ALIAS = "codex-mobile-device";
    private static final int B64 = Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP;
    private static final int MAX_JSON = 16 * 1024 * 1024;
    private final String origin;
    private final String desktopKey;
    private String device;
    private String lease;
    private byte[] secret;
    private long sequence;

    MobileClient(String origin, String desktopKey, String device) throws Exception {
        this.origin = origin(origin);
        this.desktopKey = desktopKey;
        this.device = device;
        publicKey(desktopKey);
    }

    String origin() { return origin; }

    static final class Link {
        final String origin;
        final String pair;
        final String desktop;

        Link(String origin, String pair, String desktop) {
            this.origin = origin;
            this.pair = pair;
            this.desktop = desktop;
        }
    }

    static Link parseLink(String text) throws Exception {
        URI uri = new URI(text.trim());
        String pair = "", desktop = "";
        if (uri.getRawFragment() != null) for (String part : uri.getRawFragment().split("&")) {
            int separator = part.indexOf('=');
            if (separator < 0) continue;
            String key = part.substring(0, separator);
            String value = URLDecoder.decode(part.substring(separator + 1), "UTF-8");
            if (key.equals("pair")) pair = value;
            if (key.equals("desktop")) desktop = value;
        }
        if (!desktop.isEmpty()) publicKey(desktop);
        return new Link(origin(text), pair, desktop);
    }

    static String origin(String text) throws Exception {
        URI uri = new URI(text.trim());
        String scheme = uri.getScheme(), host = uri.getHost();
        if (host == null || uri.getRawUserInfo() != null || uri.getPort() > 65535) throw new IOException("连接地址无效。");
        if (!"https".equals(scheme) && !("http".equals(scheme) && isLocalAddress(host))) {
            throw new IOException("请输入电脑显示的 HTTPS 外网地址或 Wi-Fi 局域网地址。");
        }
        return new URI(scheme, null, host, uri.getPort(), null, null, null).toString();
    }

    static boolean isLocalAddress(String host) {
        if ("localhost".equals(host)) return true;
        if (!host.matches("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}")) return false;
        String[] fields = host.split("\\.");
        for (String field : fields) if (Integer.parseInt(field) > 255) return false;
        int first = Integer.parseInt(fields[0]), second = Integer.parseInt(fields[1]);
        return first == 10 || first == 127 || first == 192 && second == 168 ||
            first == 172 && second >= 16 && second <= 31 ||
            first == 100 && second >= 64 && second <= 127;
    }

    static String b64(byte[] bytes) { return Base64.encodeToString(bytes, B64); }
    static byte[] decode(String text) { return Base64.decode(text, B64); }
    private static byte[] utf8(String text) { return text.getBytes(StandardCharsets.UTF_8); }
    private static String joined(Object... values) {
        StringBuilder output = new StringBuilder();
        for (Object value : values) {
            if (output.length() > 0) output.append('\n');
            output.append(value);
        }
        return output.toString();
    }

    private static PublicKey publicKey(String encoded) throws Exception {
        if (!encoded.matches("[A-Za-z0-9_-]{122}")) throw new IOException("请扫描 1.4.0 或更新的电脑助手二维码。");
        return KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(decode(encoded)));
    }

    private static KeyPair phoneKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(DEVICE_ALIAS)) {
            return new KeyPair(store.getCertificate(DEVICE_ALIAS).getPublicKey(), (PrivateKey) store.getKey(DEVICE_ALIAS, null));
        }
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC", "AndroidKeyStore");
        generator.initialize(new KeyGenParameterSpec.Builder(DEVICE_ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256).build());
        return generator.generateKeyPair();
    }

    JSONObject connect(String pair, String name) throws Exception {
        KeyPair identity = phoneKey();
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair ephemeral = generator.generateKeyPair();
        String phone = b64(identity.getPublic().getEncoded());
        String clientPublic = b64(ephemeral.getPublic().getEncoded());
        byte[] random = new byte[32];
        new SecureRandom().nextBytes(random);
        String nonce = b64(random);
        boolean enroll = !pair.isEmpty();
        String selectedDevice = enroll ? "" : device;
        JSONObject challenge = post("/api/android/challenge", new JSONObject().put("device", selectedDevice)
            .put("enroll", enroll).put("nonce", nonce).put("key", phone).put("ephemeral", clientPublic));
        String id = challenge.getString("id"), peer = challenge.getString("ephemeral");
        byte[] transcript = utf8(joined(PROTOCOL, id, nonce, enroll ? "enroll" : "resume", selectedDevice, phone, clientPublic, peer));
        Signature signature = Signature.getInstance("SHA256withECDSA");
        signature.initVerify(publicKey(desktopKey));
        signature.update(transcript);
        if (!signature.verify(decode(challenge.getString("signature")))) throw new IOException("此地址的电脑身份与绑定记录不一致。");
        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(ephemeral.getPrivate());
        agreement.doPhase(publicKey(peer), true);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(new byte[32], "HmacSHA256"));
        byte[] extracted = mac.doFinal(agreement.generateSecret());
        mac.init(new SecretKeySpec(extracted, "HmacSHA256"));
        mac.update(transcript);
        byte[] nextSecret = mac.doFinal(new byte[] {1});
        signature.initSign(identity.getPrivate());
        signature.update(transcript);
        JSONObject proof = new JSONObject().put("id", id).put("signature", b64(signature.sign()));
        if (enroll) {
            JSONObject registration = new JSONObject().put("pair", pair).put("name", name);
            proof.put("enrollment", b64(crypt(nextSecret, id, 0, 0, utf8(registration.toString()))));
        }
        JSONObject result = post("/api/android/connect", proof);
        String nextLease = result.getString("session");
        JSONObject welcome = new JSONObject(new String(crypt(nextSecret, nextLease, 1, 0, decode(result.getString("message"))), StandardCharsets.UTF_8));
        String role = welcome.getString("role");
        if (role.equals("revoked")) throw new Revoked();
        if (!role.equals("controller") && !role.equals("pending")) throw new IOException(welcome.optString("error", "二维码已过期。"));
        device = welcome.getString("device");
        secret = nextSecret;
        lease = nextLease;
        sequence = 0;
        return welcome;
    }

    JSONObject get(String path) throws Exception { return request(new JSONObject().put("method", "GET").put("path", path)); }
    JSONObject send(String path, JSONObject input) throws Exception {
        return request(new JSONObject().put("method", "POST").put("path", path).put("body", input));
    }
    JSONObject upload(String name, byte[] bytes) throws Exception {
        return request(new JSONObject().put("method", "POST").put("path", "/api/attachments")
            .put("upload", new JSONObject().put("name", name).put("bytes", b64(bytes))));
    }
    JSONObject readRange(String path, long start, long end) throws Exception {
        return exchange(new JSONObject().put("method", "GET").put("path", path).put("range", "bytes=" + start + "-" + end));
    }

    private JSONObject request(JSONObject input) throws Exception { return exchange(input).optJSONObject("data"); }

    private JSONObject exchange(JSONObject input) throws Exception {
        if (lease == null) connect("", "");
        JSONObject reply;
        try { reply = receive(input); }
        catch (HttpFailure error) {
            if (error.status != 401 || !input.getString("method").equals("GET")) throw error;
            connect("", "");
            reply = receive(input);
        }
        JSONObject data = reply.optJSONObject("data");
        if (reply.optBoolean("revoked")) throw new Revoked();
        int status = reply.getInt("status");
        if (status >= 400) {
            String detail = data == null ? "电脑请求失败。" : data.optString("error", "电脑请求失败。");
            throw new HttpFailure(status, detail);
        }
        return reply;
    }

    private JSONObject receive(JSONObject input) throws Exception {
        long sequence = ++this.sequence;
        byte[] ciphertext = crypt(secret, lease, 0, sequence, utf8(input.toString()));
        JSONObject result = post("/api/android/exchange", new JSONObject()
            .put("session", lease).put("sequence", sequence).put("message", b64(ciphertext)));
        return new JSONObject(new String(crypt(secret, lease, 1, sequence, decode(result.getString("message"))), StandardCharsets.UTF_8));
    }

    private static byte[] crypt(byte[] secret, String lease, int direction, long sequence, byte[] bytes) throws Exception {
        byte[] iv = ByteBuffer.allocate(12).putInt(direction).putLong(sequence).array();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(direction == 0 ? Cipher.ENCRYPT_MODE : Cipher.DECRYPT_MODE,
            new SecretKeySpec(secret, "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD(utf8(joined(PROTOCOL, lease, direction, sequence)));
        return cipher.doFinal(bytes);
    }

    private JSONObject post(String path, JSONObject input) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setConnectTimeout(origin.startsWith("http:") ? 2500 : 6000);
            connection.setReadTimeout(50_000);
            connection.setRequestProperty("Content-Type", "application/json");
            byte[] bytes = utf8(input.toString());
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            int status = connection.getResponseCode();
            if (status != 200) throw new HttpFailure(status, "连接电脑失败（" + status + "）。");
            try (InputStream stream = connection.getInputStream()) {
                return new JSONObject(new String(read(stream, MAX_JSON), StandardCharsets.UTF_8));
            }
        } finally {
            connection.disconnect();
        }
    }

    static byte[] read(InputStream stream, int max) throws IOException {
        try (ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                if (bytes.size() + count > max) throw new IOException("文件太大。");
                bytes.write(buffer, 0, count);
            }
            return bytes.toByteArray();
        }
    }

    static final class HttpFailure extends IOException {
        final int status;
        HttpFailure(int status, String message) { super(message); this.status = status; }
    }
    static final class Revoked extends IOException {
        Revoked() { super("设备授权已在电脑端解除，请重新扫码。"); }
    }
}
