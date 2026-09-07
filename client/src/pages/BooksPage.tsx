/**
 * ============================================================
 * 图书列表页面 (BooksPage)
 * ============================================================
 * 展示 server/books 目录下所有图书，点击进入详情页
 *
 * 数据层（§4.2）：手写 loading/error/数据 状态收敛为 useQuery。
 * 请求时机不变；失败仍静默降级为空列表（原 catch → setBooks([])，
 * 无 toast）——queryFn 捕获后返回 [] 保持同一行为。
 * ============================================================
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import api from '../api/http';
import { resolveMediaUrl } from '../utils';
import type { BookSummary } from '../types';
import styles from './BooksPage.module.css';

export default function BooksPage() {
  const booksQuery = useQuery({
    queryKey: ['books'],
    queryFn: async (): Promise<BookSummary[]> => {
      try {
        const res = await api.get('/books');
        return res.data.books || [];
      } catch {
        return [];
      }
    },
  });
  const books = booksQuery.data ?? [];
  const loading = booksQuery.isPending;

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
