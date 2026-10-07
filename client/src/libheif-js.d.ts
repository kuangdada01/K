/**
 * libheif-js 类型声明（包内未提供 d.ts）
 *
 * 注意：
 * - 必须放在独立 .d.ts 文件中做 ambient module 声明；
 *   若写在 .ts 源码内会被视为 module augmentation，
 *   而 wasm-bundle.js 解析到实际 JS 文件，无法被增强（TS2665）。
 * - wasm-bundle.js 是 CJS 入口（module.exports = require('./libheif-wasm/libheif-bundle.js')()），
 *   Vite 转 ESM 后运行时形态可能是 default 或命名导出，需用 mod.default ?? mod 兜底。
 * - display() 由 libheif 原生完成色彩管理（P3→sRGB）与 EXIF 方向应用，
 *   输出 RGBA 到传入的 ImageData。
 */
declare module 'libheif-js/wasm-bundle' {
  export interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(imageData: ImageData, callback: (displayData: ImageData | null) => void): void;
  }
  export interface HeifDecoderInstance {
    decode(buffer: ArrayBuffer | Uint8Array): HeifImage[];
  }
  export const HeifDecoder: new () => HeifDecoderInstance;
}
