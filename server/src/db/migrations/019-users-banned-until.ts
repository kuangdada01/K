import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 19,
  name: 'users.banned_until',
  up: (db) => {
    addColumnIfMissing(db, 'users', 'banned_until', 'banned_until TEXT DEFAULT NULL');
  },
};

export default migration;
