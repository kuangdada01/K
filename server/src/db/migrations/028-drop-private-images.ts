import { tableExists } from './helpers';
import type { Migration } from './helpers';

const migration: Migration = {
  id: 28,
  name: 'drop_private_images',
  up: (db) => {
    /*
     * 「私密文件夹」（每个用户最多 10 张私密图片）功能已整体删除，这里把表一起 drop。
     *
     * 为什么要在迁移里 drop，而不是只从 schema 摘掉建表语句：
     * 存量库的表会留下来变成**指向不存在功能的死表**（还会被 013 的列迁移扫到）；
     * 而 CREATE TABLE IF NOT EXISTS 也不会替你删。
     *
     * ⚠️ 两点确认过的事实（09-18 上线前查过生产库）：
     *  1. `private_images` 是**空表**（0 行），drop 不丢任何数据；
     *  2. `uploads_private` 目录**不能动** —— 私信图片也存在那里
     *     （`messages.image_url` 与它共用同一个目录），所以这里不做任何文件清理。
     *
     * 幂等：表不存在时直接跳过（新库 schema 已经不建它了）。
     */
    if (!tableExists(db, 'private_images')) return;
    // 索引随表一起被 SQLite 删掉，不用单独 drop
    db.exec('DROP TABLE private_images');
  },
};

export default migration;
