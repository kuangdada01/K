/**
 * ============================================================
 * 话题文本渲染组件 (TaggedText)
 * ============================================================
 * 把文本中的 #话题 渲染为主题色可点击片段，
 * 点击跳转搜索页按话题精确搜索（/explore?tag=xxx）。
 *
 * 识别正则与入库规则来自 @k/shared（前后端一致），
 * 超长话题（> MAX_TAG_LENGTH）不会入库，因此渲染为普通文本。
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { TAG_REGEX, MAX_TAG_LENGTH } from '@k/shared';
import styles from './TaggedText.module.css';

interface TaggedTextProps {
  text: string;
  className?: string;
}

export default function TaggedText({ text, className }: TaggedTextProps) {
  const navigate = useNavigate();

  const parts = useMemo(() => {
    const result: { content: string; tag?: string }[] = [];
    let lastIndex = 0;
    for (const match of text.matchAll(TAG_REGEX)) {
      const index = match.index ?? 0;
      if (index > lastIndex) {
        result.push({ content: text.slice(lastIndex, index) });
      }
      const clickable = match[1].length <= MAX_TAG_LENGTH;
      result.push(clickable ? { content: match[0], tag: match[1] } : { content: match[0] });
      lastIndex = index + match[0].length;
    }
    if (lastIndex < text.length) {
      result.push({ content: text.slice(lastIndex) });
    }
    return result;
  }, [text]);

  if (!text) return null;

  return (
    <span className={className}>
      {parts.map((part, i) =>
        part.tag ? (
          <span
            key={i}
            className={styles.tag}
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/explore?tag=${encodeURIComponent(part.tag!)}`);
            }}
          >
            {part.content}
          </span>
        ) : (
          part.content
        )
      )}
    </span>
  );
}
