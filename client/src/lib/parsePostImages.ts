/**
 * ============================================================
 * 帖子图片数组解析（lib/parsePostImages）
 * ============================================================
 * 自 PostDetail.tsx 内联解析拆出（行为不变）：
 * 优先 post.images 非空数组，其次解析 image_url JSON，最后单元素兜底。
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
