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

import { useEffect, useLayoutEffect, useRef, RefObject } from 'react';
import { X, ZoomIn, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Post } from '../../types';
import { resolveMediaUrl } from '../../utils';
import { useTransformCarousel } from '../../hooks/useTransformCarousel';
import { useImagePinchZoom } from '../../hooks/useImagePinchZoom';
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
  // 全屏图片双指缩放/平移（1x–4x）：放大态下轮播翻页手势让位（isZoomed）
  const pinchZoom = useImagePinchZoom();

  // 全屏滑动时主轮播同步跟随（退出全屏无追回动画）
  const syncMainCarousel = (index: number) => {
    mainCarousel.setOffset(mainCarousel.getSlideWidth() * index);
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

  // 全屏轮播手势（zoom overlay 条件渲染，zoomed 后挂载）。
  // 放大态（isZoomed）下轮播翻页失效，平移交给 pinchZoom
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
      },
      () => pinchZoom.isZoomed()
    );
    return detach;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomed, images]);

  // 全屏双指缩放/平移 + 双击放大/单击关闭：
  // 绑定到当前显示的图片元素（track 内 index 位置的 img）。
  // zoomed 条件渲染后挂载；放大态下轮播翻页已让位（见 attachGesture isZoomed）。
  // 进入全屏/切换图片时复位缩放（防上次会话残留放大态）。
  // onSingleTap：触摸轻点（非双击）延迟关闭全屏——双击由 hook 内部判定缩放；
  // 桌面鼠标单击仍走 zoomImage 的 onClick（触摸 click 已被 hook 吞掉不冲突）
  useEffect(() => {
    if (!zoomed || !zoomScrollRef.current) return;
    pinchZoom.reset();
    const detach = pinchZoom.attach(
      zoomScrollRef.current,
      () => {
        const track = zoomTrackRef.current;
        return track ? (track.children[currentImageIndex] as HTMLElement | null) : null;
      },
      {
        onSingleTap: () => setZoomed(false),
      }
    );
    return detach;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomed, currentImageIndex]);

  // 切换图片（箭头/指示点/手势落位）时复位缩放与图片 transform，
  // 防止上一张的放大态带到下一张
  useEffect(() => {
    pinchZoom.reset();
    const track = zoomTrackRef.current;
    if (track) {
      for (const child of Array.from(track.children)) {
        if (child instanceof HTMLElement) child.style.transform = '';
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentImageIndex]);

  // 首页卡片点开详情页时带图片索引进入：images 首次就绪后主轮播定位到同一张
  // （post 异步加载，进入时 track 尚未有图片；ref 对比确保只在首次就绪时执行一次。
  //  useLayoutEffect：首帧绘制前定位，避免先画出第 1 张并在右侧露出下一张边缘）
  const prevImagesRef = useRef<string[] | null>(null);
  useLayoutEffect(() => {
    if (prevImagesRef.current === images) return;
    prevImagesRef.current = images;
    if (currentImageIndex <= 0 || !scrollRef.current) return;
    const targetIndex = Math.min(currentImageIndex, Math.max(images.length - 1, 0));
    mainCarousel.setSettled(targetIndex);
    mainCarousel.setOffset(mainCarousel.getSlideWidth() * targetIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, mainCarousel]);

  // 进入全屏：zoomOverlay 条件渲染后轨道为 0，需定位到当前图片。
  // ★ useLayoutEffect 而非 useEffect+rAF：在首帧绘制前同步定位，
  // 否则第一帧会先画出第 1 张图并在右侧露出下一张图的边缘
  // （用户反馈"图片全屏后会显示右边的照片边缘"的根因之一）。
  // 偏移按 getSlideWidth()（图片实际渲染宽度）计算——clientWidth 取整
  // 会在小数宽度（95vw）下逐页累积偏差，右边缘露出下一张（另一根因）。
  useLayoutEffect(() => {
    if (!zoomed || !zoomScrollRef.current) return;
    zoomCarousel.setSettled(currentImageIndex);
    zoomCarousel.setOffset(zoomCarousel.getSlideWidth() * currentImageIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomed, zoomCarousel]);

  // 退出全屏：主轮播对齐到全屏最后停靠的图片。
  // 全屏滑动时主轮播已实时同步（syncMainCarousel），此处仅兜底瞬时对齐，
  // 不用动画——避免退出后看到"自己翻页追过去"的动画；
  // 以 lastZoomIndexRef 为准，避免读取可能尚未更新的 state。
  // useLayoutEffect：退出绘制前对齐，避免露出错位的一帧
  useLayoutEffect(() => {
    if (zoomed || !scrollRef.current) return;
    mainCarousel.setSettled(lastZoomIndexRef.current);
    mainCarousel.setOffset(mainCarousel.getSlideWidth() * lastZoomIndexRef.current);
  }, [zoomed, mainCarousel]);

  // （卸载清理 transition 定时器已随手势/轨道逻辑移入 useTransformCarousel）
  const scrollToIndex = (index: number) => {
    setCurrentImageIndex(index);
    if (zoomed && zoomScrollRef.current) {
      zoomCarousel.setSettled(index);
      zoomCarousel.animateTrackTo(index, zoomCarousel.getSlideWidth() || 1);
      // 全屏内点箭头/指示点切换时，主轮播同步跟随（退出全屏无追回动画）
      syncMainCarousel(index);
    } else if (scrollRef.current) {
      mainCarousel.setSettled(index);
      mainCarousel.animateTrackTo(index, mainCarousel.getSlideWidth() || 1);
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
