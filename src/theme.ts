/**
 * 画布样式常量统一从 :root 的 CSS 变量读取。
 * 这样同一份颜色/线宽只写在 styles.css 里，UI 与 canvas 不会各存一份而逐渐不一致。
 */

export interface Theme {
  bg: string;
  grid: string;
  axis: string;
  geom: string;
  construction: string;
  hot: string;
  selection: string;
  point: string;
  pointFixed: string;
  dim: string;
  preview: string;
  snap: string;
  marqueeWindow: string;
  marqueeCross: string;
  strokeWidth: number;
  strokeWidthHot: number;
  selectionWidth: number;
  pointRadius: number;
  pointRadiusHot: number;
  pointSelectedRadius: number;
  snapArm: number;
  marqueeFillAlpha: number;
  dimFont: string;
}

const token = (style: CSSStyleDeclaration, name: string): string =>
  style.getPropertyValue(name).trim();

/** CSS 变量缺失时 parseFloat 会得到 NaN，这里回退到 1，避免 canvas API 直接报错 */
const num = (style: CSSStyleDeclaration, name: string): number => {
  const v = Number.parseFloat(token(style, name));
  return Number.isFinite(v) ? v : 1;
};

export function readTheme(): Theme {
  const s = getComputedStyle(document.documentElement);
  return {
    bg: token(s, '--canvas-bg'),
    grid: token(s, '--canvas-grid'),
    axis: token(s, '--canvas-axis'),
    geom: token(s, '--geom'),
    construction: token(s, '--geom-construction'),
    hot: token(s, '--geom-hot'),
    selection: token(s, '--selection'),
    point: token(s, '--point'),
    pointFixed: token(s, '--point-fixed'),
    dim: token(s, '--dim'),
    preview: token(s, '--preview'),
    snap: token(s, '--snap'),
    marqueeWindow: token(s, '--marquee-window'),
    marqueeCross: token(s, '--marquee-cross'),
    strokeWidth: num(s, '--stroke-width'),
    strokeWidthHot: num(s, '--stroke-width-hot'),
    selectionWidth: num(s, '--selection-width'),
    pointRadius: num(s, '--point-radius'),
    pointRadiusHot: num(s, '--point-radius-hot'),
    pointSelectedRadius: num(s, '--point-selected-radius'),
    snapArm: num(s, '--snap-arm'),
    marqueeFillAlpha: num(s, '--marquee-fill-alpha'),
    dimFont: token(s, '--dim-font'),
  };
}
