/**
 * ============================================================
 * 下拉刷新 Hook（usePullToRefresh）
 * ============================================================
 * 从 HomePage 抽出：移动端下拉刷新（用 ref 直接操作 DOM，零延迟跟手）。
 * 阈值按 DPR 归一、渐近阻尼、水平滑动放行、成功/失败 toast、转圈平滑退出。
 *
 * 健壮性（针对部分 Android WebView 的实测缺陷）：
 * 被 preventDefault 的下拉手势，WebView 可能不派发 touchend/touchcancel
 * （实测 OPPO WebView 在手指抬起时只发 pointercancel，甚至整条事件流
 * 直接断掉），导致指示器冻结在半空、松手不刷新、必须重新再滑一次。
 * 因此：
 * - 「活动看门狗」兜底：武装状态下 220ms 内无任何触摸事件，按松手处理；
 * - 拉距用渐近阻尼无限逼近 MAX，不存在“拉到底纹丝不动”的死区。
 */

import { useEffect, useRef, RefObject } from 'react';
import { showToast } from '../components/ui/Toast';

/** 进度圆环周长（r=12 → ~75.4），供 JSX 初始 strokeDasharray 使用 */
export const PULL_CIRCUMFERENCE = 2 * Math.PI * 12;

interface PullToRefreshOptions {
  /** 触发下拉手势的容器元素 */
  containerRef: RefObject<HTMLDivElement | null>;
  /** 下拉指示器容器 */
  indicatorRef: RefObject<HTMLDivElement | null>;
  /** SVG 进度圆环 */
  progressRef: RefObject<SVGCircleElement | null>;
  /** 刷新中状态 */
  refreshing: boolean;
  /** 刷新状态 setter */
  setRefreshing: (v: boolean) => void;
  /** 刷新回调：返回是否成功 */
  onRefresh: () => Promise<boolean>;
}

