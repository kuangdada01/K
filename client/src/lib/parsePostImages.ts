/**
 * ============================================================
 * 帖子图片数组解析与编辑态清洗（lib/parsePostImages）
 * ============================================================
 * 自 PostDetail.tsx 内联解析拆出（行为不变）：
 * 优先 post.images 非空数组，其次解析 image_url JSON，最后单元素兜底。
 *
 * `cleanEditImages` 原先是 `Profile.tsx` 与 `PostDetail.tsx` 里**逐字重复**的两段
 * （P2-24）：注释、`[]`/`["[]"]` 脏值判定、`||` 回落顺序全部一致，改一处漏一处
 * 会让「从个人页编辑」与「从详情页编辑」把不同的图片带进编辑框。
 * ============================================================
 */

export interface PostWithImageUrl {
  images?: string[];
  image_url: string;
}

export function parsePostImages(post: PostWithImageUrl): string[] {
  if (post.images && post.images.length > 0) return post.images;
  try {
    const parsed = JSON.parse(post.image_url);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {}
  return [post.image_url];
}

/** 编辑态图片清洗的输入（只取用到的字段，便于复用与测试） */
export interface PostEditableImages {
  video_url?: string | null;
  images?: string[];
  image_url: string;
}

/** 历史脏数据：视频帖的 images 会被写成这些字面量，不能带进编辑框 */
const isDirtyImage = (u: string): boolean => u === '[]' || u === '["[]"]';

/**
 * 过滤历史脏图片值。
 *
 * 这是「脏值定义」的**唯一来源**：此前 `Profile.tsx`、`PostDetail.tsx`、`EditPost.tsx`
 * 共 5 处各写一遍 `u !== '[]' && u !== '["[]"]'`，改一处漏一处就会让不同入口
 * 对同一篇帖子算出不同的图片数量（`EditPost` 还用这个数量判断「有没有改动」）。
 */
export function filterDirtyImages(urls: string[]): string[] {
  return urls.filter((u) => !isDirtyImage(u));
}

/**
 * 取「编辑帖子」时应带进编辑框的图片列表。
 * - 视频帖：不带图片（视频与图片互斥）
 * - 图文帖：过滤历史脏值；`images` 存在时（哪怕空数组）就用它，不再回落到 `image_url`
 *   —— 这条回落顺序必须与拆分前一致，否则编辑框里的图片会变。
 */
export function cleanEditImages(post: PostEditableImages): string[] {
  if (post.video_url) return [];
  return post.images ? filterDirtyImages(post.images) : filterDirtyImages([post.image_url]);
}
