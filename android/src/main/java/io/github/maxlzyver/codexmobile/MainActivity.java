package io.github.maxlzyver.codexmobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.StyleSpan;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class MainActivity extends Activity {
    private static final int PAPER = 0xfffafbf9, INK = 0xff172733, MUTED = 0xff566879, LINE = 0xffdce4ea;
    private static final int BLUE = 0xff2359c7, SOFT_BLUE = 0xffe7effd, NAV = 0xff192c3b, NAV_TEXT = 0xffedf4fa;
    private static final int GREEN = 0xff277354, ORANGE = 0xff925b22, WHITE = 0xffffffff;
    private static final int CAMERA_REQUEST = 1, PICK_FILES = 2, SAVE_FILE = 3;
    private static final int MAX_UPLOAD = 8 * 1024 * 1024;
    private static final Pattern BOLD = Pattern.compile("\\*\\*([^*\\n]+)\\*\\*");
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final List<Attachment> drafts = new ArrayList<>();
    private SharedPreferences prefs;
    private DeviceSession connection;
    private ConnectivityManager networkManager;
    private boolean foreground, refreshing, approved, online, sending, gpt, gptAvailable, readOnly;
    private boolean showFiles, setup, leaseRevoked, running, pendingDesktopCreation;
    private boolean stopAllowed, approveAllowed, attachmentsAvailable, threadCanStop;
    private FrameLayout root, screen, shade, drawer;
    private LinearLayout chat, files, messages, sidebarRows, fileRows, compose;
    private ScrollView chatScroll, sidebarScroll, fileScroll;
    private TextView title, projectCaption, networkIndicator, hint, send, attach, stop, setupStatus, fileTitle;
    private EditText prompt;
    private Set<String> expanded;
    private JSONArray threads = new JSONArray(), projects = new JSONArray(), desktopProjects = new JSONArray();
    private String active = "", threadTitle = "", fileProject = "", filePath = "", selectedProject = "", nativeProject = "";
    private String desktopName = "我的电脑", connectedOrigin = "", renderKey = "", threadRevision = "", savingPath, savingName;
    private long savingSize;
    private int chatGeneration, filesGeneration;
    private Dialog connectionDialog;
    private final Runnable heartbeat = this::refresh;
    private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) { handler.post(() -> refreshSoon(250)); }
        @Override public void onLost(Network network) { handler.post(() -> refreshSoon(250)); }
    };

    private static final class Attachment {
        final Uri uri;
        final String name;
        String id;
        Attachment(Uri uri, String name) { this.uri = uri; this.name = name; }
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("codex_mobile", MODE_PRIVATE);
        connection = new DeviceSession(prefs);
        networkManager = getSystemService(ConnectivityManager.class);
        active = prefs.getString("chat", "");
        gpt = "gpt".equals(prefs.getString("mode", ""));
        fileProject = prefs.getString("fileProject", "");
        filePath = prefs.getString("filePath", "");
        showFiles = "files".equals(prefs.getString("screen", ""));
        expanded = new HashSet<>(prefs.getStringSet("expanded", new HashSet<>()));
        Window window = getWindow();
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        window.setStatusBarColor(PAPER);
        window.setNavigationBarColor(PAPER);
        window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        root = new FrameLayout(this);
        root.setBackgroundColor(PAPER);
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
                return insets;
            });
        }
        setContentView(root);
        if (connection.isBound()) buildWorkspace();
        else showSetup("在电脑的 Codex 移动助手里打开「连接手机」，用手机扫码，再到电脑端批准。");
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::back);
    }

    @Override protected void onStart() {
        super.onStart();
        foreground = true;
        try { if (networkManager != null) networkManager.registerDefaultNetworkCallback(networkCallback); } catch (RuntimeException ignored) {}
        refreshSoon(0);
    }

    @Override protected void onStop() {
        foreground = false;
        handler.removeCallbacks(heartbeat);
        try { if (networkManager != null) networkManager.unregisterNetworkCallback(networkCallback); } catch (RuntimeException ignored) {}
        super.onStop();
    }

    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        io.shutdownNow();
        super.onDestroy();
    }

    @Override public void onBackPressed() { back(); }
    private void back() {
        if (drawer != null && drawer.isShown()) closeDrawer();
        else if (showFiles && !setup) {
            if (!filePath.isEmpty()) loadFiles(fileProject, parent(filePath));
            else switchScreen(false);
        } else finish();
    }

    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout column() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private LinearLayout row() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.HORIZONTAL);
        view.setGravity(Gravity.CENTER_VERTICAL);
        return view;
    }
    private ScrollView scroll() { ScrollView view = new ScrollView(this); view.setFillViewport(false); return view; }
    private void pad(View view, int x, int y) { view.setPadding(dp(x), dp(y), dp(x), dp(y)); }
    private TextView text(String value, float size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }
    private GradientDrawable surface(int color, int corners, int border) {
        GradientDrawable result = new GradientDrawable();
        result.setColor(color);
        result.setCornerRadius(dp(corners));
        if (border != 0) result.setStroke(dp(1), border);
        return result;
    }
    private TextView action(String label, int color, int background, Runnable then) {
        TextView view = text(label, 14, color, true);
        view.setGravity(Gravity.CENTER);
        view.setMinimumHeight(dp(44));
        view.setMinWidth(dp(44));
        pad(view, 11, 4);
        view.setBackground(surface(background, 10, 0));
        view.setOnClickListener(clicked -> then.run());
        return view;
    }
    private TextView icon(String label, String description, int color, Runnable then) {
        TextView view = action(label, color, 0, then);
        view.setTextSize(22);
        view.setContentDescription(description);
        return view;
    }
    private void rule(LinearLayout target, int color) {
        View line = new View(this);
        line.setBackgroundColor(color);
        target.addView(line, new LinearLayout.LayoutParams(-1, dp(1)));
    }

    private void showSetup(String description) {
        setup = true;
        root.removeAllViews();
        LinearLayout layout = column();
        pad(layout, 23, 24);
        layout.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(layout, new FrameLayout.LayoutParams(-1, -1));
        android.widget.ImageView artwork = new android.widget.ImageView(this);
        artwork.setImageResource(R.drawable.app_icon);
        layout.addView(artwork, new LinearLayout.LayoutParams(dp(54), dp(54)));
        TextView title = text("绑定你的电脑", 27, INK, true);
        title.setPadding(0, dp(17), 0, dp(7));
        layout.addView(title);
        setupStatus = text(description, 15, MUTED, false);
        setupStatus.setLineSpacing(dp(4), 1f);
        layout.addView(setupStatus);
        TextView scan = action("扫描电脑二维码", WHITE, BLUE, this::scan);
        LinearLayout.LayoutParams margin = new LinearLayout.LayoutParams(-1, dp(48));
        margin.topMargin = dp(20);
        layout.addView(scan, margin);
        layout.addView(action("粘贴配对链接", BLUE, 0, () -> addressDialog(false)), new LinearLayout.LayoutParams(-1, dp(46)));
    }

    private void buildWorkspace() {
        setup = false;
        root.removeAllViews();
        screen = new FrameLayout(this);
        root.addView(screen, new FrameLayout.LayoutParams(-1, -1));
        chat = column();
        chat.setBackgroundColor(PAPER);
        screen.addView(chat, new FrameLayout.LayoutParams(-1, -1));
        LinearLayout header = row();
        header.setPadding(dp(9), 0, dp(10), 0);
        header.addView(icon("☰", "打开项目与聊天", INK, this::openDrawer), new LinearLayout.LayoutParams(dp(44), dp(48)));
        LinearLayout heading = column();
        heading.setPadding(dp(7), 0, dp(2), 0);
        projectCaption = text("Codex 移动助手", 11, MUTED, false);
        title = text(active.isEmpty() ? "开始新的聊天" : "正在打开上次聊天", 16, INK, true);
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        heading.addView(projectCaption);
        heading.addView(title);
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        networkIndicator = action("重连中", ORANGE, 0, this::showConnection);
        networkIndicator.setTextSize(12);
        networkIndicator.setContentDescription("查看连接状态");
        header.addView(networkIndicator);
        chat.addView(header, new LinearLayout.LayoutParams(-1, dp(59)));
        rule(chat, LINE);

        chatScroll = scroll();
        messages = column();
        pad(messages, 17, 12);
        chatScroll.addView(messages, new ScrollView.LayoutParams(-1, -2));
        chat.addView(chatScroll, new LinearLayout.LayoutParams(-1, 0, 1));
        hint = text("", 12, MUTED, false);
        pad(hint, 15, 4);
        hint.setVisibility(View.GONE);
        chat.addView(hint);
        compose = row();
        compose.setBackground(surface(WHITE, 17, 0xffcfd9e2));
        pad(compose, 4, 4);
        attach = icon("＋", "添加附件", MUTED, this::pickFiles);
        compose.addView(attach, new LinearLayout.LayoutParams(dp(44), dp(44)));
        prompt = new EditText(this);
        prompt.setHint("发给 Codex 的指令");
        prompt.setTextSize(15);
        prompt.setTextColor(INK);
        prompt.setHintTextColor(MUTED);
        prompt.setMinLines(1);
        prompt.setMaxLines(3);
        prompt.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        prompt.setMinHeight(dp(44));
        prompt.setBackgroundColor(0);
        pad(prompt, 4, 6);
        compose.addView(prompt, new LinearLayout.LayoutParams(0, -2, 1));
        stop = action("停止", ORANGE, 0, this::stopTurn);
        stop.setVisibility(View.GONE);
        compose.addView(stop, new LinearLayout.LayoutParams(-2, dp(44)));
        send = icon("↑", "发送", WHITE, this::sendPrompt);
        send.setBackground(surface(BLUE, 12, 0));
        compose.addView(send, new LinearLayout.LayoutParams(dp(44), dp(44)));
        LinearLayout.LayoutParams footer = new LinearLayout.LayoutParams(-1, -2);
        footer.setMargins(dp(12), dp(3), dp(12), dp(7));
        chat.addView(compose, footer);

        files = column();
        files.setBackgroundColor(PAPER);
        LinearLayout fileHeader = row();
        fileHeader.setPadding(dp(9), 0, dp(7), 0);
        fileHeader.addView(icon("☰", "打开项目与聊天", INK, this::openDrawer), new LinearLayout.LayoutParams(dp(44), dp(48)));
        fileTitle = text("项目文件", 17, INK, true);
        fileHeader.addView(fileTitle, new LinearLayout.LayoutParams(0, -2, 1));
        fileHeader.addView(action("返回聊天", BLUE, 0, () -> switchScreen(false)));
        files.addView(fileHeader, new LinearLayout.LayoutParams(-1, dp(59)));
        rule(files, LINE);
        fileScroll = scroll();
        fileRows = column();
        pad(fileRows, 15, 8);
        fileScroll.addView(fileRows, new ScrollView.LayoutParams(-1, -2));
        files.addView(fileScroll, new LinearLayout.LayoutParams(-1, 0, 1));
        screen.addView(files, new FrameLayout.LayoutParams(-1, -1));

        shade = new FrameLayout(this);
        shade.setBackgroundColor(0x65132434);
        shade.setContentDescription("收起侧栏");
        shade.setOnClickListener(view -> closeDrawer());
        root.addView(shade, new FrameLayout.LayoutParams(-1, -1));
        drawer = new FrameLayout(this);
        drawer.setBackgroundColor(NAV);
        root.addView(drawer, new FrameLayout.LayoutParams(dp(302), -1, Gravity.START));
        shade.setVisibility(View.GONE);
        drawer.setVisibility(View.GONE);
        LinearLayout drawerBody = column();
        pad(drawerBody, 10, 4);
        drawer.addView(drawerBody, new FrameLayout.LayoutParams(-1, -1));
        LinearLayout drawerHeader = row();
        TextView drawerName = text("项目与聊天", 16, NAV_TEXT, true);
        pad(drawerName, 10, 0);
        drawerHeader.addView(drawerName, new LinearLayout.LayoutParams(0, -2, 1));
        drawerHeader.addView(icon("×", "收起侧栏", NAV_TEXT, this::closeDrawer), new LinearLayout.LayoutParams(dp(44), dp(48)));
        drawerBody.addView(drawerHeader, new LinearLayout.LayoutParams(-1, dp(53)));
        rule(drawerBody, 0xff344855);
        sidebarScroll = scroll();
        sidebarRows = column();
        sidebarScroll.addView(sidebarRows, new ScrollView.LayoutParams(-1, -2));
        drawerBody.addView(sidebarScroll, new LinearLayout.LayoutParams(-1, 0, 1));
        rule(drawerBody, 0xff344855);
        drawerBody.addView(drawerAction("▣   连接状态", this::showConnection), new LinearLayout.LayoutParams(-1, dp(46)));
        switchScreen(showFiles);
        displayConnection();
        refreshComposer();
    }

    private void scan() {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) new QrScanner(this, this::claim);
        else requestPermissions(new String[] {Manifest.permission.CAMERA}, CAMERA_REQUEST);
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == CAMERA_REQUEST && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) scan();
        else if (requestCode == CAMERA_REQUEST) notifyUser("可使用「粘贴配对链接」。");
    }

    private void claim(String value) {
        if (setupStatus != null && setup) setupStatus.setText("正在验证电脑二维码…");
        run(() -> {
            MobileClient.Link link = MobileClient.parseLink(value);
            if (connection.isBound() && !leaseRevoked && (link.desktop.isEmpty() || link.desktop.equals(connection.desktop()))) {
                return connection.updateAddress(link);
            }
            return connection.bind(link);
        }, boot -> {
            leaseRevoked = false;
            if (boot.optBoolean("rebound")) {
                active = threadTitle = fileProject = filePath = selectedProject = nativeProject = "";
                expanded.clear();
                drafts.clear();
                approved = gpt = showFiles = false;
                renderKey = threadRevision = "";
                chatGeneration++;
                filesGeneration++;
            }
            handleBootstrap(boot);
            refreshSoon(300);
        }, error -> {
            if (setup && setupStatus != null) setupStatus.setText(explain(error));
            else notifyUser(explain(error));
        });
    }

    private void addressDialog(boolean update) {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint(update ? "电脑端显示的外网地址" : "电脑端复制的配对链接");
        new AlertDialog.Builder(this).setTitle(update ? "更新连接地址" : "粘贴配对链接").setView(input)
            .setNegativeButton("取消", null).setPositiveButton(update ? "保存并重连" : "连接", (dialog, button) -> {
                String value = input.getText().toString().trim();
                if (value.isEmpty()) return;
                if (!update) { claim(value); return; }
                run(() -> connection.updateAddress(MobileClient.parseLink(value.contains("://") ? value : "https://" + value)),
                    boot -> { handleBootstrap(boot); refreshSoon(0); }, error -> notifyUser(explain(error)));
            }).show();
    }

    private boolean onWifi() {
        if (networkManager == null) return true;
        NetworkCapabilities caps = networkManager.getNetworkCapabilities(networkManager.getActiveNetwork());
        return caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET));
    }

    private void refreshSoon(long delay) {
        handler.removeCallbacks(heartbeat);
        if (foreground && connection.isBound() && !leaseRevoked) handler.postDelayed(heartbeat, delay);
    }
    private void refresh() {
        if (!foreground || refreshing || !connection.isBound() || leaseRevoked) return;
        refreshing = true;
        boolean wifi = onWifi();
        run(() -> {
            JSONObject boot = connection.bootstrap(wifi);
            boot.put("origin", connection.active().origin());
            return boot;
        }, boot -> {
            refreshing = false;
            handleBootstrap(boot);
            refreshSoon(approved ? running ? 2300 : 7200 : 2200);
        }, error -> {
            refreshing = false;
            online = false;
            if (error instanceof MobileClient.Revoked) {
                leaseRevoked = true;
                approved = false;
                drafts.clear();
                threads = projects = desktopProjects = new JSONArray();
                showSetup("电脑端已解除此手机的绑定。请重新扫码。");
            } else if (setup && setupStatus != null) {
                setupStatus.setText(explain(error));
            }
            displayConnection();
            refreshComposer();
            refreshSoon(5000);
        });
    }

    private void handleBootstrap(JSONObject boot) {
        if (!"controller".equals(boot.optString("role"))) {
            if (!setup) showSetup("手机已扫码，请在电脑端批准连接。");
            else setupStatus.setText("手机已扫码，请在电脑端批准连接。");
            return;
        }
        boolean initial = !approved;
        approved = true;
        online = true;
        if (boot.has("origin")) connectedOrigin = boot.optString("origin");
        JSONObject status = boot.optJSONObject("status");
        if (status != null) desktopName = status.optString("hostname", "我的电脑");
        JSONObject features = boot.optJSONObject("features"), permissions = boot.optJSONObject("permissions");
        gptAvailable = features != null && features.optBoolean("nativeGpt");
        attachmentsAvailable = features != null && features.optBoolean("attachments");
        stopAllowed = permissions != null && permissions.optBoolean("allowMobileStop");
        boolean canApprove = permissions != null && permissions.optBoolean("allowMobileApprovals");
        if (approveAllowed != canApprove) threadRevision = "";
        approveAllowed = canApprove;
        if (gpt && !gptAvailable) { gpt = false; active = ""; saveSelection(); }
        if (setup) buildWorkspace();
        displayConnection();
        refreshComposer();
        if (initial) {
            loadSidebar();
            if (showFiles && !fileProject.isEmpty()) loadFiles(fileProject, filePath);
        }
        if (!active.isEmpty() && !sending) loadChat(false);
        else if (active.isEmpty() && renderKey.isEmpty()) showEmptyChat();
    }

    private void displayConnection() {
        if (setup || networkIndicator == null) return;
        networkIndicator.setText(online ? connectedOrigin.startsWith("https:") ? "互联网" : "Wi-Fi" : "重连中");
        networkIndicator.setTextColor(online ? GREEN : ORANGE);
    }
    private void showConnection() {
        closeDrawer();
        LinearLayout body = column();
        TextView route = text("此手机  ·  " + (onWifi() ? "Wi-Fi" : "移动数据") + "     →     " + desktopName, 14, BLUE, true);
        route.setBackground(surface(SOFT_BLUE, 12, 0xffccddec));
        pad(route, 12, 12);
        body.addView(route, new LinearLayout.LayoutParams(-1, -2));
        TextView status = text(online ? "设备已绑定，连接正常。" : "正在通过已保存的地址重连。", 14, MUTED, false);
        pad(status, 2, 12);
        body.addView(status);
        if (!connection.publicAddress().isEmpty()) {
            TextView address = text(connection.publicAddress(), 12, MUTED, false);
            address.setTextIsSelectable(true);
            body.addView(address);
        }
        LinearLayout actions = row();
        actions.addView(action("重试连接", WHITE, BLUE, () -> { dismissConnection(); refreshSoon(0); }));
        actions.addView(action("更新连接地址", BLUE, 0, () -> { dismissConnection(); addressDialog(true); }));
        body.addView(actions);
        connectionDialog = sheet("连接到我的电脑", body);
    }
    private void dismissConnection() { if (connectionDialog != null) connectionDialog.dismiss(); }

    private Dialog sheet(String name, View content) {
        Dialog dialog = new Dialog(this);
        LinearLayout body = column();
        body.setBackground(surface(WHITE, 19, LINE));
        pad(body, 16, 8);
        LinearLayout header = row();
        header.addView(text(name, 18, INK, true), new LinearLayout.LayoutParams(0, -2, 1));
        header.addView(icon("×", "关闭", MUTED, dialog::dismiss), new LinearLayout.LayoutParams(dp(44), dp(44)));
        body.addView(header);
        ScrollView inside = scroll();
        inside.addView(content);
        body.addView(inside, new LinearLayout.LayoutParams(-1, -2));
        dialog.setContentView(body);
        dialog.show();
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawableResource(android.R.color.transparent);
            window.setLayout(-1, -2);
            window.setGravity(Gravity.BOTTOM);
        }
        return dialog;
    }

    private void openDrawer() {
        if (setup) return;
        hideKeyboard();
        int width = Math.min(dp(302), Math.max(dp(240), root.getWidth() - dp(42)));
        drawer.setLayoutParams(new FrameLayout.LayoutParams(width, -1, Gravity.START));
        shade.setVisibility(View.VISIBLE);
        drawer.setVisibility(View.VISIBLE);
        screen.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        drawSidebar();
        loadSidebar();
    }
    private void closeDrawer() {
        if (drawer == null) return;
        drawer.setVisibility(View.GONE);
        shade.setVisibility(View.GONE);
        screen.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
    }
    private void hideKeyboard() {
        InputMethodManager ime = getSystemService(InputMethodManager.class);
        if (ime != null && getCurrentFocus() != null) ime.hideSoftInputFromWindow(getCurrentFocus().getWindowToken(), 0);
        if (prompt != null) prompt.clearFocus();
    }

    private void loadSidebar() {
        if (!approved || !online) return;
        boolean mode = gpt;
        run(() -> {
            MobileClient client = connection.active();
            JSONObject choices = client.get(mode ? "/api/gpt/threads" : "/api/threads");
            choices.put("projects", array(client.get("/api/projects"), "projects"));
            try { choices.put("desktopProjects", array(client.get("/api/desktop/projects"), "projects")); }
            catch (MobileClient.HttpFailure error) { if (error.status != 404) throw error; }
            return choices;
        }, data -> {
            if (mode != gpt) return;
            threads = array(data, "threads");
            projects = array(data, "projects");
            desktopProjects = array(data, "desktopProjects");
            if (drawer != null && drawer.isShown()) drawSidebar();
        }, error -> { if (drawer != null && drawer.isShown()) notifyUser(explain(error)); });
    }

    private TextView drawerAction(String name, Runnable then) {
        TextView button = action(name, NAV_TEXT, 0, then);
        button.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        return button;
    }
    private void label(String value) {
        TextView label = text(value, 11, 0xffb5c5d4, true);
        label.setPadding(dp(10), dp(11), 0, dp(2));
        sidebarRows.addView(label);
    }
    private void drawSidebar() {
        int offset = sidebarScroll.getScrollY();
        sidebarRows.removeAllViews();
        if (gptAvailable) {
            LinearLayout modes = row();
            modes.addView(action("Codex", NAV_TEXT, !gpt ? 0xff274561 : 0, () -> changeMode(false)), new LinearLayout.LayoutParams(0, dp(44), 1));
            modes.addView(action("GPT", NAV_TEXT, gpt ? 0xff274561 : 0, () -> changeMode(true)), new LinearLayout.LayoutParams(0, dp(44), 1));
            sidebarRows.addView(modes);
        }
        if (!gpt) sidebarRows.addView(drawerAction("＋   新建任务", () -> newChat("", "", "")));
        label("最近聊天");
        int count = 0;
        for (int index = 0; index < threads.length() && count < 7; index++) {
            JSONObject thread = threads.optJSONObject(index);
            if (thread == null || thread.optBoolean("archived")) continue;
            sidebarRows.addView(threadRow(thread, "", 0));
            count++;
        }
        label("过往项目");
        for (int index = 0; index < desktopProjects.length(); index++) {
            JSONObject project = desktopProjects.optJSONObject(index);
            if (project != null && project.optString("kind", "codex").equals(gpt ? "chatgpt" : "codex")) drawProject(project, true);
        }
        if (!gpt) for (int index = 0; index < projects.length(); index++) {
            JSONObject project = projects.optJSONObject(index);
            if (project != null) drawProject(project, false);
        }
        sidebarScroll.post(() -> sidebarScroll.scrollTo(0, offset));
    }
    private void drawProject(JSONObject project, boolean desktop) {
        String id = project.optString("id"), name = project.optString("name", "项目"), cwd = project.optString("path", project.optString("cwd", ""));
        String key = (gpt ? "gpt:" : "codex:") + (desktop ? "desktop:" : "folder:") + id;
        boolean open = expanded.contains(key);
        TextView group = drawerAction((open ? "⌄  " : "›  ") + name, () -> {
            if (!expanded.remove(key)) expanded.add(key);
            prefs.edit().putStringSet("expanded", new HashSet<>(expanded)).apply();
            drawSidebar();
        });
        group.setContentDescription(name + (open ? "，收起项目" : "，展开项目"));
        sidebarRows.addView(group);
        if (!open) return;
        JSONArray members = array(project, "threadIds");
        for (int index = 0; index < threads.length(); index++) {
            JSONObject thread = threads.optJSONObject(index);
            if (thread != null && !thread.optBoolean("archived") && (id.equals(thread.optString("projectId")) ||
                    !cwd.isEmpty() && normalized(cwd).equals(normalized(thread.optString("cwd"))) ||
                    contains(members, thread.optString("id")))) {
                sidebarRows.addView(threadRow(thread, name, 16));
            }
        }
        String accessible = desktop ? localProjectId(cwd) : id;
        if (!gpt && !accessible.isEmpty()) {
            TextView files = drawerAction("项目文件", () -> { closeDrawer(); switchScreen(true); loadFiles(accessible, ""); });
            files.setPadding(dp(27), 0, dp(8), 0);
            sidebarRows.addView(files);
        }
        if (!gpt && (!desktop || project.optJSONObject("capabilities") != null && project.optJSONObject("capabilities").optBoolean("createThread"))) {
            TextView create = drawerAction("在项目中新建聊天", () -> newChat(desktop ? "" : id, desktop ? id : "", name));
            create.setPadding(dp(27), 0, dp(8), 0);
            sidebarRows.addView(create);
        }
    }
    private TextView threadRow(JSONObject thread, String parent, int indent) {
        String id = thread.optString("id"), name = thread.optString("title", thread.optString("name", thread.optString("preview", "未命名聊天")));
        TextView view = drawerAction(name, () -> openChat(id, name, parent));
        view.setPadding(dp(10 + indent), dp(5), dp(6), dp(5));
        if (id.equals(active)) view.setBackground(surface(0xff274561, 8, 0));
        return view;
    }
    private String localProjectId(String cwd) {
        if (!cwd.isEmpty()) for (int index = 0; index < projects.length(); index++) {
            JSONObject item = projects.optJSONObject(index);
            if (item != null && normalized(item.optString("path")).equals(normalized(cwd))) return item.optString("id");
        }
        return "";
    }
    private static String normalized(String value) { return value.replace('\\', '/').replaceAll("/+$", "").toLowerCase(java.util.Locale.ROOT); }

    private void changeMode(boolean mode) {
        if (gpt == mode) return;
        gpt = mode;
        newChat("", "", "");
        loadSidebar();
    }
    private void newChat(String projectId, String nativeId, String name) {
        selectedProject = projectId;
        nativeProject = nativeId;
        openChat("", name.isEmpty() ? "开始新的聊天" : name + " · 新聊天", name);
    }
    private void openChat(String id, String name, String projectName) {
        if (!id.equals(active) || id.isEmpty()) {
            drafts.clear();
            prompt.setText("");
        }
        active = id;
        threadTitle = name;
        renderKey = "";
        threadRevision = "";
        readOnly = false;
        running = threadCanStop = false;
        pendingDesktopCreation = false;
        chatGeneration++;
        if (!id.isEmpty()) { selectedProject = ""; nativeProject = ""; }
        switchScreen(false);
        closeDrawer();
        saveSelection();
        title.setText(name);
        projectCaption.setText(projectName.isEmpty() ? (gpt ? "GPT" : "Codex") : projectName);
        messages.removeAllViews();
        if (id.isEmpty()) showEmptyChat();
        else { messages.addView(text("正在读取聊天…", 13, MUTED, false)); loadChat(true); }
        refreshComposer();
    }
    private void showEmptyChat() {
        messages.removeAllViews();
        TextView start = text(gpt ? "从侧栏选择已有的 GPT 聊天。" : "从侧栏继续已有聊天，或在下方发送一条新指令。", 14, MUTED, false);
        pad(start, 1, 18);
        messages.addView(start);
        renderKey = "empty";
    }
    private void switchScreen(boolean useFiles) {
        showFiles = useFiles;
        if (chat == null) return;
        chat.setVisibility(useFiles ? View.GONE : View.VISIBLE);
        files.setVisibility(useFiles ? View.VISIBLE : View.GONE);
        saveSelection();
    }
    private void saveSelection() {
        prefs.edit().putString("mode", gpt ? "gpt" : "codex").putString("chat", active)
            .putString("screen", showFiles ? "files" : "chat").putString("fileProject", fileProject).putString("filePath", filePath).apply();
    }

    private String threadPath() { return (gpt ? "/api/gpt/threads/" : "/api/threads/") + Uri.encode(active); }
    private void loadChat(boolean jump) {
        if (!approved || !online || active.isEmpty()) return;
        int generation = chatGeneration;
        String path = threadPath();
        String query = jump || threadRevision.isEmpty() ? "" : "&since=" + Uri.encode(threadRevision);
        run(() -> connection.active().get(path + "?stage=full" + query), data -> {
            if (generation == chatGeneration) applyChatResult(data, jump);
        }, error -> {
            if (generation != chatGeneration) return;
            if (error instanceof MobileClient.HttpFailure && ((MobileClient.HttpFailure) error).status == 404) {
                newChat("", "", "");
                notifyUser("这段聊天已不可用。");
            } else if (jump) showHint(explain(error));
        });
    }
    private void applyChatResult(JSONObject data, boolean jump) {
        JSONObject thread = data.optJSONObject("thread");
        if (thread == null) return;
        String status = thread.optString("status");
        running = java.util.Arrays.asList("running", "waiting", "waiting_for_approval").contains(status);
        JSONObject capabilities = thread.optJSONObject("capabilities");
        readOnly = thread.optBoolean("readOnly") || thread.has("controllable") && !thread.optBoolean("controllable")
            || capabilities != null && capabilities.has("send") && !capabilities.optBoolean("send");
        threadCanStop = capabilities != null && capabilities.optBoolean("stop");
        threadTitle = thread.optString("title", thread.optString("name", threadTitle));
        title.setText(threadTitle.isEmpty() ? "任务对话" : threadTitle);
        JSONArray rows = array(thread, "messages"), approvals = array(data, "approvals");
        String next = rows.toString() + approvals + approveAllowed;
        if (!renderKey.equals(next)) {
            boolean tail = chatScroll.getChildCount() == 0 ||
                messages.getHeight() - chatScroll.getScrollY() - chatScroll.getHeight() < dp(80);
            int offset = chatScroll.getScrollY();
            messages.removeAllViews();
            for (int index = 0; index < rows.length(); index++) {
                JSONObject message = rows.optJSONObject(index);
                if (message != null) renderMessage(message);
            }
            for (int index = 0; index < approvals.length(); index++) {
                JSONObject approval = approvals.optJSONObject(index);
                if (approval != null) renderApproval(approval);
            }
            if (messages.getChildCount() == 0) messages.addView(text("这段聊天暂无消息。", 14, MUTED, false));
            renderKey = next;
            chatScroll.post(() -> chatScroll.scrollTo(0, jump || tail ? messages.getHeight() : offset));
        }
        threadRevision = data.optString("revision");
        refreshComposer();
    }
    private void renderMessage(JSONObject message) {
        boolean mine = "user".equals(message.optString("role"));
        String raw = message.optString("text");
        JSONArray attachments = array(message, "attachments");
        if (raw.isEmpty() && attachments.length() == 0) return;
        LinearLayout bubble = column();
        LinearLayout.LayoutParams bounds = new LinearLayout.LayoutParams(mine ? -2 : -1, -2);
        bounds.gravity = mine ? Gravity.END : Gravity.START;
        bounds.bottomMargin = dp(18);
        if (mine) {
            bounds.leftMargin = dp(33);
            bubble.setBackground(surface(SOFT_BLUE, 13, 0));
            pad(bubble, 12, 10);
        } else {
            String label = "tool".equals(message.optString("role")) ? "运行过程" : gpt ? "GPT" : "Codex";
            TextView byline = text(label, 12, BLUE, true);
            byline.setPadding(0, 0, 0, dp(6));
            bubble.addView(byline);
        }
        if (!raw.isEmpty()) {
            TextView value = text("", 15, INK, false);
            value.setText(markdown(raw));
            value.setTextIsSelectable(true);
            value.setLineSpacing(dp(4), 1.06f);
            bubble.addView(value);
        }
        for (int index = 0; index < attachments.length(); index++) {
            JSONObject item = attachments.optJSONObject(index);
            if (item == null) continue;
            String id = item.optString("id"), name = item.optString("name", "附件");
            if (id.matches("[a-f0-9]{32}")) bubble.addView(action("附件  " + name, BLUE, 0, () ->
                saveDialog("/api/attachments/" + id + "/download", name, item.optLong("size", -1))));
        }
        messages.addView(bubble, bounds);
    }
    private static CharSequence markdown(String raw) {
        String source = raw.replaceAll("(?m)^#{1,6} +", "").replaceAll("(?m)^[-*] +", "•  ");
        SpannableStringBuilder out = new SpannableStringBuilder();
        Matcher matcher = BOLD.matcher(source);
        int index = 0;
        while (matcher.find()) {
            out.append(source.substring(index, matcher.start()));
            int start = out.length();
            out.append(matcher.group(1));
            out.setSpan(new StyleSpan(Typeface.BOLD), start, out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            index = matcher.end();
        }
        return out.append(source.substring(index));
    }
    private void renderApproval(JSONObject approval) {
        String id = approval.optString("id");
        if (!id.matches("[a-f0-9]+")) return;
        LinearLayout card = column();
        card.setBackground(surface(SOFT_BLUE, 12, LINE));
        pad(card, 9, 6);
        card.addView(text(approval.optString("title", "等待审批"), 14, INK, true));
        card.addView(text(approveAllowed ? "任务等待你的决定。" : "请在电脑端处理此请求。", 13, MUTED, false));
        if (approveAllowed && !approval.has("questions")) {
            LinearLayout actions = row();
            actions.addView(action("拒绝", BLUE, 0, () -> decide(id, "decline")));
            actions.addView(action("批准", WHITE, BLUE, () -> decide(id, "accept")));
            card.addView(actions);
        }
        messages.addView(card);
    }
    private void decide(String id, String decision) {
        run(() -> connection.active().send("/api/approvals/" + id, new JSONObject().put("decision", decision)),
            ignored -> loadChat(false), error -> notifyUser(explain(error)));
    }

    private void showHint(String value) {
        if (hint == null) return;
        hint.setText(value);
        hint.setVisibility(value.isEmpty() ? View.GONE : View.VISIBLE);
    }
    private void refreshComposer() {
        if (setup || prompt == null) return;
        boolean canSend = approved && online && !sending && !pendingDesktopCreation && !readOnly
            && (active.isEmpty() || !renderKey.isEmpty()) && (!gpt || !active.isEmpty() && !running);
        prompt.setEnabled(!readOnly && !pendingDesktopCreation && (!gpt || !active.isEmpty()));
        send.setEnabled(canSend);
        send.setAlpha(canSend ? 1 : .4f);
        attach.setVisibility(!gpt && attachmentsAvailable ? View.VISIBLE : View.GONE);
        attach.setEnabled(!readOnly && !sending);
        stop.setVisibility(!gpt && running && stopAllowed && threadCanStop ? View.VISIBLE : View.GONE);
        if (!drafts.isEmpty()) showHint("已添加 " + drafts.size() + " 个附件（长按「＋」可清除）");
        else if (pendingDesktopCreation) showHint("已提交到电脑，请从项目列表打开新聊天。");
        else if (readOnly) showHint("当前聊天可查看，继续操作请在电脑 Codex 中完成。");
        else if (running) showHint(gpt ? "GPT 正在回复…" : "Codex 正在工作");
        else showHint("");
        attach.setOnLongClickListener(view -> { if (!sending) { drafts.clear(); refreshComposer(); } return true; });
    }
    private void sendPrompt() {
        String value = prompt.getText().toString().trim();
        if (sending || !send.isEnabled() || value.isEmpty() && drafts.isEmpty()) return;
        hideKeyboard();
        sending = true;
        refreshComposer();
        int generation = chatGeneration;
        String id = active, chosen = selectedProject, nativeId = nativeProject;
        boolean isGpt = gpt;
        List<Attachment> incoming = new ArrayList<>(drafts);
        run(() -> {
            MobileClient client = connection.active();
            JSONObject input = new JSONObject().put("prompt", value);
            if (!incoming.isEmpty()) {
                JSONArray uploaded = new JSONArray();
                for (Attachment attachment : incoming) {
                    if (attachment.id == null) {
                        try (InputStream stream = getContentResolver().openInputStream(attachment.uri)) {
                            if (stream == null) throw new IOException("无法读取附件。");
                            attachment.id = client.upload(attachment.name, MobileClient.read(stream, MAX_UPLOAD))
                                .getJSONObject("attachment").getString("id");
                        }
                    }
                    uploaded.put(attachment.id);
                }
                input.put("attachmentIds", uploaded);
            }
            if (!chosen.isEmpty() && id.isEmpty()) input.put("projectId", chosen);
            String path = id.isEmpty()
                ? nativeId.isEmpty() ? "/api/threads" : "/api/desktop/projects/" + Uri.encode(nativeId) + "/threads"
                : (isGpt ? "/api/gpt/threads/" : "/api/threads/") + Uri.encode(id) + "/messages";
            return client.send(path, input);
        }, result -> {
            sending = false;
            if (generation != chatGeneration) { refreshComposer(); return; }
            prompt.setText("");
            drafts.clear();
            JSONObject thread = result.optJSONObject("thread");
            String nextId = thread == null ? result.optString("threadId", result.optString("id")) : thread.optString("id");
            if (!nextId.isEmpty()) {
                active = nextId;
                saveSelection();
                if (thread != null) applyChatResult(result, true);
                loadChat(true);
            } else if (!nativeId.isEmpty()) pendingDesktopCreation = true;
            loadSidebar();
            refreshComposer();
        }, error -> {
            sending = false;
            refreshComposer();
            if (generation == chatGeneration) notifyUser(explain(error) + " 请先查看电脑中的记录，再决定是否重发。");
            refreshSoon(0);
        });
    }
    private void stopTurn() {
        if (active.isEmpty() || !stopAllowed || gpt) return;
        String path = threadPath();
        run(() -> connection.active().send(path + "/stop", new JSONObject()), ignored -> loadChat(false), error -> notifyUser(explain(error)));
    }
    private void pickFiles() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(intent, PICK_FILES);
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (result != RESULT_OK || data == null) return;
        if (request == PICK_FILES) {
            ClipData files = data.getClipData();
            if (files != null) for (int index = 0; index < files.getItemCount() && drafts.size() < 8; index++) addDraft(files.getItemAt(index).getUri());
            else if (data.getData() != null && drafts.size() < 8) addDraft(data.getData());
            refreshComposer();
        } else if (request == SAVE_FILE && data.getData() != null && savingPath != null) {
            Uri destination = data.getData();
            String path = savingPath;
            long expectedSize = savingSize;
            savingPath = null;
            run(() -> {
                try (OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
                    if (output == null) throw new IOException("无法写入目标文件。");
                    MobileClient client = connection.active();
                    long offset = 0, size = expectedSize;
                    while (size < 0 || offset < size) {
                        JSONObject chunk = client.readRange(path, offset, offset + 1048575);
                        byte[] bytes = MobileClient.decode(chunk.getString("content"));
                        output.write(bytes);
                        offset += bytes.length;
                        String range = chunk.optString("range", "");
                        if (range.matches("bytes [0-9]+-[0-9]+/[0-9]+")) {
                            long total = Long.parseLong(range.substring(range.lastIndexOf('/') + 1));
                            if (size >= 0 && total != size) throw new IOException("电脑上的文件在下载期间发生变化。");
                            size = total;
                        }
                        if (bytes.length == 0 || offset >= size && size >= 0 || bytes.length < 1048576) break;
                    }
                    return offset;
                }
            }, bytes -> notifyUser("文件已保存。"), error -> notifyUser(explain(error) + " 已写入的部分留在所选位置。"));
        }
    }
    private void addDraft(Uri uri) {
        String name = "手机附件";
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                if (!cursor.isNull(1) && cursor.getLong(1) > MAX_UPLOAD) { notifyUser("Android 单个附件最大 8 MiB。"); return; }
                if (!cursor.isNull(0) && !cursor.getString(0).isEmpty()) name = cursor.getString(0);
            }
        } catch (RuntimeException ignored) {}
        drafts.add(new Attachment(uri, name));
    }

    private void loadFiles(String project, String path) {
        if (!approved || !online || project.isEmpty()) return;
        int generation = ++filesGeneration;
        String api = "/api/projects/" + Uri.encode(project);
        run(() -> connection.active().get(api + "/files?path=" + Uri.encode(path)), result -> {
            if (generation != filesGeneration) return;
            fileProject = project;
            filePath = result.optString("path", path);
            saveSelection();
            JSONObject info = result.optJSONObject("project");
            fileTitle.setText(info == null ? "项目文件" : info.optString("name", "项目文件"));
            fileTitle.setSingleLine(true);
            fileTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
            fileRows.removeAllViews();
            if (!filePath.isEmpty()) fileRows.addView(fileRow("‹  上一级", () -> loadFiles(fileProject, parent(filePath))));
            TextView location = text(filePath.isEmpty() ? "项目文件" : filePath, 12, MUTED, false);
            pad(location, 6, 8);
            fileRows.addView(location);
            JSONArray entries = array(result, "entries");
            for (int index = 0; index < entries.length(); index++) {
                JSONObject item = entries.optJSONObject(index);
                if (item == null) continue;
                String name = item.optString("name"), locationPath = item.optString("path");
                boolean folder = "directory".equals(item.optString("type"));
                fileRows.addView(fileRow((folder ? "▱   " : "▤   ") + name,
                    () -> { if (folder) loadFiles(project, locationPath); else openFile(api, locationPath, name, item.optLong("size", -1)); }));
                rule(fileRows, LINE);
            }
            if (entries.length() == 0) fileRows.addView(text("这个目录没有可显示的文件。", 14, MUTED, false));
            fileScroll.scrollTo(0, 0);
        }, error -> { if (generation == filesGeneration) notifyUser(explain(error)); });
    }
    private TextView fileRow(String name, Runnable go) {
        TextView view = action(name, INK, 0, go);
        view.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        view.setMinHeight(dp(53));
        return view;
    }
    private void openFile(String api, String path, String name, long size) {
        String query = "?path=" + Uri.encode(path);
        run(() -> connection.active().get(api + "/preview" + query), data -> {
            LinearLayout body = column();
            TextView content = text(data.optString("text", data.optString("content", "")), 13, INK, false);
            content.setTypeface(Typeface.MONOSPACE);
            content.setTextIsSelectable(true);
            content.setMaxLines(23);
            body.addView(content);
            body.addView(action("下载文件", BLUE, 0, () -> saveDialog(api + "/download" + query, name, size)));
            sheet(name, body);
        }, error -> new AlertDialog.Builder(this).setTitle(name).setMessage(explain(error))
            .setNegativeButton("关闭", null).setPositiveButton("下载", (dialog, button) -> saveDialog(api + "/download" + query, name, size)).show());
    }
    private void saveDialog(String path, String name, long size) {
        savingPath = path;
        savingSize = size;
        savingName = name;
        Intent destination = new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/octet-stream").addCategory(Intent.CATEGORY_OPENABLE);
        destination.putExtra(Intent.EXTRA_TITLE, savingName);
        startActivityForResult(destination, SAVE_FILE);
    }
    private static String parent(String path) { int index = path.lastIndexOf('/'); return index < 0 ? "" : path.substring(0, index); }

    private interface Work<T> { T run() throws Exception; }
    private <T> void run(Work<T> task, Consumer<T> done, Consumer<Exception> failure) {
        if (io.isShutdown()) return;
        io.execute(() -> {
            try {
                T value = task.run();
                handler.post(() -> { if (!isDestroyed()) done.accept(value); });
            } catch (Exception error) {
                handler.post(() -> { if (!isDestroyed()) failure.accept(error); });
            }
        });
    }
    private void notifyUser(String value) { Toast.makeText(this, value, Toast.LENGTH_LONG).show(); }
    private static String explain(Exception error) {
        if (error instanceof java.net.SocketTimeoutException || error instanceof java.net.ConnectException) return "暂时无法连接电脑，正在等待电脑上线。";
        String message = error.getMessage();
        if (message == null || message.length() > 300 || message.contains("#pair=")) return "操作未完成，请检查连接。";
        return message;
    }
    private static JSONArray array(JSONObject object, String key) {
        JSONArray value = object.optJSONArray(key);
        return value == null ? new JSONArray() : value;
    }
    private static boolean contains(JSONArray array, String value) {
        for (int index = 0; index < array.length(); index++) if (value.equals(array.optString(index))) return true;
        return false;
    }
}
