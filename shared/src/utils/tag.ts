/**
 * ============================================================
 * 话题（#标签）工具
 * ============================================================
 * 前后端共用：发布时服务端用它从 description 解析话题入库，
 * 渲染时客户端用它把 #话题 切分为可点击片段。
 * 正则规则必须两端一致，勿单独修改任意一端。
 */

/** 话题格式：# + 连续的中英文/数字/下划线/连字符，遇空格、标点、下一个 # 结束 */
export const TAG_REGEX = /#([\p{L}\p{N}_-]+)/gu;

/** 单个话题最大长度 */
export const MAX_TAG_LENGTH = 30;

/** 每帖最多话题数 */
export const MAX_TAGS_PER_POST = 10;

/**
 * 从文本中提取话题列表（不含 # 前缀）
 * - 自动去重（保留首次出现顺序）
 * - 超过 MAX_TAG_LENGTH 的话题整体忽略（不截断，避免搜索语义变化）
 * - 最多返回 MAX_TAGS_PER_POST 个
 */
export function extractTags(text: string): string[] {
  if (!text) return [];

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const match of text.matchAll(TAG_REGEX)) {
    const tag = match[1];
    if (!tag || tag.length > MAX_TAG_LENGTH || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS_PER_POST) break;
  }

  return tags;
}
