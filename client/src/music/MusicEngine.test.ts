/**
 * ============================================================
 * 音乐播放引擎单测（music/MusicEngine.test）
 * ============================================================
 * fake HTMLAudioElement 验证（§3.4）：
 * - init/dispose 生命周期（监听接线与清理）
 * - 播放/暂停/上下首（循环边界）/seek/playSong
 * - §5.2 修复：playSong(当前曲目) src 命中时不重设 src 但照样 play
 *   （"UI 显示播放中但无声"的回归锁）
 * - ended 自切歌（index 前进 + 保持播放）
 * ============================================================
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicEngine } from './MusicEngine';
import type { MusicSong } from './MusicEngine';

const SONGS: MusicSong[] = [
  { title: 'a', artist: 'A', src: '/music/a.mp3' },
  { title: 'b', artist: 'B', src: '/music/b.mp3' },
  { title: 'c', artist: 'C', src: '/music/c.mp3' },
];

describe('MusicEngine', () => {
  let events: string[];
  let engine: MusicEngine;
  let audio: HTMLAudioElement & {
    play: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    events = [];
    // jsdom 未实现 HTMLMediaElement.play：stub 并捕获实例
    const play = vi.fn(async () => {});
    const load = vi.fn();
    const pause = vi.fn();
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      writable: true,
      value: play,
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'load', {
      configurable: true,
      writable: true,
      value: load,
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      writable: true,
      value: pause,
    });
    engine = new MusicEngine({
      onIndexChange: (i) => events.push(`index:${i}`),
      onPlayingChange: (p) => events.push(`playing:${p}`),
      onDurationChange: (d) => events.push(`duration:${d}`),
      onSongsChange: (s) => events.push(`songs:${s.length}`),
    });
    engine.init();
    audio = engine.getAudioElement() as typeof audio;
    audio.play = play;
    audio.load = load;
    audio.pause = pause;
    engine.setSongs(SONGS);
    events.length = 0;
  });

  it('init：创建共享 audio（preload/volume）并接线；dispose 摘监听并清空', () => {
    expect(audio).toBeInstanceOf(HTMLAudioElement);
    expect(audio.preload).toBe('auto');
    expect(audio.volume).toBe(0.5);
    engine.dispose();
    expect(audio.pause).toHaveBeenCalled();
    // jsdom 把空 src 解析为页面地址（http://localhost:3000/），非空即已清空
    expect(audio.src).not.toContain('/music/');
    expect(engine.getAudioElement()).toBeNull();
  });

  it('play：播放 + src 接线（不匹配时 load）；状态上报', () => {
    engine.play();
    expect(events).toEqual(['playing:true']);
    expect(audio.play).toHaveBeenCalled();
    expect(audio.src).toContain('/music/a.mp3');
    expect(audio.load).toHaveBeenCalled();
  });

  it('§5.2 修复：playSong(当前曲目) src 命中 → 不重设 src 但照样 play', () => {
    engine.playSong(0); // 首次：src 接线（load）
    expect(audio.load).toHaveBeenCalledTimes(1);
    audio.play.mockClear();
    audio.load.mockClear();
    events.length = 0;
    engine.playSong(0); // 再次播放当前曲目：src 命中
    expect(events).toEqual(['index:0', 'playing:true']);
    expect(audio.play).toHaveBeenCalled(); // 修复点：命中当前曲目也发声
    expect(audio.load).not.toHaveBeenCalled(); // src 未变不重载
  });

  it('playSong(其他曲目)：切 src + load + play', () => {
    engine.playSong(1);
    expect(events).toEqual(['index:1', 'playing:true']);
    expect(audio.play).toHaveBeenCalled();
    expect(audio.load).toHaveBeenCalled();
    expect(audio.src).toContain('/music/b.mp3');
  });

  it('ended：自切下一首并保持播放（循环）', () => {
    engine.playSong(2);
    events.length = 0;
    audio.dispatchEvent(new Event('ended'));
    expect(events).toEqual(['index:0', 'playing:true']);
    expect(audio.play).toHaveBeenCalled();
  });

  it('next/prev：循环边界正确', () => {
    engine.next();
    expect(events).toEqual(['index:1', 'playing:true']);
    events.length = 0;
    engine.next();
    engine.next(); // 2 → 0 回绕
    expect(events).toEqual(['index:2', 'playing:true', 'index:0', 'playing:true']);
    events.length = 0;
    engine.prev(); // 0 → 2 回绕
    expect(events).toEqual(['index:2', 'playing:true']);
  });

  it('pause：停止播放并上报', () => {
    engine.play();
    events.length = 0;
    engine.pause();
    expect(events).toEqual(['playing:false']);
    expect(audio.pause).toHaveBeenCalled();
  });

  it('seek：指令式跳转（不经 React state）', () => {
    engine.seek(42);
    expect(audio.currentTime).toBe(42);
  });

  it('空列表：next 回 0 并保持播放态（与原实现一致），play 为安全 no-op', () => {
    engine.setSongs([]);
    events.length = 0;
    engine.next();
    engine.play();
    // next 空列表回 0 + 置播放态（与原 setIsPlaying(true) 一致）；play 无曲目不发声
    expect(events).toEqual(['index:0', 'playing:true']);
  });

  it('loadedmetadata：上报时长', () => {
    Object.defineProperty(audio, 'duration', { configurable: true, value: 180 });
    audio.dispatchEvent(new Event('loadedmetadata'));
    expect(events).toEqual(['duration:180']);
  });
});
