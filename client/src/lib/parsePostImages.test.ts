/**
 * ============================================================
 * 帖子图片解析与编辑态清洗测试（lib/parsePostImages）
 * ============================================================
 * `cleanEditImages` 是 P2-24 从 `Profile.tsx` / `PostDetail.tsx` 两处逐字重复
 * 的代码合并而来。合并的风险全在**回落顺序**上：
 * `images` 存在时（即使空数组）必须用它、不再回落到 `image_url`，
 * 否则「编辑帖子」带进编辑框的图片会变。
 */

import { describe, it, expect } from 'vitest';
import { parsePostImages, cleanEditImages } from './parsePostImages';

describe('parsePostImages', () => {
  it('优先用 images 非空数组', () => {
    expect(parsePostImages({ images: ['/a.jpg', '/b.jpg'], image_url: '["/a.jpg"]' })).toEqual([
      '/a.jpg',
      '/b.jpg',
    ]);
  });

  it('images 为空时解析 image_url 的 JSON 数组', () => {
    expect(parsePostImages({ images: [], image_url: '["/x.jpg","/y.jpg"]' })).toEqual(['/x.jpg', '/y.jpg']);
  });

  it('image_url 不是 JSON 时按单元素兜底', () => {
    expect(parsePostImages({ images: [], image_url: '/single.jpg' })).toEqual(['/single.jpg']);
  });

  it('image_url 是空数组 JSON 时兜底为原串（保持既有行为）', () => {
    expect(parsePostImages({ images: [], image_url: '[]' })).toEqual(['[]']);
  });
});

describe('cleanEditImages', () => {
  it('视频帖不带图片（视频与图片互斥）', () => {
    expect(
      cleanEditImages({ video_url: '/uploads/v.mp4', images: ['/a.jpg'], image_url: '["/a.jpg"]' })
    ).toEqual([]);
  });

  it('过滤历史脏值 [] 与 ["[]"]', () => {
    expect(
      cleanEditImages({
        video_url: null,
        images: ['/a.jpg', '[]', '["[]"]', '/b.jpg'],
        image_url: '["/a.jpg"]',
      })
    ).toEqual(['/a.jpg', '/b.jpg']);
  });

  it('★ images 为空数组时用它（不回落到 image_url）—— 回落顺序不能变', () => {
    expect(cleanEditImages({ video_url: null, images: [], image_url: '["/from-image-url.jpg"]' })).toEqual(
      []
    );
  });

  it('images 缺失（undefined）时才回落到 image_url，且按**原始串**取用（不解析 JSON）', () => {
    // 注意与 parsePostImages 的差别：这里回落的 `[post.image_url]` 是原串，
    // 不解析成数组 —— 这是拆分前两处重复代码的原样语义，合并时必须保持
    expect(cleanEditImages({ video_url: null, image_url: '["/from-image-url.jpg"]' })).toEqual([
      '["/from-image-url.jpg"]',
    ]);
  });

  it('回落到 image_url 时同样过滤脏值', () => {
    expect(cleanEditImages({ image_url: '["[]"]' })).toEqual([]);
    expect(cleanEditImages({ image_url: '[]' })).toEqual([]);
  });

  it('video_url 为空串按图文帖处理（与旧实现同样只判真假）', () => {
    expect(cleanEditImages({ video_url: '', images: ['/a.jpg'], image_url: '[]' })).toEqual(['/a.jpg']);
  });
});
