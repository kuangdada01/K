import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 8,
  name: 'posts.video_url',
  up: (db) => {
    addColumnIfMissing(db, 'posts', 'video_url', 'video_url TEXT DEFAULT NULL');
  },
};

export default migration;
