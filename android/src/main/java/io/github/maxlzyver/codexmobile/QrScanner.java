package io.github.maxlzyver.codexmobile;

import android.app.Activity;
import android.app.Dialog;
import android.hardware.Camera;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.ReaderException;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;

import java.util.Collections;
import java.util.EnumMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

@SuppressWarnings("deprecation")
final class QrScanner implements SurfaceHolder.Callback {
    private final Activity activity;
    private final Consumer<String> onRead;
    private final Dialog dialog;
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private final AtomicBoolean decoding = new AtomicBoolean();
    private volatile boolean closed;
    private Camera camera;

    QrScanner(Activity activity, Consumer<String> onRead) {
        this.activity = activity;
        this.onRead = onRead;
        dialog = new Dialog(activity);
        LinearLayout column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setBackgroundColor(0xfffafbf9);
        TextView hint = new TextView(activity);
        hint.setText("将电脑上的连接二维码放入取景框");
        hint.setTextColor(0xff172733);
        hint.setGravity(Gravity.CENTER);
        column.addView(hint, new LinearLayout.LayoutParams(-1, dp(52)));
        SurfaceView preview = new SurfaceView(activity);
        column.addView(preview, new LinearLayout.LayoutParams(-1, dp(330)));
        preview.getHolder().addCallback(this);
        Button cancel = new Button(activity);
        cancel.setText("取消");
        cancel.setOnClickListener(view -> dialog.dismiss());
        column.addView(cancel);
        dialog.setContentView(column);
        dialog.setOnDismissListener(value -> {
            closed = true;
            releaseCamera();
            decoder.shutdownNow();
        });
        dialog.show();
        if (dialog.getWindow() != null) dialog.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private int dp(float value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }

    @Override public void surfaceCreated(SurfaceHolder holder) {
        try {
            camera = Camera.open();
            Camera.Parameters settings = camera.getParameters();
            if (settings.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                settings.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            }
            Camera.Size best = settings.getPreviewSize();
            for (Camera.Size size : settings.getSupportedPreviewSizes()) {
                if (size.width >= 640 && (best.width < 640 || size.width < best.width)) best = size;
            }
            settings.setPreviewSize(best.width, best.height);
            camera.setParameters(settings);
            camera.setDisplayOrientation(90);
            camera.setPreviewDisplay(holder);
            int width = best.width, height = best.height;
            camera.setPreviewCallback((bytes, ignored) -> {
                if (!closed && decoding.compareAndSet(false, true)) decoder.execute(() -> decode(bytes, width, height));
            });
            camera.startPreview();
        } catch (Exception error) {
            Toast.makeText(activity, "无法打开相机，可粘贴电脑上的配对链接。", Toast.LENGTH_LONG).show();
            dialog.dismiss();
        }
    }

    private void decode(byte[] bytes, int width, int height) {
        try {
            if (bytes == null || bytes.length < (long) width * height) return;
            PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(bytes, width, height, 0, 0, width, height, false);
            EnumMap<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
            hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
            hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
            String text = new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(source)), hints).getText();
            activity.runOnUiThread(() -> {
                if (closed) return;
                dialog.dismiss();
                onRead.accept(text);
            });
        } catch (ReaderException ignored) {
            // Continue scanning the next frame.
        } finally {
            decoding.set(false);
        }
    }

    private void releaseCamera() {
        if (camera == null) return;
        camera.setPreviewCallback(null);
        try { camera.stopPreview(); } catch (RuntimeException ignored) {}
        camera.release();
        camera = null;
    }

    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}
    @Override public void surfaceDestroyed(SurfaceHolder holder) { releaseCamera(); }
}
