/**
 * ============================================================
 * 帖子媒体展示组件 (PostMedia)
 * ============================================================
 * PostDetail 的媒体区（图片轮播/视频/缩放查看）抽取：
 * - 图片轮播 + 指示点 + 左右切换（受控组件，索引/缩放状态由调用方管理）
 * - 详情页主轮播：无自动轮播，手势跟手翻页（原生滚动分页，合成器驱动）
 * - 缩放查看 overlay（全屏）：点击进入/退出，滑动翻页
 * - **Capacitor 环境下优先走原生查看器**（NativeImageViewer：
 *   ViewPager2 + 原生缩放手势 + 下拉关闭 + 缩略图 Hero 转场），
 *   插件不可用（网页端/桌面）时回退到本组件的 Web 覆盖层
 * - 手势/轨道通用逻辑已拆出至 hooks/useTransformCarousel
 * ============================================================
 */

import { useCallback, useEffect, useLayoutEffect, useRef, RefObject } from 'react';
import { X, ZoomIn, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Post } from '../../types';
import { resolveMediaUrl } from '../../utils';
import { useTransformCarousel } from '../../hooks/useTransformCarousel';
import { useImagePinchZoom } from '../../hooks/useImagePinchZoom';
import { useCancelableClose } from '../../hooks/useCancelableClose';
import {
  authHeadersFor,
  isNativeViewerAvailable,
  onNativeViewerWillClose,
  openNativeViewer,
  rectOf,
  rectsOfTrack,
} from '../../lib/nativeImageViewer';
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
  /** 是否有「本组件打开的」原生查看器会话（willClose 通知只认自己那次） */
  const nativeOpenRef = useRef(false);

  // 两个 transform 轨道实例（主轮播 + 全屏轮播）：
  // 各持 offsetRef/settledRef/transition 定时器与自己的 animateTrackTo
  // （手势/轨道逻辑已拆出至 useTransformCarousel，行为不变）
  const mainCarousel = useTransformCarousel(mainTrackRef);
  const zoomCarousel = useTransformCarousel(zoomTrackRef);
  // 全屏图片双指缩放/平移（1x–4x）：放大态下轮播翻页手势让位（isZoomed）
  const pinchZoom = useImagePinchZoom();
  // 单击关闭两阶段编排：轻点后**先不播任何动画**，等双击窗口（+余量）过去、
  // 确认不会再有第二次轻点，才淡出关闭（见 useCancelableClose 的延迟策略）。
  // 窗口内第二次轻点撤销关闭；因淡出尚未开始，遮罩透明度全程未变，
  // 不会透出下层详情页——这是「双击放大时闪烁、漏出详情页」的根因修复
  const { closing, requestClose, cancelClose } = useCancelableClose(() => setZoomed(false));

  // 全屏滑动时主轮播同步跟随（退出全屏无追回动画）。
  // ★ 拿不到宽度就什么都不做：setOffset(0 * index) 会把主轮播悄悄拽回第一张
  //   —— 这正是「退出全屏/退出详情后，主轮播和刚才看的不是同一张」的一种成因。
  const syncMainCarousel = (index: number) => {
    const width = mainCarousel.getSlideWidth() || scrollRef.current?.clientWidth || 0;
    if (!(width > 0)) return;
    mainCarousel.setSettled(index);
    mainCarousel.setOffset(width * index);
  };

  /**
   * 打开全屏看图：
   * - Capacitor 原生环境 → 原生查看器（ViewPager2 + 原生手势 + 下拉关闭 +
   *   从缩略图 Hero 放大进入 / 退出飞回缩略图）；打开失败/插件不可用 → 回退下面的 Web 覆盖层；
   * - 原生可用时**不渲染** Web 覆盖层，避免两套 UI 叠加。
   */
  const openViewer = useCallback(
    (index: number, thumbEl: Element | null) => {
      const urls = images.map((u) => resolveMediaUrl(u) || u);
      if (!isNativeViewerAvailable()) {
        setZoomed(true);
        return;
      }
      const rect = rectOf(thumbEl);
      // 每张各自的矩形：退出时飞回「当前这一张」的缩略图（不是打开时那张）
      const rects = rectsOfTrack(mainTrackRef.current);
      nativeOpenRef.current = true;
      void openNativeViewer({
        images: urls,
        index,
        // 鉴权图片（/api/）带上 token：<img> 无法自定义请求头，原生 HTTP 可以
        ...authHeadersFor(urls),
        ...(rect ? { rect } : {}),
        ...(rects.length > 0 ? { rects } : {}),
      }).then((res) => {
        nativeOpenRef.current = false;
        if (res === null) {
          setZoomed(true); // 原生打开失败 → 回退 Web 覆盖层
          return;
        }
        // 用户可能在原生里翻过页：回来后同步主轮播与索引
        // （正常情况下 willClose 已经同步过一次，这里只是兜底）
        if (res.index >= 0 && res.index !== index) {
          setCurrentImageIndex(res.index);
          lastZoomIndexRef.current = res.index;
          syncMainCarousel(res.index);
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [images]
  );

  /**
   * 原生查看器**退场飞行开始时**就把主轮播对齐到要返回的那一张。
   *
   * 等 open() 的 Promise（Activity 真正结束）再同步就晚了：那时黑幕已经揭开，
   * 会看到「飞回来的图是第 3 张、背景却是第 1 张」再跳一下。黑幕期间完成对齐，
   * 揭开时就是同一张缩略图，接缝不可见。
   */
  useEffect(() => {
    return onNativeViewerWillClose((index) => {
      if (!nativeOpenRef.current || index < 0) return; // 不是本组件打开的那次会话
      setCurrentImageIndex(index);
      lastZoomIndexRef.current = index;
      syncMainCarousel(index);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  // ★ 绑定到 **.zoomTrack**（原生滚动容器）而不是外层 .zoomCarousel：
  //   放大时要锁住的正是这个会滚动的元素（lockScrollWhenZoomed →
  //   内联 touch-action:none + overflow-x:hidden），锁在外层拦不住它。
  // 绑定到当前显示的图片元素（track 内 index 位置的 img）。
  // zoomed 条件渲染后挂载；放大态下轮播翻页已让位（见 attachGesture isZoomed）。
  // 进入全屏/切换图片时复位缩放（防上次会话残留放大态）。
  // onSingleTap：触摸轻点启动关闭（淡出晚于双击窗口，双击可撤销且无闪烁）；
  // onSingleTapCancelled：窗口内第二次轻点撤销关闭并转双击缩放。
  // 桌面鼠标单击仍走 zoomImage 的 onClick（触摸 click 已被 hook 吞掉不冲突）
  useEffect(() => {
    if (!zoomed || !zoomTrackRef.current || !zoomScrollRef.current) return;
    pinchZoom.reset();
    const detach = pinchZoom.attach(
      zoomTrackRef.current,
      () => {
        const track = zoomTrackRef.current;
        return track ? (track.children[currentImageIndex] as HTMLElement | null) : null;
      },
      {
        onSingleTap: requestClose,
        onSingleTapCancelled: cancelClose,
        lockScrollWhenZoomed: true,
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
                    // 点击图片进入全屏查看（原生环境走原生查看器，网页端走覆盖层）；
                    // 触摸滑动由浏览器识别为滚动，不会触发 click
                    onClick={(e) => {
                      e.stopPropagation(); // 防止冒泡关闭详情 overlay
                      openViewer(i, e.currentTarget);
                    }}
                  />
                ))}
              </div>
            </div>
            <button
              className={styles.zoomBtn}
              onClick={(e) => {
                e.stopPropagation();
                // 用当前这张缩略图做 Hero 起点（取自轮播轨道里的对应元素）
                const cur = mainTrackRef.current?.children[currentImageIndex] ?? null;
                openViewer(currentImageIndex, cur);
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
          className={`${styles.zoomOverlay}${closing ? ` ${styles.closing}` : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            requestClose();
          }}
        >
          <button
            className={styles.close}
            onClick={(e) => {
              e.stopPropagation();
              requestClose();
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
                      requestClose();
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
