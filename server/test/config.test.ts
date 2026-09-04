/**
 * 配置模块冒烟测试：环境变量校验与路径常量
 */

import { describe, it, expect } from 'vitest';
import { env, PATHS, SERVER_ROOT } from '../src/config';

describe('config', () => {
  it('env 提供默认值', () => {
    expect(typeof env.PORT).toBe('number');
    expect(env.PORT).toBeGreaterThan(0);
    expect(['development', 'production', 'test']).toContain(env.NODE_ENV);
  });

  it('路径常量指向预期位置', () => {
    expect(SERVER_ROOT.endsWith('server')).toBe(true);
    expect(PATHS.uploads.endsWith('uploads')).toBe(true);
    expect(PATHS.uploadsTemp.endsWith('uploads\\temp') || PATHS.uploadsTemp.endsWith('uploads/temp')).toBe(true);
    expect(PATHS.avatars.endsWith('avatars')).toBe(true);
    expect(PATHS.books.endsWith('books')).toBe(true);
    expect(PATHS.db.endsWith('k.db')).toBe(true);
  });
});
