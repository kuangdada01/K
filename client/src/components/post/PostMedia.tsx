/**
 * ============================================================
 * 帖子媒体展示组件 (PostMedia)
 * ============================================================
 * PostDetail 的媒体区（图片轮播/视频/缩放查看）抽取：
 * - 图片轮播 + 指示点 + 左右切换（受控组件，索引/暂停/缩放状态由调用方管理）
 * - 缩放查看 overlay
 * - 3 秒自动轮播（仅当未暂停、未缩放、多图时）
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
  isPaused: boolean;
  setIsPaused: (v: boolean) => void;
  zoomed: boolean;
  setZoomed: (v: boolean) => void;
}

export default function PostMedia({
  post, images, detailVideoRef,
  currentImageIndex, setCurrentImageIndex,
  isPaused, setIsPaused,
  zoomed, setZoomed,
}: PostMediaProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomScrollRef = useRef<HTMLDivElement>(null);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const scrollLeft = scrollRef.current.scrollLeft;
    const width = scrollRef.current.clientWidth;
    setCurrentImageIndex(Math.round(scrollLeft / width));
  };

  const handleZoomScroll = () => {
    if (!zoomScrollRef.current) return;
    const scrollLeft = zoomScrollRef.current.scrollLeft;
    const width = zoomScrollRef.current.clientWidth;
    setCurrentImageIndex(Math.round(scrollLeft / width));
  };

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

  // 自动轮播
  useEffect(() => {
    if (isPaused || zoomed) return;
    if (images.length <= 1) return;
    const timer = setInterval(() => {
      setCurrentImageIndex(prev => {
        const next = (prev + 1) % images.length;
        if (scrollRef.current) {
          const width = scrollRef.current.clientWidth;
          scrollRef.current.scrollTo({ left: width * next, behavior: 'smooth' });
        }
        return next;
      });
    }, 3000);
    return () => clearInterval(timer);
    // 历史实现依赖 post/images/isPaused（zoomed 变化时由条件短路，不重建定时器）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post, isPaused]);

  return (
    <>
      <div
        className={styles.imageSection}
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
      >
        {post.video_url ? (
          <video ref={detailVideoRef} src={resolveMediaUrl(post.video_url) || undefined} controls className={styles.video} poster={resolveMediaUrl(post.video_cover) || undefined} onLoadedMetadata={(e) => { e.currentTarget.volume = 0.8; }} />
        ) : (
          <>
            <div className={styles.imageCarousel} ref={scrollRef} onScroll={handleScroll}>
              {images.map((url, i) => (
                <img key={i} src={resolveMediaUrl(url) || url} alt={post.title} className={styles.image} />
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
            <div className={styles.zoomCarousel} ref={zoomScrollRef} onScroll={handleZoomScroll}>
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
