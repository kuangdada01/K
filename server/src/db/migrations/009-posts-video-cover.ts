import { addColumnIfMissing } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 9,
  name: 'posts.video_cover',
  up: (db) => {
    addColumnIfMissing(db, 'posts', 'video_cover', 'video_cover TEXT DEFAULT NULL');
  },
};

export default migration;
