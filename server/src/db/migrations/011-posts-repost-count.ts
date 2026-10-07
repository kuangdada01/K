import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 11,
  name: 'posts.repost_count',
  up: (db) => {
    addColumnIfMissing(db, 'posts', 'repost_count', 'repost_count INTEGER DEFAULT 0');
  },
};

export default migration;
