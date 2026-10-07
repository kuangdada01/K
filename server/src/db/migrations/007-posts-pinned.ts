import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 7,
  name: 'posts.pinned',
  up: (db) => {
    addColumnIfMissing(db, 'posts', 'pinned', 'pinned INTEGER DEFAULT 0');
  },
};

export default migration;
