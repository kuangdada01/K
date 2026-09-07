/**
 * ============================================================
 * 图书阅读页面 (BookReaderPage)
 * ============================================================
 * 读取并展示 txt 章节内容，支持:
 * - 上一章 / 下一章（同一卷内）
 * - 字体大小调节
 * - 返回目录
 *
 * 数据层（§4.2）：手写 loading/error/数据 状态收敛为两个 useQuery
 * （书籍结构 + 章节内容）。行为不变量：
 * - 请求时机不变（file/id 变化即取，失败不重试，原「取消标志」丢弃
 *   过期响应由 query key 天然覆盖——旧 key 的响应只落旧缓存）
 * - loading 与原实现一致：仅由章节内容拉取驱动（file 为空不加载、
 *   章节切换期间显示加载中——isFetching 含缓存命中后的挂载重取）
 * - 失败仍静默降级为空内容（原 catch → setContent('')）
 * ============================================================
 */

import { useState, useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, List, AArrowUp, AArrowDown } from 'lucide-react';
import api from '../api/http';
import type { BookDetail, BookChapter, BookVolume } from '../types';
import styles from './BookReaderPage.module.css';

export default function BookReaderPage() {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const file = searchParams.get('file') || '';
  const navigate = useNavigate();

  const [fontSize, setFontSize] = useState(17);

  // 书籍结构（失败静默置空：原 catch → setBook(null)）
  const bookQuery = useQuery({
    queryKey: ['book', id],
    queryFn: async () => {
      const res = await api.get(`/books/${id}`);
      return res.data as BookDetail;
    },
    // 切换书籍时旧书先显示（原 book state 在响应前保持不变）
    placeholderData: keepPreviousData,
  });
  const book = bookQuery.data;

  // 章节内容（file 为空不发请求；响应期 loading，与历史一致）
  const contentQuery = useQuery({
    queryKey: ['book', 'content', id, file],
    queryFn: async () => {
      const res = await api.get(`/books/${id}/content`, { params: { file }, responseType: 'text' });
      return res.data as string;
    },
    enabled: !!file,
  });
  const content = contentQuery.data ?? '';
  const loading = file ? contentQuery.isFetching : false;

  // 扁平化章节列表，用于上/下一章导航
  const flatChapters = useMemo(() => {
    if (!book) return [];
    return book.volumes.flatMap((v: BookVolume) =>
      v.chapters.map((ch: BookChapter) => ({ ...ch, volume: v.name }))
    );
  }, [book]);

  const currentIndex = useMemo(
    () => flatChapters.findIndex((ch: BookChapter) => ch.file === file),
    [flatChapters, file]
  );

  const goChapter = (chapter: BookChapter) => {
    if (chapter.type === 'pdf') {
      window.open(`/api/books/${id}/content?file=${encodeURIComponent(chapter.file)}`, '_blank');
      return;
    }
    navigate(`/books/${id}/read?file=${encodeURIComponent(chapter.file)}`);
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-secondary)' }}>加载中...</div>;
  }

  const title = flatChapters[currentIndex]?.title || '阅读';

  return (
    <div className={styles.reader}>
      <div className={styles.topbar}>
        <Link to={`/books/${id}`} className={styles.back} data-back>
          <ArrowLeft size={18} /> 目录
        </Link>
        <div className={styles.title} title={title}>
          {title}
        </div>
        <div className={styles.tools}>
          <button
            className={styles.tool}
            onClick={() => setFontSize((f) => Math.max(13, f - 1))}
            title="减小字号"
          >
            <AArrowDown size={18} />
          </button>
          <button
            className={styles.tool}
            onClick={() => setFontSize((f) => Math.min(28, f + 1))}
            title="增大字号"
          >
            <AArrowUp size={18} />
          </button>
          <Link to={`/books/${id}`} className={styles.tool} title="章节列表">
            <List size={18} />
          </Link>
        </div>
      </div>

      <div className={styles.content} style={{ fontSize }}>
        {content
          .replace(/\r\n/g, '\n')
          .replace(/^=+\s*$/gm, '')
          .trim()
          .split(/\n{2,}/)
          .map((para: string, i: number) => (
            <p key={i} className={styles.para}>
              {para.replace(/\n/g, '').trim()}
            </p>
          ))}
      </div>

      <div className={styles.nav}>
        <button
          className={styles.navBtn}
          disabled={currentIndex <= 0}
          onClick={() => currentIndex > 0 && goChapter(flatChapters[currentIndex - 1]!)}
        >
          <ChevronLeft size={16} /> 上一章
        </button>
        <Link to={`/books/${id}`} className={styles.navBtn}>
          <List size={16} /> 目录
        </Link>
        <button
          className={styles.navBtn}
          disabled={currentIndex < 0 || currentIndex >= flatChapters.length - 1}
          onClick={() =>
            currentIndex >= 0 &&
            currentIndex < flatChapters.length - 1 &&
            goChapter(flatChapters[currentIndex + 1]!)
          }
        >
          下一章 <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
