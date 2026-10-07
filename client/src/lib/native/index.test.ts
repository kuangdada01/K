/**
 * ============================================================
 * 原生能力封装单测（lib/native/index）
 * ============================================================
 * 这些封装是"网页直接用"的入口（更新下载、保存相册、系统分享）。
 * 它们不值得在 UI 层各测一遍，但**方法名与参数形状**必须钉死：
 * 原生侧 `KNativeBridge` 用的是同一批字符串，写错一个字母就是静默失效。
 * ============================================================
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  downloadFile,
  enterPip,
  getDeviceInfo,
  getNotificationStatus,
  installDownloadedApk,
  isNative,
  notify,
  onDeeplink,
  onDownload,
  onFirstPaint,
  onMediaCommand,
  onNetworkChanged,
  onPipChanged,
  onRendererGone,
  requestNotificationPermission,
  saveImage,
  setPipEnabled,
  shareImage,
  shareText,
  startBackgroundPlayback,
  stopBackgroundPlayback,
  updateApk,
  updateBackgroundPlayback,
} from './index';

interface Recorded {
  method: string;
  params: Record<string, unknown>;
}

const recorded: Recorded[] = [];
let failNext = false;

function installBridge(): void {
  (window as unknown as { KNative: unknown }).KNative = {
    version: () => 1,
    info: () =>
      JSON.stringify({
        platform: 'android',
        versionName: '0.1.0',
        versionCode: 1,
        packageName: 'x',
        bridgeVersion: 1,
      }),
    prefsGet: () => null,
    prefsSet: () => {},
    cancel: () => {},
    invoke: (callId: string, method: string, paramsJson: string) => {
      recorded.push({ method, params: JSON.parse(paramsJson) as Record<string, unknown> });
      queueMicrotask(() => {
        if (failNext) {
          window.__KNative?.resolve(callId, false, JSON.stringify({ code: 'ERR_FAILED', message: 'x' }));
        } else {
          window.__KNative?.resolve(
            callId,
            true,
            JSON.stringify({ id: 42, shared: true, saved: 'K-1.jpg', installing: true })
          );
        }
      });
    },
  };
}

beforeEach(() => {
  recorded.length = 0;
  failNext = false;
  installBridge();
});

afterEach(() => {
  delete (window as unknown as { KNative?: unknown }).KNative;
});

describe('二期 W1：下载与安装', () => {
  it('updateApk → file.updateApk（APK 下载完由原生自动安装）', async () => {
    const res = await updateApk('https://a/k-app-0.1.0-release.apk', 'K-0.1.0.apk');
    expect(recorded[0]).toEqual({
      method: 'file.updateApk',
      params: { url: 'https://a/k-app-0.1.0-release.apk', fileName: 'K-0.1.0.apk' },
    });
    expect(res.id).toBe(42);
  });

  it('downloadFile → file.download（带文件名与 MIME）', async () => {
    await downloadFile('https://a/x.zip', 'x.zip', 'application/zip');
    expect(recorded[0]!.method).toBe('file.download');
    expect(recorded[0]!.params).toEqual({
      url: 'https://a/x.zip',
      fileName: 'x.zip',
      mimeType: 'application/zip',
    });
  });

  it('installDownloadedApk → file.installApk', async () => {
    await installDownloadedApk(42);
    expect(recorded[0]).toEqual({ method: 'file.installApk', params: { id: 42 } });
  });

  it('onDownload 把原生事件透给调用方；退订后不再收到', () => {
    const seen: unknown[] = [];
    const off = onDownload((e) => seen.push(e));
    window.__KNative!.emit(
      'download',
      JSON.stringify({ id: 42, status: 'completed', uri: 'content://x', fileName: 'a.apk' })
    );
    off();
    window.__KNative!.emit(
      'download',
      JSON.stringify({ id: 43, status: 'failed', uri: null, fileName: null })
    );
    expect(seen).toEqual([{ id: 42, status: 'completed', uri: 'content://x', fileName: 'a.apk' }]);
  });
});

describe('二期 W1：保存相册与系统分享', () => {
  it('saveImage → media.saveImage（鉴权头必须带上：/api/ 图片要 Authorization）', async () => {
    await saveImage('https://a/api/private/1', {
      headers: { Authorization: 'Bearer t' },
      fileName: 'p.jpg',
    });
    expect(recorded[0]).toEqual({
      method: 'media.saveImage',
      params: {
        url: 'https://a/api/private/1',
        headers: { Authorization: 'Bearer t' },
        fileName: 'p.jpg',
      },
    });
  });

  it('shareText → share.text', async () => {
    await shareText('https://a/post/1', 'K');
    expect(recorded[0]).toEqual({ method: 'share.text', params: { text: 'https://a/post/1', title: 'K' } });
  });

  it('shareImage → share.image', async () => {
    await shareImage('https://a/1.jpg', { headers: { Authorization: 'Bearer t' }, text: '看图' });
    expect(recorded[0]!.method).toBe('share.image');
    expect(recorded[0]!.params).toEqual({
      url: 'https://a/1.jpg',
      headers: { Authorization: 'Bearer t' },
      text: '看图',
    });
  });

  it('非原生环境：调用直接 reject（调用方据此回退浏览器行为）', async () => {
    delete (window as unknown as { KNative?: unknown }).KNative;
    expect(isNative()).toBe(false);
    await expect(updateApk('https://a/x.apk')).rejects.toMatchObject({ code: 'ERR_NO_BRIDGE' });
  });

  it('原生返回失败：reject（更新弹窗据此回退到浏览器下载）', async () => {
    failNext = true;
    await expect(updateApk('https://a/x.apk')).rejects.toMatchObject({ code: 'ERR_FAILED' });
  });
});

describe('二期 W2：本地通知与深链', () => {
  it('notify → notify.show（标题/正文/深链/合并键都传下去）', async () => {
    await notify({
      title: '新私信',
      body: '你收到一条新私信',
      deeplink: '/messages/42',
      id: 9,
      tag: 'msg-42',
    });
    expect(recorded[0]).toEqual({
      method: 'notify.show',
      params: {
        title: '新私信',
        body: '你收到一条新私信',
        deeplink: '/messages/42',
        id: 9,
        tag: 'msg-42',
      },
    });
  });

  it('getNotificationStatus / requestNotificationPermission → 对应方法名', async () => {
    await getNotificationStatus();
    await requestNotificationPermission();
    expect(recorded.map((r) => r.method)).toEqual(['notify.status', 'notify.requestPermission']);
  });

  it('onDeeplink 只在 payload 形态合法时回调（脏数据不炸调用方）', () => {
    const seen: unknown[] = [];
    const off = onDeeplink((p) => seen.push(p));
    window.__KNative!.emit('deeplink', JSON.stringify({ kind: 'link', path: '/post/12' }));
    window.__KNative!.emit('deeplink', JSON.stringify({ nothing: true }));
    off();
    window.__KNative!.emit('deeplink', JSON.stringify({ kind: 'text', text: 'x' }));
    expect(seen).toEqual([{ kind: 'link', path: '/post/12' }]);
  });
});

describe('二期 W3：后台音频 / 画中画 / 生物识别', () => {
  it('startBackgroundPlayback → media.startForeground（kind 决定前台服务类型）', async () => {
    await startBackgroundPlayback('voice', '闲聊房', '语音房中');
    await startBackgroundPlayback('music', '歌名', '歌手');
    expect(recorded[0]).toEqual({
      method: 'media.startForeground',
      params: { kind: 'voice', title: '闲聊房', text: '语音房中' },
    });
    expect(recorded[1]!.params).toEqual({ kind: 'music', title: '歌名', text: '歌手' });
  });

  it('update / stop 前台服务 → 对应方法名', async () => {
    await updateBackgroundPlayback('新歌', '歌手');
    await stopBackgroundPlayback();
    expect(recorded.map((r) => r.method)).toEqual(['media.updateForeground', 'media.stopForeground']);
  });

  it('onMediaCommand 透传通知栏"停止"与音频焦点变化，退订后不再收到', () => {
    const seen: string[] = [];
    const off = onMediaCommand((e) => seen.push(e.action));
    window.__KNative!.emit('media.command', JSON.stringify({ action: 'pause' }));
    window.__KNative!.emit('media.command', JSON.stringify({ action: 'audioFocusLost' }));
    off();
    window.__KNative!.emit('media.command', JSON.stringify({ action: 'stop' }));
    expect(seen).toEqual(['pause', 'audioFocusLost']);
  });

  it('setPipEnabled / enterPip → 对应方法名与参数', async () => {
    await setPipEnabled(true);
    await setPipEnabled(false);
    await enterPip();
    expect(recorded.map((r) => r.method)).toEqual(['pip.setEnabled', 'pip.setEnabled', 'pip.enter']);
    expect(recorded[0]!.params).toEqual({ enabled: true });
  });

  it('onPipChanged 只在 inPip 是布尔值时回调', () => {
    const seen: boolean[] = [];
    const off = onPipChanged((e) => seen.push(e.inPip));
    window.__KNative!.emit('pip.changed', JSON.stringify({ inPip: true }));
    window.__KNative!.emit('pip.changed', JSON.stringify({}));
    off();
    window.__KNative!.emit('pip.changed', JSON.stringify({ inPip: false }));
    expect(seen).toEqual([true]);
  });
});

describe('二期 W4：系统信息', () => {
  it('getDeviceInfo → device.info', async () => {
    await getDeviceInfo();
    expect(recorded[0]!.method).toBe('device.info');
  });

  it('onNetworkChanged 只在 type 是字符串时回调，退订后不再收到', () => {
    const seen: string[] = [];
    const off = onNetworkChanged((e) => seen.push(e.type));
    window.__KNative!.emit('network.changed', JSON.stringify({ type: 'none' }));
    window.__KNative!.emit('network.changed', JSON.stringify({}));
    off();
    window.__KNative!.emit('network.changed', JSON.stringify({ type: 'wifi' }));
    expect(seen).toEqual(['none']);
  });
});

describe('三期：诊断事件', () => {
  it('onFirstPaint 只在 ms 是数字时回调（脏 payload 不炸调用方）', () => {
    const seen: number[] = [];
    const off = onFirstPaint((e) => seen.push(e.ms));
    window.__KNative!.emit('perf.firstPaint', JSON.stringify({ ms: 1234 }));
    window.__KNative!.emit('perf.firstPaint', JSON.stringify({ ms: 'x' }));
    off();
    window.__KNative!.emit('perf.firstPaint', JSON.stringify({ ms: 999 }));
    expect(seen).toEqual([1234]);
  });

  it('onRendererGone 只在 count 是数字时回调', () => {
    const seen: number[] = [];
    const off = onRendererGone((e) => seen.push(e.count));
    window.__KNative!.emit('diagnostics.rendererGone', JSON.stringify({ count: 2 }));
    off();
    window.__KNative!.emit('diagnostics.rendererGone', JSON.stringify({ count: 3 }));
    expect(seen).toEqual([2]);
  });
});
