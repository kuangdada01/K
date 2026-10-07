import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 12,
  name: 'messages.quoted_message_id',
  up: (db) => {
    addColumnIfMissing(db, 'messages', 'quoted_message_id', 'quoted_message_id INTEGER DEFAULT NULL');
  },
};

export default migration;
