package com.k.app;

import android.content.Intent;
import android.os.Bundle;

import androidx.activity.result.ActivityResult;
import androidx.annotation.Nullable;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;

/**
 * ============================================================
 * 原生图片查看器插件（NativeImageViewer）
 * ============================================================
 * 网页层在 Capacitor 环境下调 open()，由原生 ImageViewerActivity 接管全屏看图；
 * 关闭时 resolve 出最终索引，网页层据此同步自己的状态（如详情页主轮播位置）。
 *
 * JS 侧：
 *   await NativeImageViewer.open({
 *     images: string[], index: number,
 *     headers?: Record<string,string>,   // 鉴权图片（/api/...）需要
 *     rect?: { x, y, width, height },    // 被点缩略图的屏幕矩形（CSS px），用于 Hero
 *   })  → { index: number }
 *   NativeImageViewer.close()
 * ============================================================
 */
@CapacitorPlugin(name = "NativeImageViewer")
public class NativeImageViewerPlugin extends Plugin {

    /** 当前插件实例：Activity 退场时要主动通知网页层（静态可达） */
    @Nullable
    private static NativeImageViewerPlugin activePlugin;

    /** 正在展示中的调用（close() 由 JS 主动关闭时用） */
    private PluginCall pendingCall;

    @Override
    public void load() {
        activePlugin = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (activePlugin == this) activePlugin = null;
    }

    /**
     * Activity → 网页层：**即将退出**（退场飞行动画开始时）。
     *
     * 为什么需要这条通知：退出时原生会把图片「飞回缩略图」，期间黑幕不透明；
     * 黑幕揭开的那一帧，网页层的轮播必须已经停在返回的这一张上，否则会看到
     * 「落地的是 B 张、背景却露出 A 张」再跳一下。等 open() 的 Promise resolve
     * 再同步就晚了（那时画面已经揭开）。
     */
    static void notifyWillClose(int index) {
        NativeImageViewerPlugin p = activePlugin;
        if (p == null) return;
        JSObject data = new JSObject();
        data.put("index", index);
        p.notifyListeners("willClose", data);
    }

    @PluginMethod
    public void open(PluginCall call) {
        JSArray images = call.getArray("images");
        if (images == null || images.length() == 0) {
            call.reject("images 不能为空");
            return;
        }
        ArrayList<String> list = new ArrayList<>();
        try {
            for (int i = 0; i < images.length(); i++) {
                String s = images.getString(i);
                if (s != null && !s.isEmpty()) list.add(s);
            }
        } catch (Exception e) {
            call.reject("images 解析失败");
            return;
        }
        if (list.isEmpty()) {
            call.reject("images 不能为空");
            return;
        }

        Intent intent = new Intent(getContext(), ImageViewerActivity.class);
        intent.putStringArrayListExtra(ImageViewerActivity.EXTRA_IMAGES, list);
        intent.putExtra(ImageViewerActivity.EXTRA_INDEX, call.getInt("index", 0));

        // 请求头：鉴权图片（私信/私密）需要 Authorization
        JSObject headers = call.getObject("headers");
        if (headers != null) {
            Bundle hb = new Bundle();
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                Object v = headers.opt(k);
                if (v instanceof String) hb.putString(k, (String) v);
            }
            intent.putExtra(ImageViewerActivity.EXTRA_HEADERS, hb);
        }

        // 缩略图矩形：**网页层已换算成物理像素**（CSS px × devicePixelRatio）。
        // 早期版本在这里乘 WebView.getScale()，但该 API 语义含糊，取到异常值就
        // 表现为「从错误位置放大」；网页层的 devicePixelRatio 是确定的。
        // 再做一次合理性校验：超出屏幕好几倍就干脆不做 Hero（退化为淡入），
        // 宁可少一个动画，也不能出现「图从屏幕外飞进来」这种明显 bug。
        JSObject rect = call.getObject("rect");
        if (rect != null) {
            int x = (int) Math.round(rect.optDouble("x", 0));
            int y = (int) Math.round(rect.optDouble("y", 0));
            int w = (int) Math.round(rect.optDouble("width", 0));
            int h = (int) Math.round(rect.optDouble("height", 0));
            if (plausible(x, y, w, h, getContext().getResources().getDisplayMetrics())) {
                intent.putExtra(ImageViewerActivity.EXTRA_SRC_RECT, new int[] { x, y, x + w, y + h });
            }
        }

        // 每张图各自的缩略图矩形（扁平 int[4*N]，单位见下）：退场反向 Hero 要知道
        // 「当前这一张」在网页里的位置 —— 用户在查看器里翻到第 5 张再退出，
        // 就要飞回第 5 张的缩略图，而不是打开时那张
        JSArray rects = call.getArray("rects");
        if (rects != null && rects.length() > 0) {
            android.util.DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
            int[] flat = new int[list.size() * 4];
            for (int i = 0; i < list.size() && i < rects.length(); i++) {
                JSONObject r = rects.optJSONObject(i);
                if (r == null) continue;
                int x = (int) Math.round(r.optDouble("x", 0));
                int y = (int) Math.round(r.optDouble("y", 0));
                int w = (int) Math.round(r.optDouble("width", 0));
                int h = (int) Math.round(r.optDouble("height", 0));
                if (w <= 0 || h <= 0 || !plausible(x, y, w, h, dm)) continue; // 不合理 → 留 0（该张不做 Hero）
                flat[i * 4] = x;
                flat[i * 4 + 1] = y;
                flat[i * 4 + 2] = x + w;
                flat[i * 4 + 3] = y + h;
            }
            intent.putExtra(ImageViewerActivity.EXTRA_RECTS, flat);
        }

        pendingCall = call;
        startActivityForResult(call, intent, "viewerResult");
    }

    /** 矩形是否合理：物理像素、尺寸为正、且不会离谱到屏幕外几倍（宁可少个动画也不能乱飞） */
    private static boolean plausible(int x, int y, int w, int h, android.util.DisplayMetrics dm) {
        return w > 0
                && h > 0
                && w <= dm.widthPixels * 2
                && h <= dm.heightPixels * 2
                && x > -dm.widthPixels
                && y > -dm.heightPixels
                && x < dm.widthPixels * 2
                && y < dm.heightPixels * 2;
    }

    /** JS 主动关闭（例如网页层自己也需要收起时） */
    @PluginMethod
    public void close(PluginCall call) {
        PluginCall p = pendingCall;
        if (p != null) {
            JSObject ret = new JSObject();
            ret.put("index", -1);
            p.resolve(ret);
            pendingCall = null;
        }
        call.resolve();
    }

    @ActivityCallback
    private void viewerResult(PluginCall call, ActivityResult result) {
        pendingCall = null;
        if (call == null) return;
        JSObject ret = new JSObject();
        int index = -1;
        if (result.getData() != null) {
            index = result.getData().getIntExtra(ImageViewerActivity.RESULT_INDEX, -1);
        }
        ret.put("index", index);
        call.resolve(ret);
    }

    /** 供调试：JSON 序列化辅助（避免未使用告警） */
    @SuppressWarnings("unused")
    private String dump(JSONObject o) {
        return o == null ? "null" : o.toString();
    }
}