export function usePullToRefresh(options: PullToRefreshOptions): void {
  const { containerRef, indicatorRef, progressRef, refreshing, setRefreshing, onRefresh } = options;

  // 阈值按设备像素比归一：高 DPR 屏（如 3.5）上同样的 CSS 像素需要更长的
  // 实体手指行程，80px 阈值在手机上约等于 1.6cm+ 的拉距，用户会觉得
  // “拉了很多却不刷新”。以 DPR 2.6 为基准归一，桌面 / 低 DPR 设备不受影响。
  // 基线阈值 80 → 60：指示器最大行程的“拉到一半”即可触发。
  const dpr = window.devicePixelRatio || 1;
  const physicalScale = Math.min(Math.max(dpr, 1), 2.6) / dpr;
  const THRESHOLD = 60 * physicalScale;
  const MAX_PULL = 150 * physicalScale;
  const CIRCUMFERENCE = PULL_CIRCUMFERENCE;
  /** 看门狗：武装状态下无触摸事件超过该时长（ms）视为手指已离开 */
  const INACTIVITY_MS = 220;

  const touchStartY = useRef(0);
  const touchStartX = useRef(0);
  const pullDistRef = useRef(0);
  const refreshingRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  const lastActivityRef = useRef(0);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep refs in sync（渲染期写 ref 会被 react-hooks/refs 拦截，改在 effect 中同步）
  useEffect(() => { onRefreshRef.current = onRefresh; }, [onRefresh]);
  useEffect(() => { refreshingRef.current = refreshing; }, [refreshing]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updatePullUI = (distance: number) => {
      const indicator = indicatorRef.current;
      if (!indicator) return;
      indicator.style.transition = 'none';
      indicator.style.opacity = '1';
      indicator.style.height = `${distance}px`;
      // Update progress circle stroke
      const circle = progressRef.current;
      if (circle) {
        const progress = Math.min(distance / THRESHOLD, 1);
        circle.setAttribute('stroke-dasharray', `${progress * CIRCUMFERENCE} ${CIRCUMFERENCE}`);
      }
    };

    const collapsePullUI = () => {
      const indicator = indicatorRef.current;
      if (!indicator) return;
      indicator.style.transition = 'height 0.2s ease, opacity 0.15s ease';
      indicator.style.height = '0px';
      // Reset progress circle
      const circle = progressRef.current;
      if (circle) {
        circle.setAttribute('stroke-dasharray', `0 ${CIRCUMFERENCE}`);
      }
    };

    const stopWatchdog = () => {
      if (watchdogRef.current) {
        clearInterval(watchdogRef.current);
        watchdogRef.current = null;
      }
    };

    const bumpActivity = () => { lastActivityRef.current = performance.now(); };

    /** 滚动容器在顶部时从 (x,y) 开始武装本次下拉跟踪 */
    const armAt = (x: number, y: number) => {
      const mainContent = document.querySelector('.main-content') as HTMLElement | null;
      const scrollTop = mainContent ? mainContent.scrollTop : 0;
      if (scrollTop > 0) return false;
      touchStartY.current = y;
      touchStartX.current = x;
      bumpActivity();
      // 武装后启动看门狗：事件流死亡（收不到 touchend）也能按松手收尾
      if (!watchdogRef.current) {
        watchdogRef.current = setInterval(() => {
          if (touchStartY.current !== 0 && !refreshingRef.current &&
              performance.now() - lastActivityRef.current > INACTIVITY_MS) {
            finalizeGesture();
          }
        }, 100);
      }
      return true;
    };

    /** 结束本次手势：松手 / 事件流死亡统一走这里 */
    const finalizeGesture = () => {
      stopWatchdog();
      if (touchStartY.current === 0) return;
      const shouldRefresh = pullDistRef.current >= THRESHOLD;
      touchStartY.current = 0;
      pullDistRef.current = 0;

      if (!shouldRefresh) {
        collapsePullUI();
        return;
      }

      // 松开后固定指示器高度，切换到转圈状态
      const indicator = indicatorRef.current;
      if (indicator) {
        indicator.style.transition = 'height 0.2s ease';
        indicator.style.height = '56px';
      }
      setRefreshing(true);

      let success = false;
      const run = async () => {
        try {
          success = await onRefreshRef.current();
        } catch {
          success = false;
        } finally {
          if (success) {
            showToast('已刷新');
          } else {
            showToast('刷新失败，请检查网络');
          }
          // 转圈平滑退出：先滑动收起，再关闭状态
          const ind = indicatorRef.current;
          if (ind) {
            ind.style.transition = 'height 0.25s ease, opacity 0.2s ease';
            ind.style.height = '0px';
            ind.style.opacity = '0';
          }
          setTimeout(() => {
            setRefreshing(false);
            // 重置 progress circle
            const circle = progressRef.current;
            if (circle) {
              circle.setAttribute('stroke-dasharray', `0 ${CIRCUMFERENCE}`);
            }
            const ind2 = indicatorRef.current;
            if (ind2) {
              ind2.style.transition = '';
              ind2.style.opacity = '';
            }
          }, 300);
        }
      };
      run();
    };

    const onTouchStart = (e: TouchEvent) => {
      if (refreshingRef.current) return;
      // 只有当滚动容器在顶部时才触发下拉刷新
      armAt(e.touches[0].clientX, e.touches[0].clientY);
    };

    const onTouchMove = (e: TouchEvent) => {
      bumpActivity();
      if (refreshingRef.current) return;
      const y = e.touches[0].clientY;
      const x = e.touches[0].clientX;

      if (touchStartY.current === 0) {
        // 手势中途武装：从列表中间滑回顶部后继续下拉属于同一手势，
        // 若只在 touchstart 判断（当时 scrollTop>0），本次下拉会被忽略，
        // 用户必须松手重拉。这里在滚动容器已到顶时从当前位置开始跟踪。
        armAt(x, y);
        return;
      }

      const deltaY = y - touchStartY.current;
      const deltaX = x - touchStartX.current;
      // 仅在下拉且垂直移动主导时拦截，水平滑动（轮播图）放行
      if (deltaY > 0 && deltaY > Math.abs(deltaX)) {
        // 只有在事件可取消时才调用 preventDefault
        if (e.cancelable) {
          e.preventDefault();
        }
        // 渐近阻尼：越拉越紧但永不定格在 MAX，避免“拉到底卡死”的体感
        const raw = Math.max(deltaY, 0);
        const damped = MAX_PULL * (1 - Math.exp(-raw / (MAX_PULL * 0.75)));
        pullDistRef.current = damped;
        updatePullUI(damped);
      } else if (pullDistRef.current > 0) {
        // 回拉或横向滑动取消本次下拉：清零距离并收起指示器，
        // 避免残留的旧距离在松手时误触发刷新
        pullDistRef.current = 0;
        collapsePullUI();
      }
    };

    const onTouchCancel = () => {
      // 手势被系统中断：复位状态并收起（触摸流死亡的情况由看门狗收尾）
      stopWatchdog();
      touchStartY.current = 0;
      pullDistRef.current = 0;
      collapsePullUI();
    };

    const onTouchEnd = () => {
      finalizeGesture();
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      stopWatchdog();
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
    };
    // 历史实现仅在挂载时绑定一次（refs 直读最新值），保持一致
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);
}
