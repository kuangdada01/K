import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 10,
  name: 'posts.share_count',
  up: (db) => {
    addColumnIfMissing(db, 'posts', 'share_count', 'share_count INTEGER DEFAULT 0');
  },
};

export default migration;
