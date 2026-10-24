/**
 * ============================================================
 * 私信文件工具（纯函数）测试
 * ============================================================
 * 覆盖三类容易回归的点：
 *  1. 大小格式化（1.0 KB / 1.5 KB / 10 MB 的口径）；
 *  2. 归类（扩展名优先，MIME 兜底，大小写不敏感）；
 *  3. 预览能力必须与服务端 inline 白名单一致：html / svg / xml 不给预览。
 */

import { describe, it, expect } from 'vitest';
import { isExecutableFile } from '@k/shared';
import { fileKind, fileMetaText, formatFileSize, isPreviewable, kindLabel } from './fileMessage';

describe('formatFileSize', () => {
  it('按 B/KB/MB/GB 分档，小于 10 保留一位小数', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(-5)).toBe('0 B');
    expect(formatFileSize(undefined)).toBe('0 B');
    expect(formatFileSize(1023)).toBe('1023 B');
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(10 * 1024 * 1024)).toBe('10 MB');
    expect(formatFileSize(100 * 1024 * 1024)).toBe('100 MB');
    expect(formatFileSize(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });
});

describe('fileKind', () => {
  it('扩展名优先且大小写不敏感', () => {
    expect(fileKind({ file_name: '报告.PDF' })).toBe('pdf');
    expect(fileKind({ file_name: 'a.docx' })).toBe('doc');
    expect(fileKind({ file_name: 'a.xlsx' })).toBe('sheet');
    expect(fileKind({ file_name: 'a.pptx' })).toBe('slide');
    expect(fileKind({ file_name: 'a.7z' })).toBe('archive');
    expect(fileKind({ file_name: 'a.epub' })).toBe('ebook');
    expect(fileKind({ file_name: 'a.mp4' })).toBe('video');
    expect(fileKind({ file_name: 'a.m4a' })).toBe('audio');
    expect(fileKind({ file_name: 'a.png' })).toBe('image');
    expect(fileKind({ file_name: 'a.tar' })).toBe('archive');
    // 安装包/可执行（2026-10-24）：类型已放开，归到「安装包」，下载前过警示确认
    expect(fileKind({ file_name: 'app.apk' })).toBe('app');
    expect(fileKind({ file_name: 'tool.exe' })).toBe('app');
    expect(fileKind({ file_name: 'setup.MSI' })).toBe('app');
    expect(fileKind({ file_name: 'README' })).toBe('other');
  });

  it('没有扩展名时用 MIME 兜底', () => {
    expect(fileKind({ file_name: 'blob', file_mime: 'image/jpeg' })).toBe('image');
    expect(fileKind({ file_name: 'blob', file_mime: 'video/mp4' })).toBe('video');
    expect(fileKind({ file_name: 'blob', file_mime: 'application/pdf' })).toBe('pdf');
    expect(fileKind({ file_name: 'blob', file_mime: 'text/plain; charset=utf-8' })).toBe('text');
    expect(fileKind({ file_name: 'blob', file_mime: 'application/zip' })).toBe('other');
  });
});

describe('isPreviewable', () => {
  it('图片/音视频/PDF/纯文本可预览', () => {
    expect(isPreviewable({ file_name: 'a.png' })).toBe(true);
    expect(isPreviewable({ file_name: 'a.mp4' })).toBe(true);
    expect(isPreviewable({ file_name: 'a.mp3' })).toBe(true);
    expect(isPreviewable({ file_name: 'a.pdf' })).toBe(true);
    expect(isPreviewable({ file_name: 'a.txt' })).toBe(true);
    expect(isPreviewable({ file_name: 'a.md' })).toBe(true);
    expect(isPreviewable({ file_name: 'a.json' })).toBe(true);
  });

  it('服务端只会以附件下发的类型不给预览（html/svg/xml/css/js/压缩包/Office/安装包）', () => {
    expect(isPreviewable({ file_name: 'a.html' })).toBe(false);
    expect(isPreviewable({ file_name: 'a.svg' })).toBe(false);
    expect(isPreviewable({ file_name: 'a.xml' })).toBe(false);
    expect(isPreviewable({ file_name: 'a.css' })).toBe(false);
    expect(isPreviewable({ file_name: 'a.js' })).toBe(false);
    expect(isPreviewable({ file_name: 'a.zip' })).toBe(false);
    expect(isPreviewable({ file_name: 'a.docx' })).toBe(false);
    expect(isPreviewable({ file_name: 'a.apk' })).toBe(false);
    expect(isPreviewable({ file_name: 'a.exe' })).toBe(false);
  });
});

describe('isExecutableFile（shared：下载前警示的判定）', () => {
  it('安装包与系统脚本要警示', () => {
    expect(isExecutableFile('app.apk')).toBe(true);
    expect(isExecutableFile('tool.EXE')).toBe(true);
    expect(isExecutableFile('run.bat')).toBe(true);
    expect(isExecutableFile('setup.dmg')).toBe(true);
  });

  it('普通文件不警示', () => {
    expect(isExecutableFile('report.pdf')).toBe(false);
    expect(isExecutableFile('deploy.sh')).toBe(false);
    expect(isExecutableFile('main.js')).toBe(false);
    expect(isExecutableFile('无扩展名')).toBe(false);
  });
});

describe('fileMetaText / kindLabel', () => {
  it('气泡副标题是「大小 · 类型」', () => {
    expect(fileMetaText({ file_name: 'x.pdf', file_size: 1536 })).toBe('1.5 KB · PDF');
    expect(fileMetaText({ file_name: 'x.zip', file_size: 0 })).toBe('0 B · 压缩包');
    expect(kindLabel('other')).toBe('文件');
  });
});
