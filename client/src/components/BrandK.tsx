/**
 * 品牌「K」标记（2026-10 定稿：粗体几何字形）。
 *
 * 几何：竖笔平头 + 两条斜臂在腰点相会、臂端水平平切，竖笔右缘与两臂间
 * 保留两道斜向分缝。母版网格 530x562，与 client/public/favicon.svg、
 * Android ic_launcher_foreground.xml 同源；颜色走 currentColor。
 *
 * 放置：字形墨迹中位线偏左（竖笔实、右臂带分缝），纯包围盒居中会显偏左，
 * 满量重心补偿又会显偏右；取折半 +24/562（母版单位，两轮真机反馈收敛值）。
 * 故 viewBox 左右留白非对称（左 48 / 右 0，合计 578 = 530 + 2 x 24）。
 */
type BrandKProps = {
  /** 标记高度（px），宽度按母版比例自动换算 */
  height?: number;
};

export default function BrandK({ height = 15 }: BrandKProps) {
  return (
    <svg
      width={(height * 578) / 562}
      height={height}
      viewBox="0 0 578 562"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path
        transform="translate(48 0)"
        d="M0,0 H172 V218 L325,0 H530 L325,264 L530,562 H325 L172,334 V562 H0 Z"
      />
    </svg>
  );
}
