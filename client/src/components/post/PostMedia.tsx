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
  // 主轮播/全屏内滑动结束后的分页吸附定时器（JS 兜底：iOS/WebView 的 scroll-snap 不可靠）
  const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomSnapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 全屏内最后停靠的图片索引（同步写入 ref，退出时以此为准，避免依赖可能过期的 state）
  const lastZoomIndexRef = useRef(0);
  // 上次稳定停靠的图片索引：快速甩动时限制一次手势最多翻一页（防惯性一下跳过 2 张）
  const mainSettledRef = useRef(0);
  const zoomSettledRef = useRef(0);
  // 最近一次滚动事件的速度（px/ms）：区分快速甩动（限制翻页）与缓慢拖动（按实际落点吸附）
  const scrollVelocityRef = useRef(0);
  const zoomVelocityRef = useRef(0);
  const lastScrollEventRef = useRef({ time: 0, left: 0 });
  const lastZoomScrollEventRef = useRef({ time: 0, left: 0 });

  // 主轮播滚动：实时回写索引；记录速度；滚动停止后吸附到整页
  // （快速甩动时最多前进/后退一页，WebView 惯性滚动不会一次跨过多张）
  const handleScroll = () => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const width = el.clientWidth;
    const index = Math.round(el.scrollLeft / width);
    setCurrentImageIndex(index);
    const now = performance.now();
    const dt = now - lastScrollEventRef.current.time;
    const dx = el.scrollLeft - lastScrollEventRef.current.left;
    scrollVelocityRef.current = dt > 0 ? Math.abs(dx) / dt : 0;
    lastScrollEventRef.current = { time: now, left: el.scrollLeft };
    if (snapTimerRef.current) clearTimeout(snapTimerRef.current);
    snapTimerRef.current = setTimeout(() => {
      const raw = Math.round(el.scrollLeft / width);
      const last = mainSettledRef.current;
      let target = raw;
      // 快速甩动（惯性大）只允许前进/后退一页；缓慢拖动按实际落点吸附
      if (scrollVelocityRef.current > 0.4) {
        target = Math.max(0, Math.min(images.length - 1, raw > last ? last + 1 : raw < last ? last - 1 : raw));
      }
      const targetLeft = width * target;
      if (Math.abs(el.scrollLeft - targetLeft) > 4) {
        el.scrollTo({ left: targetLeft, behavior: 'smooth' });
      }
      mainSettledRef.current = target;
      setCurrentImageIndex(target);
    }, 120);
  };

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

  const handleZoomScroll = () => {
    if (!zoomScrollRef.current) return;
    const el = zoomScrollRef.current;
    const width = el.clientWidth;
    const index = Math.round(el.scrollLeft / width);
    setCurrentImageIndex(index);
    lastZoomIndexRef.current = index;
    syncMainCarousel(index);
    const now = performance.now();
    const dt = now - lastZoomScrollEventRef.current.time;
    const dx = el.scrollLeft - lastZoomScrollEventRef.current.left;
    zoomVelocityRef.current = dt > 0 ? Math.abs(dx) / dt : 0;
    lastZoomScrollEventRef.current = { time: now, left: el.scrollLeft };
    if (zoomSnapTimerRef.current) clearTimeout(zoomSnapTimerRef.current);
    zoomSnapTimerRef.current = setTimeout(() => {
      // 已退出全屏（节点脱离文档）则不再吸附/同步，防止把主轮播拽回第一张
      if (!el.isConnected) return;
      const raw = Math.round(el.scrollLeft / width);
      const last = zoomSettledRef.current;
      let target = raw;
      // 快速甩动（惯性大）只允许前进/后退一页；缓慢拖动按实际落点吸附
      if (zoomVelocityRef.current > 0.4) {
        target = Math.max(0, Math.min(images.length - 1, raw > last ? last + 1 : raw < last ? last - 1 : raw));
      }
      const targetLeft = width * target;
      if (Math.abs(el.scrollLeft - targetLeft) > 4) {
        el.scrollTo({ left: targetLeft, behavior: 'smooth' });
      }
      // 吸附落位后再同步一次主轮播，确保退出时两者完全一致
      zoomSettledRef.current = target;
      lastZoomIndexRef.current = target;
      setCurrentImageIndex(target);
      syncMainCarousel(target);
    }, 120);
  };

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

  // 卸载时清理吸附定时器，防止组件销毁后回调操作已脱离 DOM 的节点
  useEffect(() => {
    return () => {
      if (snapTimerRef.current) clearTimeout(snapTimerRef.current);
      if (zoomSnapTimerRef.current) clearTimeout(zoomSnapTimerRef.current);
    };
  }, []);

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
            <div className={styles.imageCarousel} ref={scrollRef} onScroll={handleScroll}>
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
              onScroll={handleZoomScroll}
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
