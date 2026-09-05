/**
 * ============================================================
 * 头像二级菜单 (AvatarMenu)
 * ============================================================
 * 点击头像打开二级菜单，包含:
 * - 用户信息头（头像、用户名、简介）
 * - 个人主页（跳转 /profile）
 * - 主题切换（跟随系统 / 亮色 / 暗色，当前项打勾）
 * - 退出登录（未登录时为「登录」）
 *
 * 特性:
 * - 通过 Portal 渲染到 body，避免被侧栏 overflow:hidden 裁剪
 * - 点击外部 / Esc / 路由切换 / 滚动 自动关闭
 * - 移动端 (<=768px) 自动降级为底部面板
 * - 路由切换关闭采用渲染期派生（openPath 与当前路径比对），无 setState-in-effect
 *
 * placement:
 * - 'right'  桌面侧栏：菜单出现在头像右侧（底对齐）
 * - 'below'  个人主页右上角：菜单出现在按钮下方（右对齐）
 * ============================================================
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { Sun, Moon, Monitor, Check, LogOut, LogIn, User, Settings } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import Avatar from './ui/Avatar';
import styles from './AvatarMenu.module.css';

interface AvatarMenuProps {
  /** 定位方式 */
  placement?: 'right' | 'below';
  /** 是否显示用户名（侧栏展开时） */
  showUsername?: boolean;
  /** 用户名下方的副标题（如简介/状态） */
  subtitle?: string;
  /** 头像尺寸 */
  size?: number;
  /** 图标模式：渲染设置齿轮触发器（替代头像） */
  iconMode?: boolean;
  /** 外层包裹类名（用于宿主布局定位） */
  wrapperClassName?: string;
  /** 触发器按钮附加类名（用于宿主覆盖样式） */
  triggerClassName?: string;
}

type ThemeOption = { key: 'system' | 'light' | 'dark'; label: string; icon: React.ReactNode };

export default function AvatarMenu({
  placement = 'right',
  showUsername = false,
  subtitle,
  size = 40,
  iconMode = false,
  wrapperClassName = '',
  triggerClassName = '',
}: AvatarMenuProps) {
  // openPath: 打开菜单时的路由路径（null = 关闭）。
  // 渲染期派生 open：路由切换后 openPath !== location.pathname，菜单自动隐藏。
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { user, logout, openLoginPrompt } = useAuth();
  const { mode, setMode } = useTheme();
  const location = useLocation();

  const open = openPath !== null && openPath === location.pathname;

  const themeOptions: ThemeOption[] = [
    { key: 'system', label: '跟随系统', icon: <Monitor size={16} /> },
    { key: 'light', label: '亮色模式', icon: <Sun size={16} /> },
    { key: 'dark', label: '暗色模式', icon: <Moon size={16} /> },
  ];

  /** 打开/关闭菜单并记录触发器位置 */
  const toggle = useCallback(() => {
    if (openPath === null || openPath !== location.pathname) {
      if (triggerRef.current) {
        setRect(triggerRef.current.getBoundingClientRect());
      }
      setOpenPath(location.pathname);
    } else {
      setOpenPath(null);
    }
  }, [openPath, location.pathname]);

  const close = useCallback(() => setOpenPath(null), []);

  // 点击菜单外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // 页面滚动时关闭（仅 window 自身滚动；不用捕获模式，
  // 避免悬停经过嵌套滚动容器时误触发关闭）
  useEffect(() => {
    if (!open) return;
    const onScroll = () => close();
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, [open, close]);

  // 退出登录后关闭菜单
  const handleLogout = () => {
    close();
    logout();
  };

  // 未登录：点击登录入口
  const handleLogin = () => {
    close();
    openLoginPrompt();
  };

  /** 计算菜单定位（移动端强制底部面板） */
  const getMenuStyle = (): React.CSSProperties => {
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (isMobile) {
      return { left: 12, right: 12, bottom: `calc(76px + var(--safe-area-bottom))`, top: 'auto' };
    }
    if (!rect) return {};
    if (placement === 'below') {
      return {
        left: Math.max(8, rect.right - 280),
        top: Math.min(rect.bottom + 8, window.innerHeight - 320),
        right: 'auto',
        bottom: 'auto',
      };
    }
    // 'right'：侧栏，菜单出现在头像右侧，底部与触发器底部对齐
    // 用 bottom 定位（菜单向上生长），高度自适应内容，无需估算
    return {
      left: Math.min(rect.right + 8, window.innerWidth - 288),
      bottom: Math.max(8, window.innerHeight - rect.bottom),
      top: 'auto',
      right: 'auto',
    };
  };

  return (
    <div className={wrapperClassName}>
      <button
        ref={triggerRef}
        className={`${styles.trigger} ${showUsername ? styles.triggerWide : ''} ${triggerClassName}`}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user ? user.username : '账号'}
      >
        {iconMode ? (
          <span className={styles.iconTrigger} style={{ width: size, height: size }}>
            <Settings size={Math.round(size * 0.55)} />
          </span>
        ) : user ? (
          <Avatar src={user.avatar} username={user.username} size={size} className={styles.avatar} />
        ) : (
          <span className={styles.avatarPlaceholder} style={{ width: size, height: size }}>
            <User size={Math.round(size * 0.5)} />
          </span>
        )}
        {showUsername && (
          <span className={styles.triggerText}>
            <span className={styles.username}>{user?.username ?? '登录'}</span>
            {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            className={`${styles.menu} ${window.matchMedia('(max-width: 768px)').matches ? styles.menuSheet : styles.menuFloat}`}
            style={getMenuStyle()}
            role="menu"
          >
            {/* 用户信息头 */}
            <div className={styles.menuHeader}>
              {user ? (
                <>
                  <Avatar
                    src={user.avatar}
                    username={user.username}
                    size={44}
                    className={styles.menuAvatar}
                  />
                  <div className={styles.menuUserInfo}>
                    <strong>{user.username}</strong>
                    {user.bio && <small>{user.bio}</small>}
                  </div>
                </>
              ) : (
                <div className={styles.menuUserInfo}>
                  <strong>未登录</strong>
                  <small>登录后即可互动</small>
                </div>
              )}
            </div>

            {user && (
              <Link to="/profile" className={styles.item} onClick={close} role="menuitem">
                <span className={styles.itemIcon}>
                  <User size={16} />
                </span>
                <span>个人主页</span>
              </Link>
            )}

            {/* 主题切换 */}
            <div className={styles.sectionLabel}>主题</div>
            {themeOptions.map((opt) => (
              <button
                key={opt.key}
                className={`${styles.item} ${mode === opt.key ? styles.itemActive : ''}`}
                onClick={() => setMode(opt.key)}
                role="menuitemradio"
                aria-checked={mode === opt.key}
              >
                <span className={styles.itemIcon}>{opt.icon}</span>
                <span>{opt.label}</span>
                {mode === opt.key && <Check size={14} className={styles.itemCheck} />}
              </button>
            ))}

            <div className={styles.divider} />

            {/* 退出登录 / 登录 */}
            {user ? (
              <button
                className={`${styles.item} ${styles.itemDanger}`}
                onClick={handleLogout}
                role="menuitem"
              >
                <span className={styles.itemIcon}>
                  <LogOut size={16} />
                </span>
                <span>退出登录</span>
              </button>
            ) : (
              <button className={`${styles.item} ${styles.itemLogin}`} onClick={handleLogin} role="menuitem">
                <span className={styles.itemIcon}>
                  <LogIn size={16} />
                </span>
                <span>登录</span>
              </button>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
