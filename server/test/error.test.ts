/**
 * 统一错误处理中间件单元测试
 */

import { describe, it, expect, vi } from 'vitest';
import { AppError, asyncHandler, errorHandler } from '../src/middleware/error';

/** 构造最小 res mock，捕获 statusCode 与 json 输出 */
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

describe('AppError', () => {
  it('携带状态码与消息', () => {
    const err = new AppError(400, '参数错误');
    expect(err.status).toBe(400);
    expect(err.message).toBe('参数错误');
    expect(err.name).toBe('AppError');
  });
});

describe('errorHandler', () => {
  it('业务错误返回其状态码与消息', () => {
    const res = mockRes();
    errorHandler(new AppError(403, '权限不足'), {} as any, res, vi.fn());
    expect(res.statusCode).toBe(403);
    expect(res.jsonBody).toEqual({ error: '权限不足' });
  });

  it('未知错误统一 500 + 固定文案（不泄露细节）', () => {
    const res = mockRes();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    errorHandler(new Error('内部细节'), {} as any, res, vi.fn());
    spy.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(res.jsonBody).toEqual({ error: '服务器内部错误' });
  });

  it('Multer 大小超限返回 400 提示', () => {
    const res = mockRes();
    errorHandler({ code: 'LIMIT_FILE_SIZE' }, {} as any, res, vi.fn());
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: '文件过大，图片最大10MB，视频最大300MB' });
  });
});

describe('asyncHandler', () => {
  it('处理器抛错时交给 next', async () => {
    const boom = new Error('boom');
    const next = vi.fn();
    const handler = asyncHandler(async () => {
      throw boom;
    });
    await handler({} as any, {} as any, next);
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('处理器正常返回时不影响响应', async () => {
    const next = vi.fn();
    const handler = asyncHandler(async (_req, res) => {
      res.json({ ok: true });
    });
    const res = mockRes();
    await handler({} as any, res, next);
    expect(res.jsonBody).toEqual({ ok: true });
    expect(next).not.toHaveBeenCalled();
  });
});
