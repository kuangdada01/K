import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 1,
  name: 'comments.parent_id',
  up: (db) => {
    addColumnIfMissing(
      db,
      'comments',
      'parent_id',
      'parent_id INTEGER DEFAULT NULL REFERENCES comments(id) ON DELETE CASCADE'
    );
  },
};

export default migration;
