/**
 * ============================================================
 * 图书列表页面 (BooksPage)
 * ============================================================
 * 展示 server/books 目录下所有图书，点击进入详情页
 * ============================================================
 */

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import api from '../api/http';
import { resolveMediaUrl } from '../utils';
import { BookSummary } from '../types';
import styles from './BooksPage.module.css';

export default function BooksPage() {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get('/books')
      .then((res) => setBooks(res.data.books || []))
      .catch(() => setBooks([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-secondary)' }}>加载中...</div>;
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1>图书</h1>
      </div>

      {books.length === 0 ? (
        <div className={styles.empty}>
          <BookOpen size={48} />
          <p>暂无图书</p>
        </div>
      ) : (
        <div className={styles.grid}>
          {books.map((book) => (
            <Link to={`/books/${book.id}`} key={book.id} className={styles.card}>
              <div className={styles.cover}>
                {book.cover ? (
                  <img src={resolveMediaUrl(book.cover) || undefined} alt={book.title} />
                ) : (
                  <BookOpen size={28} />
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
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
