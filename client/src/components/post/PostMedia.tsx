/**
 * ============================================================
 * 帖子媒体展示组件 (PostMedia)
 * ============================================================
 * PostDetail 的媒体区（图片轮播/视频/缩放查看）抽取：
 * - 图片轮播 + 指示点 + 左右切换（受控组件，索引/缩放状态由调用方管理）
 * - 详情页主轮播：无自动轮播，滑动吸附翻到下一张完整图
 * - 缩放查看 overlay（全屏）：点击进入/退出，滑动吸附翻页
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomScrollRef = useRef<HTMLDivElement>(null);
  // 全屏内最后停靠的图片索引（同步写入 ref，退出时以此为准，避免依赖可能过期的 state）
  const lastZoomIndexRef = useRef(0);
  // 上次稳定停靠的图片索引：一次手势最多翻一页（防惯性一下跳过 2 张）
  const mainSettledRef = useRef(0);
  const zoomSettledRef = useRef(0);

  // —— 手势完全接管（WebView 原生惯性/scroll-snap 不可控，快速滑动会跨页）——
  // 每个轮播容器：pointerdown 记录起点 → pointermove 手动驱动 scrollLeft（跟手）→
  // pointerup 按位移/速度决定翻一页并平滑落位。touch-action:none 禁掉原生滚动。

  // 全屏内滚动：实时回写索引，并同步主轮播滚动位置（详情页跟随全屏翻页，
  // 退出全屏时详情页已停在同一张图，无"翻页追回"动画）；快速甩动最多翻一页
  const syncMainCarousel = (index: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const target = el.clientWidth * index;
    if (Math.abs(el.scrollLeft - target) > 4) {
      el.scrollLeft = target; // 瞬时定位（详情页被全屏遮住，无动画需求）
    }
  };

  const attachGesture = (
    el: HTMLDivElement | null,
    getSettled: () => number,
    setSettled: (v: number) => void,
    onMove: (index: number) => void,
  ) => {
    if (!el) return () => {};
    let startX = 0;
    let startLeft = 0;
    let startIndex = 0;
    let active = false;
    let moveHandler: ((e: TouchEvent) => void) | null = null;

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      active = true;
      startX = e.clientX;
      startLeft = el.scrollLeft;
      startIndex = getSettled();
      moveHandler = (te: TouchEvent) => {
        if (!active || te.touches.length !== 1) return;
        te.preventDefault();
        const dx = te.touches[0].clientX - startX;
        el.scrollLeft = startLeft - dx;
      };
      // passive:false 才能 preventDefault 禁掉原生惯性滚动
      el.addEventListener('touchmove', moveHandler, { passive: false });
    };

    const up = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      if (moveHandler) {
        el.removeEventListener('touchmove', moveHandler);
        moveHandler = null;
      }
      const dx = el.scrollLeft - startLeft; // 正向 = 手指左滑（scrollLeft 增大）= 下一张
      const width = el.clientWidth || 1;
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
      el.scrollTo({ left: width * target, behavior: 'smooth' });
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (moveHandler) el.removeEventListener('touchmove', moveHandler);
    };
  };

  // 主轮播手势（详情页）
  useEffect(() => {
    const detach = attachGesture(
      scrollRef.current,
      () => mainSettledRef.current,
      (v) => { mainSettledRef.current = v; },
      (index) => setCurrentImageIndex(index),
    );
    return detach;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images]);

  // 全屏轮播手势（zoom overlay 条件渲染，zoomed 后挂载）
  useEffect(() => {
    if (!zoomed || !zoomScrollRef.current) return;
    const detach = attachGesture(
      zoomScrollRef.current,
      () => zoomSettledRef.current,
      (v) => { zoomSettledRef.current = v; lastZoomIndexRef.current = v; },
      (index) => { setCurrentImageIndex(index); lastZoomIndexRef.current = index; syncMainCarousel(index); },
    );
    return detach;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomed, images]);

  // 首页卡片点开详情页时带图片索引进入：images 首次就绪后主轮播定位到同一张
  // （post 异步加载，进入时 scrollRef 尚未有图片；ref 对比确保只在首次就绪时执行一次）
  const prevImagesRef = useRef<string[] | null>(null);
  useEffect(() => {
    if (prevImagesRef.current === images) return;
    prevImagesRef.current = images;
    if (currentImageIndex <= 0 || !scrollRef.current) return;
    const el = scrollRef.current;
    const targetIndex = Math.min(currentImageIndex, Math.max(images.length - 1, 0));
    mainSettledRef.current = targetIndex;
    const target = el.clientWidth * targetIndex;
    if (Math.abs(el.scrollLeft - target) > 4) {
      el.scrollTo({ left: target, behavior: 'auto' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images]);

  // 进入全屏：zoomOverlay 条件渲染后 scrollLeft 为 0，需定位到当前图片
  // （rAF 等一轮布局：图片异步加载不影响 clientWidth，但确保容器已排布）
  useEffect(() => {
    if (!zoomed || !zoomScrollRef.current) return;
    const el = zoomScrollRef.current;
    zoomSettledRef.current = currentImageIndex;
    const raf = requestAnimationFrame(() => {
      el.scrollLeft = el.clientWidth * currentImageIndex;
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomed]);

  // 退出全屏：主轮播对齐到全屏最后停靠的图片。
  // 全屏滑动时主轮播已实时同步（syncMainCarousel），此处仅兜底瞬时对齐，
  // 不用 smooth——避免退出后看到"自己翻页追过去"的动画；
  // 以 lastZoomIndexRef 为准，避免读取可能尚未更新的 state
  useEffect(() => {
    if (zoomed || !scrollRef.current) return;
    const el = scrollRef.current;
    const target = el.clientWidth * lastZoomIndexRef.current;
    mainSettledRef.current = lastZoomIndexRef.current;
    if (Math.abs(el.scrollLeft - target) > 4) {
      el.scrollLeft = target;
    }
  }, [zoomed]);

  const scrollToIndex = (index: number) => {
    setCurrentImageIndex(index);
    if (zoomed && zoomScrollRef.current) {
      zoomSettledRef.current = index;
      const width = zoomScrollRef.current.clientWidth;
      zoomScrollRef.current.scrollTo({ left: width * index, behavior: 'smooth' });
      // 全屏内点箭头/指示点切换时，主轮播同步跟随（退出全屏无追回动画）
      syncMainCarousel(index);
    } else if (scrollRef.current) {
      mainSettledRef.current = index;
      const width = scrollRef.current.clientWidth;
      scrollRef.current.scrollTo({ left: width * index, behavior: 'smooth' });
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
