/**
 * ============================================================
 * 音量滑条（components/ui/VolumeSlider）
 * ============================================================
 * 自 VoicePage.tsx 拆出（§3.2，行为不变）：4px 细轨道，填充随值变化；
 * max 默认 1，麦克风用 1.5 配合总线压限拉高低声麦。
 * 样式在本组件的 VolumeSlider.module.css（D4 自 VoicePage.module.css 拆出）。
 * ============================================================
 */

import styles from './VolumeSlider.module.css';

export default function VolumeSlider({
  value,
  onChange,
  max = 1,
  /** 调用方定制类（如 MemberCard 的 .peerVolumeSlider / VoiceRoomView 的 .volumeGroupSlider）：
   *  拆分前这两个定制是 `.容器 .slider` 后代选择器，跨 module 后代选择器
   *  对不上哈希类名，改为挂到滑条元素自身 */
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  max?: number;
  className?: string | undefined;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, value / max)) * 100);
  return (
    <input
      type="range"
      min={0}
      max={max}
      step={0.05}
      className={[styles.slider, className].filter(Boolean).join(' ')}
      style={{ background: `linear-gradient(to right, var(--accent) ${pct}%, var(--bg-secondary) ${pct}%)` }}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
