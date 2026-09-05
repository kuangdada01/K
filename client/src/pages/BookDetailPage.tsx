/**
 * ============================================================
 * 图书详情页面 (BookDetailPage)
 * ============================================================
 * 展示一本书的卷/章节结构，点击章节进入阅读页
 * 章节点击行为:
 * - text 章节 → /books/:id/read?file=<章节文件>
 * - pdf 章节 → 直接下载/打开 PDF
 * ============================================================
 */

import { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, BookOpen, ChevronRight, FileText, FileDown } from 'lucide-react';
import api from '../api/http';
import { resolveMediaUrl } from '../utils';
import { BookDetail, BookChapter, BookVolume } from '../types';
import styles from './BookDetailPage.module.css';

export default function BookDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [book, setBook] = useState<BookDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/books/${id}`)
      .then((res) => setBook(res.data))
      .catch(() => setError('图书不存在'))
      .finally(() => setLoading(false));
  }, [id]);

  const openChapter = (chapter: BookChapter) => {
    if (chapter.type === 'pdf') {
      window.open(`/api/books/${id}/content?file=${encodeURIComponent(chapter.file)}`, '_blank');
      return;
    }
    navigate(`/books/${id}/read?file=${encodeURIComponent(chapter.file)}`);
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-secondary)' }}>加载中...</div>;
  }

  if (error || !book) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <BookOpen size={48} />
          <p>{error || '图书不存在'}</p>
          <Link to="/books" className={styles.backLink}>
            返回图书列表
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.detailHeader}>
        <button className={styles.backBtn} data-back onClick={() => navigate('/books')}>
          <ArrowLeft size={18} /> 图书
        </button>
        <div className={styles.detailHeading}>
          <div className={`${styles.cover} ${styles.coverLg}`}>
            {book.cover ? (
              <img src={resolveMediaUrl(book.cover) || undefined} alt={book.title} />
            ) : (
              <BookOpen size={36} />
            )}
          </div>
          <div className={styles.info}>
            <div className={styles.title}>{book.title}</div>
            {book.author && <div className={styles.author}>{book.author}</div>}
            <div className={styles.meta}>
              {book.volumeCount} 卷 · {book.chapterCount} 章
            </div>
            {book.description && <div className={styles.desc}>{book.description}</div>}
          </div>
        </div>
      </div>

      <div className={styles.toc}>
        {book.volumes.map((vol: BookVolume, vi: number) => (
          <div key={vi}>
            {vol.name && <div className={styles.volumeTitle}>{vol.name}</div>}
            <div className={styles.chapterList}>
              {vol.chapters.map((ch: BookChapter, ci: number) => (
                <button
                  key={ci}
                  className={styles.chapterItem}
                  onClick={() => openChapter(ch)}
                  title={ch.file}
                >
                  <span className={styles.chapterIcon}>
                    {ch.type === 'pdf' ? <FileDown size={16} /> : <FileText size={16} />}
                  </span>
                  <span className={styles.chapterName}>{ch.title}</span>
                  <ChevronRight size={16} className={styles.chapterArrow} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
