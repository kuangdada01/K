/**
 * ============================================================
 * 帖子媒体展示组件 (PostMedia)
 * ============================================================
 * PostDetail 的媒体区（图片轮播/视频/缩放查看）抽取：
 * - 图片轮播 + 指示点 + 左右切换（受控组件，索引/缩放状态由调用方管理）
 * - 详情页主轮播：无自动轮播，手势自由滑动（无极）
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
  // 全屏内滑动结束后的分页吸附定时器（JS 兜底：iOS/WebView 的 scroll-snap 不可靠）
  const zoomSnapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 详情页主轮播：跟随用户手势自由滑动（无极），仅回写索引；不做整页吸附
  const handleScroll = () => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    setCurrentImageIndex(Math.round(el.scrollLeft / el.clientWidth));
  };

  // 全屏内滚动：实时回写索引；滚动停止后吸附到最近整页（分页，不是无极滑动）
  const handleZoomScroll = () => {
    if (!zoomScrollRef.current) return;
    const el = zoomScrollRef.current;
    const width = el.clientWidth;
    const index = Math.round(el.scrollLeft / width);
    setCurrentImageIndex(index);
    if (zoomSnapTimerRef.current) clearTimeout(zoomSnapTimerRef.current);
    zoomSnapTimerRef.current = setTimeout(() => {
      const target = width * Math.round(el.scrollLeft / width);
      if (Math.abs(el.scrollLeft - target) > 4) {
        el.scrollTo({ left: target, behavior: 'smooth' });
      }
    }, 120);
  };

  // 进入全屏：zoomOverlay 条件渲染后 scrollLeft 为 0，需定位到当前图片
  // （rAF 等一轮布局：图片异步加载不影响 clientWidth，但确保容器已排布）
  useEffect(() => {
    if (!zoomed || !zoomScrollRef.current) return;
    const el = zoomScrollRef.current;
    const raf = requestAnimationFrame(() => {
      el.scrollLeft = el.clientWidth * currentImageIndex;
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomed]);

  // 退出全屏：主轮播对齐到全屏中选中的图片（避免 dots 高亮与实际显示不一致）
  useEffect(() => {
    if (zoomed || !scrollRef.current) return;
    const el = scrollRef.current;
    const target = el.clientWidth * currentImageIndex;
    if (Math.abs(el.scrollLeft - target) > 4) {
      el.scrollTo({ left: target, behavior: 'smooth' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomed]);

  const scrollToIndex = (index: number) => {
    setCurrentImageIndex(index);
    if (zoomed && zoomScrollRef.current) {
      const width = zoomScrollRef.current.clientWidth;
      zoomScrollRef.current.scrollTo({ left: width * index, behavior: 'smooth' });
    } else if (scrollRef.current) {
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
