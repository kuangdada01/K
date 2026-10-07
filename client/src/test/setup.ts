/**
 * 测试全局 setup：jest-dom 断言扩展 + 每个用例后卸载组件、清理 DOM、
 * **还原对 `HTMLMediaElement.prototype` 的 defineProperty 打桩**
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * 原型属性快照（在任何用例跑之前取）。
 *
 * 为什么需要它：`MusicEngine.test.ts`（`play`/`load`/`pause`）与
 * `audioGraph.test.ts`（`play`）是用 `Object.defineProperty(HTMLMediaElement.prototype, …)`
 * 打桩的，而 `vi.restoreAllMocks()` **只还原 `vi.spyOn`/`vi.fn` 替换的属性，
 * 不撤销 defineProperty**。于是同一个文件里后面的用例会拿到上一个用例的假实现
 * （媒体元素"永远能播放"、`duration` 恒为某个值），失败还会以「诡异的方式」出现。
 *
 * 这里在 afterEach 里把原型恢复到初始状态：既把被替换的属性写回原描述符，
 * 也删掉测试新增的属性。
 */
const MEDIA_PROTO = globalThis.HTMLMediaElement?.prototype;
const mediaDescriptors = MEDIA_PROTO ? Object.getOwnPropertyDescriptors(MEDIA_PROTO) : undefined;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();

  if (MEDIA_PROTO && mediaDescriptors) {
    for (const key of Object.getOwnPropertyNames(MEDIA_PROTO)) {
      if (!(key in mediaDescriptors)) {
        delete (MEDIA_PROTO as unknown as Record<string, unknown>)[key];
      }
    }
    for (const [key, descriptor] of Object.entries(mediaDescriptors)) {
      Object.defineProperty(MEDIA_PROTO, key, descriptor);
    }
  }
});
