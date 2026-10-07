/**
 * ============================================================
 * 测试基建：`HTMLMediaElement.prototype` 打桩的还原（test/setup.ts）
 * ============================================================
 * `vi.restoreAllMocks()` 不会撤销 `Object.defineProperty` —— 而
 * `MusicEngine.test.ts` / `audioGraph.test.ts` 正是用 defineProperty 给
 * `play` / `load` / `pause` 打桩的。若不还原，同文件里**后面的用例**会拿到
 * 假实现（"媒体永远能播放"），失败方式还很隐蔽。
 *
 * 这里用「打桩 → 下一个用例检查已还原」的顺序把 setup 的行为钉住：
 * 用例之间的 `afterEach`（setup.ts）就是被测对象。
 */

import { describe, it, expect } from 'vitest';

const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;

describe('test/setup.ts 还原 HTMLMediaElement 原型的打桩', () => {
  it('打桩后本用例内生效', () => {
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      writable: true,
      value: () => 'stubbed-play',
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'kTempProbe', {
      configurable: true,
      writable: true,
      value: 42,
    });

    expect((document.createElement('audio') as HTMLAudioElement).play()).toBe('stubbed-play');
    expect(proto.kTempProbe).toBe(42);
  });

  it('★ 下一个用例：被替换的 play 已还原、新增的 kTempProbe 已被删除', () => {
    expect(proto.kTempProbe).toBeUndefined();
    const el = document.createElement('audio');
    expect(el.play()).not.toBe('stubbed-play');
  });
});
