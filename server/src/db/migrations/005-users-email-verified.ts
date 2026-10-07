import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 5,
  name: 'users.email_verified',
  up: (db) => {
    addColumnIfMissing(db, 'users', 'email_verified', 'email_verified INTEGER DEFAULT 0');
  },
};

export default migration;
