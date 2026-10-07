import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 4,
  name: 'users.role',
  up: (db) => {
    addColumnIfMissing(db, 'users', 'role', "role TEXT DEFAULT 'user'");
  },
};

export default migration;
