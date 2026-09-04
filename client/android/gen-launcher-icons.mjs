/**
 * 生成 API < 26 的遗留启动图标 PNG（ic_launcher / ic_launcher_round）
 *
 * 几何与配色同 res/drawable/ic_launcher_{background,foreground}.xml 保持一致，
 * 修改配色后重跑一次即可同步所有密度：
 *   node gen-launcher-icons.mjs
 *
 * 依赖：sharp（server 包内已有，本机无则 npm i -D sharp）
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RES = join(__dirname, 'app/src/main/res')

/** 密度桶 → 图标边长（dp 48，倍率 1/1.5/2/3/4） */
const DENSITIES = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
]

/** 与矢量 drawable 一一对应的 SVG 模板（viewBox 108x108dp） */
const svg = (round) => `<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108" viewBox="0 0 108 108">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="108" y2="108" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2F5D50"/>
      <stop offset="1" stop-color="#24493E"/>
    </linearGradient>
    <radialGradient id="glaze" cx="30" cy="22" r="88" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.149"/>
      <stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0.043"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="k" x1="41" y1="34" x2="67" y2="74" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#F7FBF7"/>
      <stop offset="0.5" stop-color="#F2F7F2"/>
      <stop offset="1" stop-color="#C9A962"/>
    </linearGradient>
    <clipPath id="circle"><circle cx="54" cy="54" r="54"/></clipPath>
  </defs>
  <g${round ? ' clip-path="url(#circle)"' : ''}>
    <path d="M54,0C10.8,0 0,10.8 0,54C0,97.2 10.8,108 54,108C97.2,108 108,97.2 108,54C108,10.8 97.2,0 54,0Z" fill="url(#bg)"/>
    <path d="M54,0C10.8,0 0,10.8 0,54C0,97.2 10.8,108 54,108C97.2,108 108,97.2 108,54C108,10.8 97.2,0 54,0Z" fill="url(#glaze)"/>
    <g fill="none" stroke="url(#k)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
      <path d="M46,39L46,69"/>
      <path d="M62,39L46,54L62,69"/>
    </g>
  </g>
</svg>`

const require = createRequire(import.meta.url)
let sharp
for (const id of ['sharp', join(__dirname, '../../server/node_modules/sharp')]) {
  try {
    sharp = require(id)
    break
  } catch {}
}
if (!sharp) {
  console.error('未找到 sharp，请先安装：npm i -D sharp')
  process.exit(1)
}

for (const [dir, size] of DENSITIES) {
  await mkdir(join(RES, dir), { recursive: true })
  for (const [name, round] of [
    ['ic_launcher.png', false],
    ['ic_launcher_round.png', true],
  ]) {
    const buf = await sharp(Buffer.from(svg(round)), { density: 384 })
      .resize(size, size, { kernel: 'lanczos3' })
      .png({ compressionLevel: 9 })
      .toBuffer()
    await writeFile(join(RES, dir, name), buf)
  }
  console.log(`✓ ${dir} @ ${size}px`)
}
console.log('全部完成')
