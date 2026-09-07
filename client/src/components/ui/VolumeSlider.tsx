/**
 * ============================================================
 * 音量滑条（components/ui/VolumeSlider）
 * ============================================================
 * 自 VoicePage.tsx 拆出（§3.2，行为不变）：4px 细轨道，填充随值变化；
 * max 默认 1，麦克风用 1.5 配合总线压限拉高低声麦。
 * 样式复用 VoicePage.module.css 的 slider 类（与拆分前同一份 CSS，
 * 视觉零变化）。
 * ============================================================
 */

import styles from '../../pages/VoicePage.module.css';

export default function VolumeSlider({
  value,
  onChange,
  max = 1,
}: {
  value: number;
  onChange: (v: number) => void;
  max?: number;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, value / max)) * 100);
  return (
    <input
      type="range"
      min={0}
      max={max}
      step={0.05}
      className={styles.slider}
      style={{ background: `linear-gradient(to right, var(--accent) ${pct}%, var(--bg-secondary) ${pct}%)` }}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
