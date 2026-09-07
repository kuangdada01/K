import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 3,
  name: 'messages.image_url',
  up: (db) => {
    addColumnIfMissing(db, 'messages', 'image_url', 'image_url TEXT');
  },
};

export default migration;
