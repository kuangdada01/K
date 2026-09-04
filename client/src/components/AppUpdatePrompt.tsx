/**
 * ============================================================
 * App 更新检测弹窗组件 (AppUpdatePrompt)
 * ============================================================
 * 原生 Android 平台启动时检测服务器是否有新版本 APK，
 * 有更新则弹出提示，用户可选择「立即更新」或「以后再说」。
 *
 * 功能:
 * - 仅原生平台生效（Capacitor.isNativePlatform()），Web 端静默
 * - 通过 App.getInfo() 读取当前安装版本，与 /api/app/version 对比
 * - 版本号语义化比较（0.2.0 > 0.1.9）
 * - 点「立即更新」用系统浏览器打开 APK 下载链接
 * - 点「以后再说」本地记住跳过的版本号，同一版本只提示一次
 * - 关闭后不重复弹（会话级 state），下次启动再检测
 * ============================================================
 */

import { useEffect, useState, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { Download, X } from 'lucide-react';
import api from '../api/http';
import styles from './AppUpdatePrompt.module.css';

const SKIP_VERSION_KEY = 'k_skip_update_version';

/** 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

interface UpdateInfo {
  version: string | null;
  apkUrl: string | null;
  notes: string;
}

export default function AppUpdatePrompt() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [closing, setClosing] = useState(false);

  const handleClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => setUpdate(null), 200);
  }, [closing]);

  /** 以后再说：记住跳过版本，同一版本不再提示 */
  const handleLater = useCallback(() => {
    if (update?.version) {
      try {
        localStorage.setItem(SKIP_VERSION_KEY, update.version);
      } catch {
        /* 存储不可用则忽略，下次仍提示 */
      }
    }
    handleClose();
  }, [update, handleClose]);

  /** 立即更新：系统浏览器打开 APK 下载链接 */
  const handleUpdate = useCallback(() => {
    if (!update?.apkUrl) return;
    // Capacitor Android WebView 中 _system 由原生接管，跳转系统浏览器下载
    window.open(update.apkUrl, '_system');
    handleClose();
  }, [update, handleClose]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let cancelled = false;

    (async () => {
      try {
        const [info, res] = await Promise.all([
          CapApp.getInfo(), // 当前安装版本（Android versionName）
          api.get('/app/version'),
        ]);
        if (cancelled) return;

        const server = res.data as UpdateInfo;
        const current = info.version ?? '0.0.0';

        // 服务端未配置版本信息 → 无更新
        if (!server.version || !server.apkUrl) return;
        // 本地跳过版本 → 不提示
        if (localStorage.getItem(SKIP_VERSION_KEY) === server.version) return;
        // 服务器版本 <= 当前版本 → 无更新
        if (compareVersions(server.version, current) <= 0) return;

        setUpdate(server);
      } catch {
        /* 检测失败静默（离线/接口异常不打扰用户） */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!update) return null;

  return (
    <div className={`${styles.overlay} ${closing ? styles.closing : ''}`} onClick={handleClose}>
      <div className={`${styles.modal} ${closing ? styles.closing : ''}`} onClick={(e) => e.stopPropagation()}>
        <button className={styles.close} onClick={handleClose} aria-label="关闭">
          <X size={18} />
        </button>

        <div className={styles.logo}>📦</div>
        <div className={styles.title}>发现新版本</div>
        <div className={styles.version}>v{update.version}</div>

        {update.notes ? (
          <div className={styles.notes}>{update.notes}</div>
        ) : (
          <div className={styles.notes}>建议升级到最新版本，体验更佳功能。</div>
        )}

        <div className={styles.actions}>
          <button className={styles.primary} onClick={handleUpdate}>
            <Download size={16} />
            立即更新
          </button>
          <button className={styles.secondary} onClick={handleLater}>
            以后再说
          </button>
        </div>
      </div>
    </div>
  );
}
