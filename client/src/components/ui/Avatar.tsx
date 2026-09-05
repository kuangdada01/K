/**
 * ============================================================
 * 头像组件 (Avatar)
 * ============================================================
 * 统一的头像显示组件，支持图片头像和首字母占位符
 *
 * 功能:
 * - 显示用户头像图片
 * - 无头像时显示用户名首字母占位符
 * - 支持不同尺寸（通过 CSS 变量 --avatar-size 控制）
 * - 支持点击事件
 * ============================================================
 */

import { useState } from 'react';
import { HTMLAttributes } from 'react';
import { resolveMediaUrl } from '../../utils';

interface AvatarProps extends HTMLAttributes<HTMLDivElement> {
  src?: string | null;
  username: string;
  size?: number;
  className?: string;
}

export default function Avatar({ src, username, size = 40, className = '', ...props }: AvatarProps) {
  const [imgError, setImgError] = useState(false);

  const sizeStr = `${size}px`;
  const baseStyle: React.CSSProperties = {
    borderRadius: '50%',
    objectFit: 'cover',
    flexShrink: 0,
    width: sizeStr,
    height: sizeStr,
  };

  if (src && !imgError) {
    return (
      <img
        src={resolveMediaUrl(src) || src}
        alt={username}
        width={size}
        height={size}
        className={className}
        style={baseStyle}
        onError={() => setImgError(true)}
        {...props}
      />
    );
  }

  return (
    <div
      className={`avatar-placeholder ${className}`}
      style={{
        ...baseStyle,
        background: 'var(--accent)',
        color: 'var(--on-accent)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: `${Math.round(size * 0.45)}px`,
        fontWeight: 600,
      }}
      {...props}
    >
      {username.charAt(0).toUpperCase()}
    </div>
  );
}
