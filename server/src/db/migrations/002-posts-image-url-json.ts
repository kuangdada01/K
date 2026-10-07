import { tableExists } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 2,
  name: 'posts.image_url_json',
  up: (db) => {
    if (!tableExists(db, 'posts')) return;
    const sample = db.prepare('SELECT image_url FROM posts LIMIT 1').get() as
      { image_url: string } | undefined;
    if (sample && !sample.image_url.startsWith('[')) {
      const posts = db.prepare('SELECT id, image_url FROM posts').all() as {
        id: number;
        image_url: string;
      }[];
      const update = db.prepare('UPDATE posts SET image_url = ? WHERE id = ?');
      for (const p of posts) {
        update.run(JSON.stringify([p.image_url]), p.id);
      }
    }
  },
};

export default migration;
