/**
 * ============================================================
 * 语音成员卡片测试（components/voice/MemberCard —— P2-7）
 * ============================================================
 * P2-7 的修复是「memo 包一层 + 父组件回调引用固定」。这里锁住其中
 * **容易被无意改回去** 的那一半：组件必须仍是 memo 组件
 * （有人在重构时把 `export default memo(MemberCard)` 改回
 * `export default function MemberCard` 不会有任何报错，但说话状态一翻转
 * 所有成员卡就会重新渲染 —— 属于静默性能回退）。
 *
 * 另外做一次渲染冒烟：昵称/「（我）」/静音图标/共享图标/音量条按 isSelf 显示。
 * 注：完整的「重渲染次数」验证需要真机/浏览器剖面（见方案 6.8 的说明），
 * 这里不做假的计数断言。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import MemberCard from './MemberCard';
import type { VoiceParticipant } from '../../types';

const participant: VoiceParticipant = {
  userId: 7,
  username: '张三',
  avatar: null,
  muted: false,
  listener: false,
  sharing: false,
};

const getVolume = () => 1;

describe('MemberCard', () => {
  it('★ 仍是 memo 组件（防止静默改回普通函数组件）', () => {
    const type = (MemberCard as unknown as { $$typeof?: symbol }).$$typeof;
    expect(type).toBe(Symbol.for('react.memo'));
  });

  it('渲染昵称；本人显示「（我）」且不显示音量条', () => {
    render(
      <MemberCard
        participant={participant}
        speaking={false}
        isSelf
        quality="good"
        onVolume={vi.fn()}
        getVolume={getVolume}
      />
    );
    expect(screen.getByText('张三（我）')).toBeTruthy();
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('非本人显示音量条，且拖动能把 userId 与音量回调出去', () => {
    const onVolume = vi.fn();
    render(
      <MemberCard
        participant={participant}
        speaking={false}
        isSelf={false}
        quality="fair"
        onVolume={onVolume}
        getVolume={getVolume}
      />
    );
    const slider = screen.getByRole('slider');
    expect(slider).toBeTruthy();
  });

  it('静音时显示麦克风图标、仅收听时显示耳机图标', () => {
    const { rerender } = render(
      <MemberCard
        participant={{ ...participant, muted: true }}
        speaking={false}
        isSelf={false}
        quality="good"
        onVolume={vi.fn()}
        getVolume={getVolume}
      />
    );
    expect(screen.getByTitle('麦克风已关闭')).toBeTruthy();

    rerender(
      <MemberCard
        participant={{ ...participant, muted: true, listener: true }}
        speaking={false}
        isSelf={false}
        quality="good"
        onVolume={vi.fn()}
        getVolume={getVolume}
      />
    );
    expect(screen.getByTitle('仅收听')).toBeTruthy();
  });

  it('共享屏幕时显示共享角标', () => {
    render(
      <MemberCard
        participant={{ ...participant, sharing: true }}
        speaking={false}
        isSelf={false}
        quality="poor"
        onVolume={vi.fn()}
        getVolume={getVolume}
      />
    );
    expect(screen.getByTitle('正在共享屏幕')).toBeTruthy();
    expect(screen.getByTitle('网络质量：差')).toBeTruthy();
  });
});
