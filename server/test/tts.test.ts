/**
 * ============================================================
 * 云端朗读代理测试（POST /api/tts）
 * ============================================================
 * 覆盖:
 * - 正常路径: 转发 StepFun 端点，请求体带 model/voice/input，Authorization 带服务端 Key，
 *   响应原样回 audio/mpeg
 * - **密钥不泄露**: 响应头/响应体里不出现 Key（前端抓包也拿不到）
 * - 未配置 STEP_API_KEY → 503（前端据此提示"云端音色未开通"）
 * - 入参: 空文本 400、超长 400（在花掉上游额度之前挡掉）
 * - 音色白名单: 未知 key 落回默认音色，不能拿任意字符串去试音色
 * - 上游 401（Key 失效）→ 502 且对外不暴露上游报文
 * ============================================================
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { createMemoryDb } from './helpers/memdb';
import { setDbForTests, resetDbForTests } from '../src/db/connection';
import { createApp } from '../src/app';
import { generateToken } from '../src/middleware/auth';
import { env } from '../src/config';
import { TTS_MAX_CHARS } from '@k/shared';

/** 测试自用的真实 fetch（globalThis.fetch 会被替换成上游桩） */
const realFetch = globalThis.fetch;

const UPSTREAM_URL = 'https://api.stepfun.com/step_plan/v1/audio/speech';
const DEFAULT_VOICE_ID = 'voice-tone-UfTMTasMym';

let db: InstanceType<typeof Database>;
let server: http.Server;
let base = '';
let token = '';
let savedStepKey: string | undefined;

beforeAll(async () => {
  // CI 上没有 .env（本地有真实 STEP_API_KEY）：统一给个假密钥，让"正常路径"等用例
  // 不被路由的「未配置 → 503」闸门拦下（路由按请求动态读 env，见 503 用例的做法）。
  // 各条断言都引用 env.STEP_API_KEY 本身（Authorization 回显、不外泄检查），假密钥同样成立。
  savedStepKey = env.STEP_API_KEY;
  env.STEP_API_KEY = 'test-step-api-key';

  db = createMemoryDb();
  setDbForTests(db);
  const id = Number(
    db
      .prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, 'x', 'user')")
      .run('tts-user', 'tts@test.com').lastInsertRowid
  );
  token = generateToken({ id, username: 'tts-user' });

  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  env.STEP_API_KEY = savedStepKey;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbForTests();
  db?.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 用真实 HTTP 调本站接口（带登录态：服务端按用户维度限流，额度更宽） */
function speak(body: unknown, opts: { auth?: boolean } = {}) {
  return realFetch(`${base}/api/tts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.auth === false ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

/** 桩掉上游 fetch，返回调用记录 */
function stubUpstream(make: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(make);
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('POST /api/tts 云端朗读代理', () => {
  it('正常路径：转发上游并回 audio/mpeg，密钥不出现在响应里', async () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04]); // "ID3" + 版本字节
    const mock = stubUpstream(() => new Response(audio, { status: 200 }));

    const res = await speak({ text: '你好', voice: 'dengziqi' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf)).toEqual(Array.from(audio));
    // 响应头不得携带 Key
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(String(env.STEP_API_KEY));

    // 上游收到的请求（地址 / 鉴权 / 参数）
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(UPSTREAM_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${env.STEP_API_KEY}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('stepaudio-2.5-tts');
    expect(body.voice).toBe(DEFAULT_VOICE_ID);
    expect(body.input).toBe('你好');
    expect(body.response_format).toBe('mp3');
  });

  it('未知音色 key：落回默认音色（白名单，不接受任意字符串）', async () => {
    const mock = stubUpstream(() => new Response(new Uint8Array([1]), { status: 200 }));
    const res = await speak({ text: 'hi', voice: 'evil-voice-id' });
    expect(res.status).toBe(200);
    const body = JSON.parse(String((mock.mock.calls[0]![1] as RequestInit).body)) as { voice: string };
    expect(body.voice).toBe(DEFAULT_VOICE_ID);
  });

  it('入参：空文本 400、超长 400，且都不调用上游（不花额度）', async () => {
    const mock = stubUpstream(() => new Response(new Uint8Array([1]), { status: 200 }));

    expect((await speak({ text: '   ' })).status).toBe(400);
    expect((await speak({})).status).toBe(400);

    const tooLong = await speak({ text: '甲'.repeat(TTS_MAX_CHARS + 1) });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { error: string }).error).toContain(String(TTS_MAX_CHARS));

    expect(mock).not.toHaveBeenCalled();
  });

  it('未配置 STEP_API_KEY → 503（前端据此禁用云端音色）', async () => {
    const saved = env.STEP_API_KEY;
    env.STEP_API_KEY = undefined;
    const mock = stubUpstream(() => new Response(new Uint8Array([1]), { status: 200 }));
    try {
      const res = await speak({ text: '你好' });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toContain('STEP_API_KEY');
      expect(mock).not.toHaveBeenCalled();
    } finally {
      env.STEP_API_KEY = saved;
    }
  });

  it('上游 401（Key 失效）→ 502，且不把上游报文与 Key 透给前端', async () => {
    // 上游错误报文里塞入 Key（模拟真实上游回显），断言不会外泄
    const mock = stubUpstream(
      () =>
        new Response(`{"error":"invalid key ${env.STEP_API_KEY}"}`, {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const res = await speak({ text: '你好' });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('密钥无效');
    expect(text).not.toContain(String(env.STEP_API_KEY));
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('上游 429（并发/配额打满）→ 原样回 429，且文案是用户能照做的限流提示', async () => {
    stubUpstream(() => new Response('rate limited', { status: 429 }));
    const res = await speak({ text: '你好' });
    expect(res.status).toBe(429);
    // 不能再说"云端朗读暂时不可用"：那是"故障"口径，用户既看不懂也不知道该做什么。
    // 限流必须让人能自己调整行为（等一下再试）。
    expect(((await res.json()) as { error: string }).error).toContain('稍等');
  });

  it('★ 客户端中途断开时中止上游合成（不留占着上游并发槽的"僵尸请求"）', async () => {
    let upstreamSignal: AbortSignal | undefined;
    // 上游挂住不返回，模拟"正在合成的慢请求"（非流式首段本来就要 2~5 秒）
    stubUpstream((_url, init) => {
      upstreamSignal = init.signal ?? undefined;
      return new Promise<Response>(() => {});
    });

    const u = new URL(base);
    const req = http.request({
      host: u.hostname,
      port: Number(u.port),
      path: '/api/tts',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    req.on('error', () => {}); // 主动断开引发的 ECONNRESET 忽略
    req.write(JSON.stringify({ text: '你好', voice: 'dengziqi' }));
    req.end();

    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    expect(upstreamSignal?.aborted).toBe(false);

    // 客户端断开 = 用户换音色 / 点下一条 / 退出房间时取消在途请求
    req.destroy();

    // 关键断言：上游请求必须被中止。否则它会跑完，一直占着 StepFun 账号那 5 个并发槽，
    // 攒几个就让所有人的朗读都变成 429（2026-09-28 的真实事故）。
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
  });

  it('游客（无 token）也能用：房间支持未登录访客', async () => {
    stubUpstream(() => new Response(new Uint8Array([1, 2]), { status: 200 }));
    const res = await speak({ text: '你好', voice: 'dengziqi' }, { auth: false });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
  });
});
