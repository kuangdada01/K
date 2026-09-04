/**
 * validateBody 校验中间件单元测试（schema 来自 shared 包）
 */

import { describe, it, expect, vi } from 'vitest';
import { validateBody } from '../src/validate';
import { loginSchema } from '@k/shared';

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
});
