package io.github.maxlzyver.codexmobile;

import android.content.SharedPreferences;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.LinkedHashSet;

final class DeviceSession {
    private final SharedPreferences preferences;
    private MobileClient client;
    private boolean usedWifi;

    DeviceSession(SharedPreferences preferences) {
        this.preferences = preferences;
    }

    boolean isBound() {
        return !preferences.getString("desktop", "").isEmpty() && !preferences.getString("device", "").isEmpty();
    }

    String desktop() { return preferences.getString("desktop", ""); }
    String publicAddress() { return preferences.getString("internet", ""); }

    JSONObject bind(MobileClient.Link link) throws Exception {
        if (link.desktop.isEmpty() || !link.pair.matches("[A-Za-z0-9_-]{43}")) {
            throw new IOException("请在电脑助手中生成并扫描配对二维码。");
        }
        MobileClient candidate = new MobileClient(link.origin, link.desktop, "");
        String model = Build.MODEL == null ? "Android 手机" : Build.MODEL;
        JSONObject welcome = candidate.connect(link.pair, model.substring(0, Math.min(model.length(), 80)));
        preferences.edit().remove("internet").remove("lan").remove("lastLan")
            .remove("chat").remove("mode").remove("screen").remove("fileProject").remove("filePath").remove("expanded")
            .putString("desktop", link.desktop).putString("device", welcome.getString("device")).apply();
        rememberAddress(link.origin);
        client = candidate;
        return candidate.get("/api/bootstrap").put("origin", candidate.origin()).put("rebound", true);
    }

    JSONObject updateAddress(MobileClient.Link link) throws Exception {
        if (!link.desktop.isEmpty() && !link.desktop.equals(desktop())) throw new IOException("此二维码属于另一台电脑。");
        MobileClient candidate = new MobileClient(link.origin, desktop(), preferences.getString("device", ""));
        JSONObject boot = candidate.get("/api/bootstrap");
        client = candidate;
        saveConnections(boot, link.origin);
        return boot.put("origin", candidate.origin());
    }

    JSONObject bootstrap(boolean wifi) throws Exception {
        if (!isBound()) throw new IOException("请先绑定电脑。");
        LinkedHashSet<String> candidates = new LinkedHashSet<>();
        if (client != null && usedWifi == wifi && (wifi || !client.origin().startsWith("http:"))) candidates.add(client.origin());
        if (wifi) {
            candidates.add(preferences.getString("lastLan", ""));
            JSONArray addresses = new JSONArray(preferences.getString("lan", "[]"));
            for (int index = 0; index < Math.min(addresses.length(), 5); index++) candidates.add(addresses.optString(index));
        }
        candidates.add(publicAddress());
        String desktop = desktop(), device = preferences.getString("device", "");
        Exception last = new IOException(wifi ? "正在等待电脑上线。" : "请在电脑端开启互联网连接并更新外网地址。");
        for (String address : candidates) {
            if (address.isEmpty()) continue;
            try {
                MobileClient candidate = client != null && address.equals(client.origin()) ? client : new MobileClient(address, desktop, device);
                JSONObject boot = candidate.get("/api/bootstrap");
                client = candidate;
                usedWifi = wifi;
                saveConnections(boot, address);
                return boot;
            } catch (MobileClient.Revoked revoked) {
                client = null;
                throw revoked;
            } catch (Exception error) {
                last = error;
                client = null;
            }
        }
        throw last;
    }

    MobileClient active() throws IOException {
        if (client == null) throw new IOException("正在连接电脑，请稍后重试。");
        return client;
    }

    private void saveConnections(JSONObject boot, String address) throws Exception {
        rememberAddress(address);
        JSONObject connections = boot.optJSONObject("connection");
        if (connections == null) return;
        JSONArray lan = connections.optJSONArray("lanUrls");
        SharedPreferences.Editor editor = preferences.edit();
        if (lan != null) editor.putString("lan", lan.toString());
        String external = connections.optString("publicUrl", "");
        if (external.startsWith("https://")) editor.putString("internet", MobileClient.origin(external));
        editor.apply();
    }

    private void rememberAddress(String address) {
        preferences.edit().putString(address.startsWith("https://") ? "internet" : "lastLan", address).apply();
    }
}
