/**
 * validateBody 校验中间件单元测试（schema 来自 shared 包）
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { validateBody } from '../src/validate';
import { loginSchema } from '@k/shared';
import { PATHS, SERVER_ROOT } from '../src/config';

function mockRes() {
  const res: any = {
    statusCode: 0,
    jsonBody: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
  };
  return res;
}

describe('validateBody', () => {
  it('校验通过后把解析结果写回 req.body', async () => {
    const mw = validateBody(loginSchema);
    const req: any = { body: { email: 'a@b.com', password: '123456' } };
    const next = vi.fn();
    await mw(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.body.email).toBe('a@b.com');
  });

  it('校验失败返回 400 与第一条错误信息', async () => {
    const mw = validateBody(loginSchema);
    const res = mockRes();
    const next = vi.fn();
    await mw({ body: { email: '', password: '' } } as any, res, next);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: '请输入邮箱和密码' });
    expect(next).not.toHaveBeenCalled();
  });

  it('校验失败时按落盘路径清理 uploads_private 文件（修复：原按 /uploads/ 删不到）', async () => {
    const mw = validateBody(loginSchema);
    fs.mkdirSync(PATHS.uploadsPrivate, { recursive: true });
    const p = path.join(PATHS.uploadsPrivate, `validate-test-${Date.now()}.jpg`);
    fs.writeFileSync(p, 'x');
    try {
      const res = mockRes();
      await mw({ body: { email: '', password: '' }, file: { path: p } } as any, res, vi.fn());
      expect(res.statusCode).toBe(400);
      expect(fs.existsSync(p)).toBe(false);
    } finally {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('校验失败时仍清理 uploads 下的文件（回归）', async () => {
    const mw = validateBody(loginSchema);
    fs.mkdirSync(PATHS.uploads, { recursive: true });
    const p = path.join(PATHS.uploads, `validate-test-${Date.now()}.jpg`);
    fs.writeFileSync(p, 'x');
    try {
      const res = mockRes();
      await mw({ body: { email: '', password: '' }, file: { path: p } } as any, res, vi.fn());
      expect(res.statusCode).toBe(400);
      expect(fs.existsSync(p)).toBe(false);
    } finally {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('uploads/uploads_private 之外的落盘路径不允许删除', async () => {
    const mw = validateBody(loginSchema);
    const p = path.join(SERVER_ROOT, `validate-guard-${Date.now()}.jpg`);
    fs.writeFileSync(p, 'x');
    try {
      const res = mockRes();
      await mw({ body: { email: '', password: '' }, file: { path: p } } as any, res, vi.fn());
      expect(res.statusCode).toBe(400);
      expect(fs.existsSync(p)).toBe(true);
    } finally {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });
});
