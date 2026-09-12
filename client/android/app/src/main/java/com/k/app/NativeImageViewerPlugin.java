package com.k.app;

import android.content.Intent;
import android.os.Bundle;

import androidx.activity.result.ActivityResult;

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

    /** 正在展示中的调用（close() 由 JS 主动关闭时用） */
    private PluginCall pendingCall;

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

        // 缩略图矩形（CSS px）→ 屏幕 px：乘以 WebView 的页面缩放（设备像素比）
        JSObject rect = call.getObject("rect");
        if (rect != null) {
            float scale = 1f;
            try {
                if (getBridge() != null && getBridge().getWebView() != null) {
                    scale = getBridge().getWebView().getScale();
                }
            } catch (Throwable ignored) {
                // 取不到就用 1
            }
            int x = Math.round((float) rect.optDouble("x", 0) * scale);
            int y = Math.round((float) rect.optDouble("y", 0) * scale);
            int w = Math.round((float) rect.optDouble("width", 0) * scale);
            int h = Math.round((float) rect.optDouble("height", 0) * scale);
            if (w > 0 && h > 0) {
                intent.putExtra(ImageViewerActivity.EXTRA_SRC_RECT, new int[] { x, y, x + w, y + h });
            }
        }

        pendingCall = call;
        startActivityForResult(call, intent, "viewerResult");
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
