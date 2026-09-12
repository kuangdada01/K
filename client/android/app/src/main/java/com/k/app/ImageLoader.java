package com.k.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.os.Handler;
import android.os.Looper;
import android.util.LruCache;

import androidx.annotation.Nullable;
import androidx.exifinterface.media.ExifInterface;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * ============================================================
 * 极简异步图片加载器（ImageLoader）
 * ============================================================
 * 只为原生查看器服务，因此不引第三方（Glide/Coil）：
 * - 内存 LruCache（按 KB 计），按「URL + 目标尺寸」做键；
 * - 网络/本地读取后**先采样解码**（inSampleSize）避免大图 OOM；
 * - 支持自定义请求头：App 里私信/私密图片走 /api/ 需要 Authorization；
 * - 按 EXIF 方向自动旋转/镜像（相机竖拍照片在 WebView 里是正的，
 *   原生解码不处理 EXIF 会躺倒，这是最容易「一看就不对」的点）。
 * ============================================================
 */
public final class ImageLoader {

    public interface Callback {
        void onSuccess(Bitmap bitmap);

        void onError();
    }

    /** 内存缓存上限（KB） */
    private static final int CACHE_KB = 32 * 1024;
    /** 单张解码后的像素预算（防 OOM）：约 4MP ≈ ARGB_8888 下 16MB */
    private static final long MAX_DECODE_PIXELS = 4_000_000L;
    private static final ExecutorService POOL = Executors.newFixedThreadPool(3);
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private static LruCache<String, Bitmap> cache;

    private static synchronized LruCache<String, Bitmap> cache() {
        if (cache == null) {
            cache = new LruCache<String, Bitmap>(CACHE_KB) {
                @Override
                protected int sizeOf(String key, Bitmap value) {
                    return value.getByteCount() / 1024;
                }
            };
        }
        return cache;
    }

    private static String key(String url, int w, int h) {
        return url + '@' + w + 'x' + h;
    }

    public static void clearMemory() {
        cache().evictAll();
    }

    /**
     * 加载图片。reqW/reqH 为期望的显示尺寸（px），用于采样解码；传 0 表示按原图。
     * 回调在主线程；同一 URL 命中内存缓存时同步回调。
     */
    public static void load(
            final String url,
            @Nullable final Map<String, String> headers,
            final int reqW,
            final int reqH,
            final Callback callback) {
        if (url == null || url.isEmpty()) {
            callback.onError();
            return;
        }
        final String k = key(url, reqW, reqH);
        Bitmap cached = cache().get(k);
        if (cached != null && !cached.isRecycled()) {
            callback.onSuccess(cached);
            return;
        }
        POOL.execute(() -> {
            final Bitmap bitmap = decode(url, headers, reqW, reqH, k);
            MAIN.post(() -> {
                if (bitmap != null) callback.onSuccess(bitmap);
                else callback.onError();
            });
        });
    }

    /** 同步解码（工作线程内执行）。失败返回 null。 */
    @Nullable
    private static Bitmap decode(
            String url, @Nullable Map<String, String> headers, int reqW, int reqH, String cacheKey) {
        try {
            byte[] raw = readAll(url, headers);
            if (raw == null || raw.length == 0) return null;

            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(raw, 0, raw.length, bounds);

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, reqW, reqH);
            opts.inPreferredConfig = Bitmap.Config.ARGB_8888;
            Bitmap decoded = BitmapFactory.decodeByteArray(raw, 0, raw.length, opts);
            if (decoded == null) return null;

            Bitmap oriented = applyExif(raw, decoded);
            cache().put(cacheKey, oriented);
            return oriented;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 采样比：先保证「不比目标显示尺寸小」（否则看着糊），再按像素预算收敛防 OOM。
     *
     *  ★ 为什么必须有第二道：只看「不低于屏幕」时，一张 4000×3000 的竖拍/横拍
     *  相机会算出 inSampleSize = 1，即按原图解码 —— ARGB_8888 下就是 48MB，
     *  真机上很容易 OOM 或被系统直接杀掉。换算成像素预算后同类照片落到 2000×1500
     *  左右（约 12MB），1x 观看无差别，只有 4x 放大时略软。 */
    private static int sampleSize(int w, int h, int reqW, int reqH) {
        if (w <= 0 || h <= 0) return 1;
        int size = 1;
        if (reqW > 0 && reqH > 0) {
            while (w / (size * 2) >= reqW && h / (size * 2) >= reqH) {
                size *= 2;
            }
        }
        while ((long) (w / size) * (h / size) > MAX_DECODE_PIXELS) {
            size *= 2;
        }
        return size;
    }

    /** 按 EXIF 方向校正（相机竖拍照片必须处理，否则躺倒） */
    private static Bitmap applyExif(byte[] raw, Bitmap src) {
        try {
            ExifInterface exif = new ExifInterface(new ByteArrayInputStream(raw));
            int orientation = exif.getAttributeInt(
                    ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            Matrix m = new Matrix();
            switch (orientation) {
                case ExifInterface.ORIENTATION_ROTATE_90:
                    m.postRotate(90);
                    break;
                case ExifInterface.ORIENTATION_ROTATE_180:
                    m.postRotate(180);
                    break;
                case ExifInterface.ORIENTATION_ROTATE_270:
                    m.postRotate(270);
                    break;
                case ExifInterface.ORIENTATION_FLIP_HORIZONTAL:
                    m.postScale(-1, 1);
                    break;
                case ExifInterface.ORIENTATION_FLIP_VERTICAL:
                    m.postScale(1, -1);
                    break;
                case ExifInterface.ORIENTATION_TRANSPOSE:
                    m.postRotate(90);
                    m.postScale(-1, 1);
                    break;
                case ExifInterface.ORIENTATION_TRANSVERSE:
                    m.postRotate(270);
                    m.postScale(-1, 1);
                    break;
                default:
                    return src;
            }
            Bitmap rotated = Bitmap.createBitmap(src, 0, 0, src.getWidth(), src.getHeight(), m, true);
            if (rotated != src) src.recycle();
            return rotated;
        } catch (Throwable t) {
            return src;
        }
    }

    /** 读取全部字节（走自定义请求头；支持 http(s) 与 file） */
    @Nullable
    private static byte[] readAll(String url, @Nullable Map<String, String> headers) {
        InputStream in = null;
        try {
            if (url.startsWith("file://")) {
                in = new java.io.FileInputStream(url.substring("file://".length()));
            } else {
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(10_000);
                conn.setReadTimeout(20_000);
                conn.setInstanceFollowRedirects(true);
                Map<String, String> h = headers != null ? headers : new HashMap<>();
                for (Map.Entry<String, String> e : h.entrySet()) {
                    if (e.getKey() != null && e.getValue() != null) {
                        conn.setRequestProperty(e.getKey(), e.getValue());
                    }
                }
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    conn.disconnect();
                    return null;
                }
                in = conn.getInputStream();
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } catch (Throwable t) {
            return null;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Throwable ignored) {
                    // 关闭失败无需处理
                }
            }
        }
    }
}
