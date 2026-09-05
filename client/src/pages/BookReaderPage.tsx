/**
 * ============================================================
 * 图书阅读页面 (BookReaderPage)
 * ============================================================
 * 读取并展示 txt 章节内容，支持:
 * - 上一章 / 下一章（同一卷内）
 * - 字体大小调节
 * - 返回目录
 * ============================================================
 */

import { useState, useEffect, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, List, AArrowUp, AArrowDown } from 'lucide-react';
import api from '../api/http';
import { BookDetail, BookChapter, BookVolume } from '../types';
import styles from './BookReaderPage.module.css';

export default function BookReaderPage() {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const file = searchParams.get('file') || '';
  const navigate = useNavigate();

  const [book, setBook] = useState<BookDetail | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [fontSize, setFontSize] = useState(17);

  // 加载态调整（渲染期 prev 值模式，替代 effect 内同步 setState）：
  // file 为空 → 结束加载态；file/id 变化 → 进入加载态
  const [prevLoadKey, setPrevLoadKey] = useState('');
  if (!file && loading) setLoading(false);
  if (file && `${id}|${file}` !== prevLoadKey) {
    setPrevLoadKey(`${id}|${file}`);
    setLoading(true);
  }

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

  useEffect(() => {
    if (!file) return;
    api
      .get(`/books/${id}/content`, { params: { file }, responseType: 'text' })
      .then((res) => setContent(res.data as string))
      .catch(() => setContent(''))
      .finally(() => setLoading(false));
  }, [id, file]);

  useEffect(() => {
    if (!id) return;
    api
      .get(`/books/${id}`)
      .then((res) => setBook(res.data))
      .catch(() => setBook(null));
  }, [id]);

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
          onClick={() => currentIndex > 0 && goChapter(flatChapters[currentIndex - 1])}
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
            goChapter(flatChapters[currentIndex + 1])
          }
        >
          下一章 <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
