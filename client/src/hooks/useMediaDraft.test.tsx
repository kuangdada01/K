/**
 * 媒体草稿 Hook 测试（useMediaDraft）
 * 覆盖：浏览器环境选择视频后台上传临时预览（成功置 tempVideoUrl / 失败静默降级）、
 * 移除/放弃清理临时文件、（无浏览器 blob 支持时的）状态不复活。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ChangeEvent } from 'react';
import { useMediaDraft } from './useMediaDraft';

const mocks = vi.hoisted(() => ({
  isNative: false,
  uploadTempVideo: vi.fn(),
  deleteTempVideo: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => mocks.isNative,
  },
}));

vi.mock('../api/posts', () => ({
  uploadTempVideo: mocks.uploadTempVideo,
  deleteTempVideo: mocks.deleteTempVideo,
}));

vi.mock('../components/ui/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../utils', () => ({
  fileToPreviewUrl: vi.fn((f: File) => Promise.resolve(`blob:mock-${f.name}`)),
}));

function makeVideoFile(name = 'test.mp4'): File {
  return new File([new Uint8Array(1024)], name, { type: 'video/mp4' });
}

function pickVideo(hook: ReturnType<typeof renderHook<ReturnType<typeof useMediaDraft>, unknown>>['result'], file: File) {
  // handleVideoSelect 的 onChange 事件对象形态
  const e = { target: { files: [file], value: 'C:\\fakepath\\' + file.name } } as unknown as ChangeEvent<HTMLInputElement>;
  act(() => {
    hook.current.handleVideoSelect(e);
  });
}

beforeEach(() => {
  mocks.isNative = false;
  mocks.uploadTempVideo.mockReset();
  mocks.deleteTempVideo.mockReset();
  // 默认成功落地（各用例按需覆盖）；deleteTempVideo 需返回 Promise（cleanup 链 .catch）
  mocks.uploadTempVideo.mockResolvedValue({ url: '/uploads/temp/temp-0.mp4' });
  mocks.deleteTempVideo.mockResolvedValue({ ok: true });
  // jsdom 无 blob URL 实现：打桩
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stub');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

describe('useMediaDraft 临时视频预览通道', () => {
  it('浏览器环境：选择视频后台上传 temp，成功置 tempVideoUrl 且不影响 blob 预览', async () => {
    mocks.uploadTempVideo.mockResolvedValue({ url: '/uploads/temp/temp-1.mp4' });
    const { result } = renderHook(() => useMediaDraft());
    pickVideo(result, makeVideoFile());

    expect(result.current.videoPreview).toBe('blob:stub');
    expect(mocks.uploadTempVideo).toHaveBeenCalledTimes(1);
    expect(result.current.tempVideoUploading).toBe(true);

    await act(async () => {
      await result.current.waitForTempVideoUpload();
    });
    expect(result.current.tempVideoUrl).toBe('/uploads/temp/temp-1.mp4');
    expect(result.current.tempVideoUploading).toBe(false);
  });

  it('浏览器环境：temp 上传失败静默降级（tempVideoUrl 保持 null，不抛错）', async () => {
    mocks.uploadTempVideo.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useMediaDraft());
    pickVideo(result, makeVideoFile());

    await act(async () => {
      await result.current.waitForTempVideoUpload();
    });
    expect(result.current.tempVideoUrl).toBeNull();
    expect(result.current.tempVideoUploading).toBe(false);
    // blob 预览不受影响
    expect(result.current.videoPreview).toBe('blob:stub');
  });

  it('移除视频：删除服务端临时文件并复位 temp 状态', async () => {
    mocks.uploadTempVideo.mockResolvedValue({ url: '/uploads/temp/temp-2.mp4' });
    const { result } = renderHook(() => useMediaDraft());
    pickVideo(result, makeVideoFile());
    await act(async () => {
      await result.current.waitForTempVideoUpload();
    });
    expect(result.current.tempVideoUrl).toBe('/uploads/temp/temp-2.mp4');

    act(() => {
      result.current.handleRemoveVideo();
    });
    expect(mocks.deleteTempVideo).toHaveBeenCalledWith('/uploads/temp/temp-2.mp4');
    expect(result.current.tempVideoUrl).toBeNull();
    expect(result.current.videoFile).toBeNull();
  });

  it('原生 App：不触发 temp 上传（blob 预览对 App WebView 可靠）', () => {
    mocks.isNative = true;
    const { result } = renderHook(() => useMediaDraft());
    pickVideo(result, makeVideoFile());
    expect(mocks.uploadTempVideo).not.toHaveBeenCalled();
    expect(result.current.tempVideoUrl).toBeNull();
  });

  it('放弃后落地结果不复活 temp 状态（代数守卫）', async () => {
    let resolveUpload!: (v: { url: string }) => void;
    mocks.uploadTempVideo.mockReturnValue(
      new Promise<{ url: string }>((res) => {
        resolveUpload = res;
      })
    );
    const { result } = renderHook(() => useMediaDraft());
    pickVideo(result, makeVideoFile());

    // 上传未完成时移除视频
    act(() => {
      result.current.handleRemoveVideo();
    });

    // 上传随后落地成功：不得重新置 tempVideoUrl（文件已放弃，服务端 TTL 兜底）
    await act(async () => {
      resolveUpload({ url: '/uploads/temp/temp-3.mp4' });
      await result.current.waitForTempVideoUpload();
    });
    expect(result.current.tempVideoUrl).toBeNull();
    expect(mocks.uploadTempVideo).toHaveBeenCalledTimes(1);
  });

  it('卸载时清理遗留临时文件', async () => {
    mocks.uploadTempVideo.mockResolvedValue({ url: '/uploads/temp/temp-4.mp4' });
    const { result, unmount } = renderHook(() => useMediaDraft());
    pickVideo(result, makeVideoFile());
    await act(async () => {
      await result.current.waitForTempVideoUpload();
    });

    act(() => {
      unmount();
    });
    expect(mocks.deleteTempVideo).toHaveBeenCalledWith('/uploads/temp/temp-4.mp4');
  });
});