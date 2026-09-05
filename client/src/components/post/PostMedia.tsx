/**
 * ============================================================
 * 帖子媒体展示组件 (PostMedia)
 * ============================================================
 * PostDetail 的媒体区（图片轮播/视频/缩放查看）抽取：
 * - 图片轮播 + 指示点 + 左右切换（受控组件，索引/缩放状态由调用方管理）
 * - 详情页主轮播：无自动轮播，手势跟手翻页（transform 轨道驱动，GPU 合成器 60fps）
 * - 缩放查看 overlay（全屏）：点击进入/退出，滑动翻页（同样 transform 驱动）
 * ============================================================
 */

import { useEffect, useRef, RefObject } from 'react';
import { X, ZoomIn, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Post } from '../../types';
import { resolveMediaUrl } from '../../utils';
import styles from './PostMedia.module.css';

interface PostMediaProps {
  post: Post;
  images: string[];
  /** 视频元素 ref（播放控制由 PostDetail 管理） */
  detailVideoRef: RefObject<HTMLVideoElement | null>;
  currentImageIndex: number;
  setCurrentImageIndex: (v: number | ((prev: number) => number)) => void;
  zoomed: boolean;
  setZoomed: (v: boolean) => void;
}

export default function PostMedia({
  post, images, detailVideoRef,
  currentImageIndex, setCurrentImageIndex,
  zoomed, setZoomed,
}: PostMediaProps) {
  // viewport（宽度来源 + touch-action）与 transform 轨道
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomScrollRef = useRef<HTMLDivElement>(null);
  const mainTrackRef = useRef<HTMLDivElement>(null);
  const zoomTrackRef = useRef<HTMLDivElement>(null);
  // 当前轨道像素偏移（0 = 第一张），手势跟手与动画共用
  const mainOffsetRef = useRef(0);
  const zoomOffsetRef = useRef(0);
  // 全屏内最后停靠的图片索引（同步写入 ref，退出时以此为准，避免依赖可能过期的 state）
  const lastZoomIndexRef = useRef(0);
  // 上次稳定停靠的图片索引：一次手势最多翻一页（防惯性一下跳过 2 张）
  const mainSettledRef = useRef(0);
  const zoomSettledRef = useRef(0);
  // transition 结束后的清理定时器
  const transTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTransTimers = () => {
    transTimersRef.current.forEach(t => clearTimeout(t));
    transTimersRef.current = [];
  };

  /** 主轮播轨道位移（transform 驱动，合成器线程，不触发 layout） */
  const setMainOffset = (x: number) => {
    mainOffsetRef.current = x;
    if (mainTrackRef.current) {
      mainTrackRef.current.style.transform = `translate3d(${-x}px, 0, 0)`;
    }
  };

  /** 全屏轮播轨道位移 */
  const setZoomOffset = (x: number) => {
    zoomOffsetRef.current = x;
    if (zoomTrackRef.current) {
      zoomTrackRef.current.style.transform = `translate3d(${-x}px, 0, 0)`;
    }
  };

  /** 轨道落位动画：CSS transition（合成器执行，帧率满格） */
  const animateTrackTo = (
    track: HTMLDivElement | null,
    setOffset: (x: number) => void,
    index: number,
    width: number,
  ) => {
    if (!track) return;
    const target = width * index;
    if (Math.abs(setOffset === setMainOffset ? mainOffsetRef.current : zoomOffsetRef.current - target) < 1) return;
    track.style.transition = 'transform 400ms cubic-bezier(0.22, 1, 0.36, 1)';
    setOffset(target);
    const t = setTimeout(() => {
      if (track) track.style.transition = 'none';
    }, 460);
    transTimersRef.current.push(t);
  };

  // 全屏滑动时主轮播同步跟随（退出全屏无追回动画）
  const syncMainCarousel = (index: number) => {
    const width = scrollRef.current?.clientWidth || 0;
    setMainOffset(width * index);
  };

  // —— 手势完全接管（WebView 原生惯性/scroll-snap 不可控，快速滑动会跨页）——
  // transform 轨道驱动：touchmove 直接写 translate3d（合成器线程，60fps 丝滑）；
  // 松手用 CSS transition 落位。纵向主导的手势交还浏览器滚动页面。
  const attachGesture = (
    viewport: HTMLDivElement | null,
    track: HTMLDivElement | null,
    getSettled: () => number,
    setSettled: (v: number) => void,
    onMove: (index: number) => void,
    setOffset: (x: number) => void,
    getOffset: () => number,
  ) => {
    if (!viewport || !track) return () => {};
    let startX = 0;
    let startY = 0;
    let startOffset = 0;
    let startIndex = 0;
    let active = false;
    let horizontal = false; // 是否已判定为横向手势（横向主导才接管滚动）
    let moveHandler: ((e: TouchEvent) => void) | null = null;

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // 动画中途再次触摸：取消 transition，从当前位置继续跟手，无缝衔接
      track.style.transition = 'none';
      clearTransTimers();
      active = true;
      horizontal = false;
      startX = e.clientX;
      startY = e.clientY;
      startOffset = getOffset();
      startIndex = getSettled();
      moveHandler = (te: TouchEvent) => {
        if (!active || te.touches.length !== 1) return;
        const touch = te.touches[0];
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (!horizontal) {
          // 首次位移判定方向：横向主导才接管，纵向主导（浏览页面）立即放手
          if (Math.abs(dx) > Math.abs(dy) + 2) {
            horizontal = true;
          } else if (Math.abs(dy) > Math.abs(dx) + 2) {
            active = false; // 交给浏览器纵向滚动页面
            if (moveHandler) {
              viewport.removeEventListener('touchmove', moveHandler);
              moveHandler = null;
            }
            return;
          } else {
            return; // 位移太小，继续观察
          }
        }
        te.preventDefault();
        setOffset(startOffset - dx);
      };
      // passive:false 才能 preventDefault 禁掉原生惯性滚动
      viewport.addEventListener('touchmove', moveHandler, { passive: false });
    };

    const up = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      if (moveHandler) {
        viewport.removeEventListener('touchmove', moveHandler);
        moveHandler = null;
      }
      const dx = getOffset() - startOffset; // 正向 = 手指左滑（offset 增大）= 下一张
      const width = viewport.clientWidth || 1;
      const total = images.length;
      let target = startIndex;
      if (Math.abs(dx) > width * 0.12 || e.pointerType === 'mouse') {
        // 拖动超过 ~1/8 屏 → 翻一页（最多一页，绝不过 2 张）
        if (dx > 0) target = Math.min(total - 1, startIndex + 1);
        else if (dx < 0) target = Math.max(0, startIndex - 1);
      } else {
        // 微动 → 回到起点
        target = startIndex;
      }
      setSettled(target);
      onMove(target);
      animateTrackTo(track, setOffset, target, width);
    };

    viewport.addEventListener('pointerdown', down);
    viewport.addEventListener('pointerup', up);
    viewport.addEventListener('pointercancel', up);
    return () => {
      viewport.removeEventListener('pointerdown', down);
      viewport.removeEventListener('pointerup', up);
      viewport.removeEventListener('pointercancel', up);
      if (moveHandler) viewport.removeEventListener('touchmove', moveHandler);
    };
  };

  // 主轮播手势（详情页）
  useEffect(() => {
    const detach = attachGesture(
      scrollRef.current,
      mainTrackRef.current,
      () => mainSettledRef.current,
      (v) => { mainSettledRef.current = v; },
      (index) => setCurrentImageIndex(index),
      setMainOffset,
      () => mainOffsetRef.current,
    );
    return detach;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images]);

  // 全屏轮播手势（zoom overlay 条件渲染，zoomed 后挂载）
  useEffect(() => {
    if (!zoomed || !zoomScrollRef.current) return;
    const detach = attachGesture(
      zoomScrollRef.current,
      zoomTrackRef.current,
      () => zoomSettledRef.current,
      (v) => { zoomSettledRef.current = v; lastZoomIndexRef.current = v; },
      (index) => { setCurrentImageIndex(index); lastZoomIndexRef.current = index; syncMainCarousel(index); },
      setZoomOffset,
      () => zoomOffsetRef.current,
    );
    return detach;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomed, images]);

  // 首页卡片点开详情页时带图片索引进入：images 首次就绪后主轮播定位到同一张
  // （post 异步加载，进入时 track 尚未有图片；ref 对比确保只在首次就绪时执行一次）
  const prevImagesRef = useRef<string[] | null>(null);
  useEffect(() => {
    if (prevImagesRef.current === images) return;
    prevImagesRef.current = images;
    if (currentImageIndex <= 0 || !scrollRef.current) return;
    const targetIndex = Math.min(currentImageIndex, Math.max(images.length - 1, 0));
    mainSettledRef.current = targetIndex;
    setMainOffset((scrollRef.current?.clientWidth || 0) * targetIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images]);

  // 进入全屏：zoomOverlay 条件渲染后轨道为 0，需定位到当前图片
  // （rAF 等一轮布局：图片异步加载不影响 clientWidth，但确保容器已排布）
  useEffect(() => {
    if (!zoomed || !zoomScrollRef.current) return;
    zoomSettledRef.current = currentImageIndex;
    const raf = requestAnimationFrame(() => {
      setZoomOffset((zoomScrollRef.current?.clientWidth || 0) * currentImageIndex);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomed]);

  // 退出全屏：主轮播对齐到全屏最后停靠的图片。
  // 全屏滑动时主轮播已实时同步（syncMainCarousel），此处仅兜底瞬时对齐，
  // 不用动画——避免退出后看到"自己翻页追过去"的动画；
  // 以 lastZoomIndexRef 为准，避免读取可能尚未更新的 state
  useEffect(() => {
    if (zoomed || !scrollRef.current) return;
    const target = (scrollRef.current?.clientWidth || 0) * lastZoomIndexRef.current;
    mainSettledRef.current = lastZoomIndexRef.current;
    setMainOffset(target);
  }, [zoomed]);

  // 卸载时清理 transition 定时器
  useEffect(() => {
    return () => clearTransTimers();
  }, []);

  const scrollToIndex = (index: number) => {
    setCurrentImageIndex(index);
    if (zoomed && zoomScrollRef.current) {
      zoomSettledRef.current = index;
      animateTrackTo(zoomTrackRef.current, setZoomOffset, index, zoomScrollRef.current.clientWidth || 0);
      // 全屏内点箭头/指示点切换时，主轮播同步跟随（退出全屏无追回动画）
      syncMainCarousel(index);
    } else if (scrollRef.current) {
      mainSettledRef.current = index;
      animateTrackTo(mainTrackRef.current, setMainOffset, index, scrollRef.current.clientWidth || 0);
    }
  };

  const goToPrev = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const total = images.length || 1;
    const newIndex = (currentImageIndex - 1 + total) % total;
    scrollToIndex(newIndex);
  };

  const goToNext = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const total = images.length || 1;
    const newIndex = (currentImageIndex + 1) % total;
    scrollToIndex(newIndex);
  };

  return (
    <>
      <div className={styles.imageSection}>
        {post.video_url ? (
          <video ref={detailVideoRef} src={resolveMediaUrl(post.video_url) || undefined} controls className={styles.video} poster={resolveMediaUrl(post.video_cover) || undefined} onLoadedMetadata={(e) => { e.currentTarget.volume = 0.8; }} />
        ) : (
          <>
            <div className={styles.imageCarousel} ref={scrollRef}>
              <div className={styles.imageTrack} ref={mainTrackRef}>
                {images.map((url, i) => (
                  <img
                    key={i}
                    src={resolveMediaUrl(url) || url}
                    alt={post.title}
                    className={styles.image}
                    // 点击图片进入全屏查看（触摸滑动由浏览器识别为滚动，不会触发 click）
                    onClick={(e) => {
                      e.stopPropagation(); // 防止冒泡关闭详情 overlay
                      setZoomed(true);
                    }}
                  />
                ))}
              </div>
            </div>
            <button className={styles.zoomBtn} onClick={(e) => { e.stopPropagation(); setZoomed(true); }} aria-label="放大查看">
              <ZoomIn size={20} />
            </button>
            {images.length > 1 && (
              <>
                <button className={`${styles.carouselBtn} ${styles.carouselPrev}`} onClick={goToPrev} aria-label="上一张">
                  <ChevronLeft size={28} />
                </button>
                <button className={`${styles.carouselBtn} ${styles.carouselNext}`} onClick={goToNext} aria-label="下一张">
                  <ChevronRight size={28} />
                </button>
                <div className={styles.imageDots}>
                  {images.map((_, i) => (
                    <span
                      key={i}
                      className={`${styles.imageDot} ${i === currentImageIndex ? styles.active : ''}`}
                      onClick={(e) => { e.stopPropagation(); scrollToIndex(i); }}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {zoomed && (
        <div className={styles.zoomOverlay} onClick={(e) => { e.stopPropagation(); setZoomed(false); }}>
          <button className={styles.close} onClick={(e) => { e.stopPropagation(); setZoomed(false); }} aria-label="关闭缩放">
            <X size={28} />
          </button>
          <div className={styles.zoomContent}>
            {images.length > 1 && (
              <button className={`${styles.zoomNav} ${styles.zoomPrev}`} onClick={(e) => { e.stopPropagation(); goToPrev(e); }} aria-label="上一张">
                <ChevronLeft size={32} />
              </button>
            )}
            <div
              className={styles.zoomCarousel}
              ref={zoomScrollRef}
            >
              <div className={styles.zoomTrack} ref={zoomTrackRef}>
                {images.map((url, i) => (
                  <img
                    key={i}
                    src={resolveMediaUrl(url) || url}
                    alt=""
                    className={styles.zoomImage}
                    onClick={(e) => { e.stopPropagation(); setZoomed(false); }}
                  />
                ))}
              </div>
            </div>
            {images.length > 1 && (
              <button className={`${styles.zoomNav} ${styles.zoomNext}`} onClick={(e) => { e.stopPropagation(); goToNext(e); }} aria-label="下一张">
                <ChevronRight size={32} />
              </button>
            )}
            {images.length > 1 && (
              <div className={styles.zoomDots}>
                {images.map((_, i) => (
                  <span
                    key={i}
                    className={`${styles.imageDot} ${i === currentImageIndex ? styles.active : ''}`}
                    onClick={(e) => { e.stopPropagation(); scrollToIndex(i); }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
