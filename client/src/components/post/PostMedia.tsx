/**
 * ============================================================
 * 帖子媒体展示组件 (PostMedia)
 * ============================================================
 * PostDetail 的媒体区（图片轮播/视频/缩放查看）抽取：
 * - 图片轮播 + 指示点 + 左右切换（受控组件，索引/缩放状态由调用方管理）
 * - 详情页主轮播：无自动轮播，手势跟手翻页（transform 轨道驱动，GPU 合成器 60fps）
 * - 缩放查看 overlay（全屏）：点击进入/退出，滑动翻页（同样 transform 驱动）
 * - 手势/轨道通用逻辑已拆出至 hooks/useTransformCarousel（行为不变）
 * ============================================================
 */

import { useEffect, useRef, RefObject } from 'react';
import { X, ZoomIn, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Post } from '../../types';
import { resolveMediaUrl } from '../../utils';
import { useTransformCarousel } from '../../hooks/useTransformCarousel';
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
  post,
  images,
  detailVideoRef,
  currentImageIndex,
  setCurrentImageIndex,
  zoomed,
  setZoomed,
}: PostMediaProps) {
  // viewport（宽度来源 + touch-action）与 transform 轨道
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomScrollRef = useRef<HTMLDivElement>(null);
  const mainTrackRef = useRef<HTMLDivElement>(null);
  const zoomTrackRef = useRef<HTMLDivElement>(null);
  // 全屏内最后停靠的图片索引（同步写入 ref，退出时以此为准，避免依赖可能过期的 state）
  const lastZoomIndexRef = useRef(0);

  // 两个 transform 轨道实例（主轮播 + 全屏轮播）：
  // 各持 offsetRef/settledRef/transition 定时器与自己的 animateTrackTo
  // （手势/轨道逻辑已拆出至 useTransformCarousel，行为不变）
  const mainCarousel = useTransformCarousel(mainTrackRef);
  const zoomCarousel = useTransformCarousel(zoomTrackRef);

  // 全屏滑动时主轮播同步跟随（退出全屏无追回动画）
  const syncMainCarousel = (index: number) => {
    const width = scrollRef.current?.clientWidth || 0;
    mainCarousel.setOffset(width * index);
  };

  // 主轮播手势（详情页）
  useEffect(() => {
    const detach = mainCarousel.attachGesture(
      scrollRef.current,
      mainTrackRef.current,
      images.length,
      (index) => setCurrentImageIndex(index)
    );
    return detach;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images]);

  // 全屏轮播手势（zoom overlay 条件渲染，zoomed 后挂载）
  useEffect(() => {
    if (!zoomed || !zoomScrollRef.current) return;
    const detach = zoomCarousel.attachGesture(
      zoomScrollRef.current,
      zoomTrackRef.current,
      images.length,
      (index) => {
        setCurrentImageIndex(index);
        lastZoomIndexRef.current = index;
        syncMainCarousel(index);
      },
      (v) => {
        lastZoomIndexRef.current = v;
      }
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
    mainCarousel.setSettled(targetIndex);
    mainCarousel.setOffset((scrollRef.current?.clientWidth || 0) * targetIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, mainCarousel]);

  // 进入全屏：zoomOverlay 条件渲染后轨道为 0，需定位到当前图片
  // （rAF 等一轮布局：图片异步加载不影响 clientWidth，但确保容器已排布）
  useEffect(() => {
    if (!zoomed || !zoomScrollRef.current) return;
    zoomCarousel.setSettled(currentImageIndex);
    const raf = requestAnimationFrame(() => {
      zoomCarousel.setOffset((zoomScrollRef.current?.clientWidth || 0) * currentImageIndex);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomed, zoomCarousel]);

  // 退出全屏：主轮播对齐到全屏最后停靠的图片。
  // 全屏滑动时主轮播已实时同步（syncMainCarousel），此处仅兜底瞬时对齐，
  // 不用动画——避免退出后看到"自己翻页追过去"的动画；
  // 以 lastZoomIndexRef 为准，避免读取可能尚未更新的 state
  useEffect(() => {
    if (zoomed || !scrollRef.current) return;
    const target = (scrollRef.current?.clientWidth || 0) * lastZoomIndexRef.current;
    mainCarousel.setSettled(lastZoomIndexRef.current);
    mainCarousel.setOffset(target);
  }, [zoomed, mainCarousel]);

  // （卸载清理 transition 定时器已随手势/轨道逻辑移入 useTransformCarousel）
  const scrollToIndex = (index: number) => {
    setCurrentImageIndex(index);
    if (zoomed && zoomScrollRef.current) {
      zoomCarousel.setSettled(index);
      zoomCarousel.animateTrackTo(index, zoomScrollRef.current.clientWidth || 0);
      // 全屏内点箭头/指示点切换时，主轮播同步跟随（退出全屏无追回动画）
      syncMainCarousel(index);
    } else if (scrollRef.current) {
      mainCarousel.setSettled(index);
      mainCarousel.animateTrackTo(index, scrollRef.current.clientWidth || 0);
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
          <video
            ref={detailVideoRef}
            src={resolveMediaUrl(post.video_url) || undefined}
            controls
            className={styles.video}
            poster={resolveMediaUrl(post.video_cover) || undefined}
            onLoadedMetadata={(e) => {
              e.currentTarget.volume = 0.8;
            }}
          />
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
            <button
              className={styles.zoomBtn}
              onClick={(e) => {
                e.stopPropagation();
                setZoomed(true);
              }}
              aria-label="放大查看"
            >
              <ZoomIn size={20} />
            </button>
            {images.length > 1 && (
              <>
                <button
                  className={`${styles.carouselBtn} ${styles.carouselPrev}`}
                  onClick={goToPrev}
                  aria-label="上一张"
                >
                  <ChevronLeft size={28} />
                </button>
                <button
                  className={`${styles.carouselBtn} ${styles.carouselNext}`}
                  onClick={goToNext}
                  aria-label="下一张"
                >
                  <ChevronRight size={28} />
                </button>
                <div className={styles.imageDots}>
                  {images.map((_, i) => (
                    <span
                      key={i}
                      className={`${styles.imageDot} ${i === currentImageIndex ? styles.active : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        scrollToIndex(i);
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {zoomed && (
        <div
          className={styles.zoomOverlay}
          onClick={(e) => {
            e.stopPropagation();
            setZoomed(false);
          }}
        >
          <button
            className={styles.close}
            onClick={(e) => {
              e.stopPropagation();
              setZoomed(false);
            }}
            aria-label="关闭缩放"
          >
            <X size={28} />
          </button>
          <div className={styles.zoomContent}>
            {images.length > 1 && (
              <button
                className={`${styles.zoomNav} ${styles.zoomPrev}`}
                onClick={(e) => {
                  e.stopPropagation();
                  goToPrev(e);
                }}
                aria-label="上一张"
              >
                <ChevronLeft size={32} />
              </button>
            )}
            <div className={styles.zoomCarousel} ref={zoomScrollRef}>
              <div className={styles.zoomTrack} ref={zoomTrackRef}>
                {images.map((url, i) => (
                  <img
                    key={i}
                    src={resolveMediaUrl(url) || url}
                    alt=""
                    className={styles.zoomImage}
                    onClick={(e) => {
                      e.stopPropagation();
                      setZoomed(false);
                    }}
                  />
                ))}
              </div>
            </div>
            {images.length > 1 && (
              <button
                className={`${styles.zoomNav} ${styles.zoomNext}`}
                onClick={(e) => {
                  e.stopPropagation();
                  goToNext(e);
                }}
                aria-label="下一张"
              >
                <ChevronRight size={32} />
              </button>
            )}
            {images.length > 1 && (
              <div className={styles.zoomDots}>
                {images.map((_, i) => (
                  <span
                    key={i}
                    className={`${styles.imageDot} ${i === currentImageIndex ? styles.active : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      scrollToIndex(i);
                    }}
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
