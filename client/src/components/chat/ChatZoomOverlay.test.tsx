/**
 * ChatZoomOverlay 分流测试：
 * 原生可用 → 交给原生查看器，且**不渲染** Web 覆盖层（避免两套 UI 叠加）；
 * 原生不可用 / 打开失败（返回 null）→ 回退 Web 覆盖层。
 * 这里的核心是「看图能力不会因为原生出问题而失效」。
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type OpenArg = { images: string[]; index: number };
type OpenResult = { index: number } | null;

const availableMock = vi.fn(() => false);
const openMock = vi.fn<(o: OpenArg) => Promise<OpenResult>>(async () => null);

vi.mock('../../lib/nativeImageViewer', () => ({
  isNativeViewerAvailable: () => availableMock(),
  openNativeViewer: (o: OpenArg) => openMock(o),
  authHeadersFor: () => ({}),
  rectOf: () => undefined,
}));

import ChatZoomOverlay from './ChatZoomOverlay';

afterEach(() => {
  vi.clearAllMocks();
  availableMock.mockReturnValue(false);
  localStorage.clear();
});

describe('ChatZoomOverlay', () => {
  it('原生不可用：渲染 Web 覆盖层（图片与关闭按钮都在）', () => {
    render(<ChatZoomOverlay zoomImage="/uploads/a.jpg" onClose={() => {}} />);
    const img = document.querySelector('img');
    expect(img).toBeTruthy();
    expect(screen.getByLabelText('关闭预览')).toBeTruthy();
    expect(openMock).not.toHaveBeenCalled();
  });

  it('原生可用：调用原生查看器，native 未结算前不渲染 Web 覆盖层', async () => {
    availableMock.mockReturnValue(true);
    let resolveNative: (v: OpenResult) => void = () => {};
    openMock.mockImplementation(
      () =>
        new Promise<OpenResult>((res) => {
          resolveNative = res;
        })
    );
    const onClose = vi.fn();
    render(<ChatZoomOverlay zoomImage="/uploads/a.jpg" onClose={onClose} />);

    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));
    // 原生接管中：既没有 Web 覆盖层，也没提前关闭
    expect(document.querySelector('img')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // 原生关闭后：回调父级卸载
    resolveNative({ index: 0 });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('原生打开失败（返回 null）：回退 Web 覆盖层，看图不失效', async () => {
    availableMock.mockReturnValue(true);
    openMock.mockResolvedValue(null);
    render(<ChatZoomOverlay zoomImage="/uploads/a.jpg" onClose={() => {}} />);

    await waitFor(() => expect(document.querySelector('img')).toBeTruthy());
    expect(screen.getByLabelText('关闭预览')).toBeTruthy();
  });

  it('绝对地址：把 resolveMediaUrl 结果交给原生', async () => {
    availableMock.mockReturnValue(true);
    openMock.mockResolvedValue({ index: 0 });
    render(<ChatZoomOverlay zoomImage="/api/messages/1/image" onClose={() => {}} />);
    await waitFor(() => expect(openMock).toHaveBeenCalled());
    const arg = openMock.mock.calls[0]![0];
    expect(arg.index).toBe(0);
    expect(arg.images).toHaveLength(1);
  });
});
