import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 6,
  name: 'posts.close_comments',
  up: (db) => {
    addColumnIfMissing(db, 'posts', 'close_comments', 'close_comments INTEGER DEFAULT 0');
  },
};

export default migration;
