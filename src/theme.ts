/**
 * 画布主题：把应用样式（src/styles.css）:root 里的 CSS 变量读成 Theme 对象。
 * 只在 main.ts 启动时读一次，Renderer/Editor 通过构造参数接收，
 * 纯逻辑模块不读 DOM、不读全局主题。
 *
 * 每个 token 都带一份与 src/styles.css :root 一致的默认值：
 * 变量缺失时 canvas 不能静默沿用旧值（P3），dev 下会把缺失的 token 汇总后 console.warn 一次。
 * 界面控件的配色不在这里读：那是 miko_ui 的 token 体系，画布只消费自己的绘制常量。
 */

export interface Theme {
  /* 颜色 */
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

  /* 线宽（屏幕像素） */
  strokeWidth: number;
  strokeWidthHot: number;
  selectionWidth: number;
  /** 网格/尺寸线/选中环等 1px 发丝线 */
  hairlineWidth: number;

  /* 点半径（屏幕像素） */
  pointRadius: number;
  pointRadiusHot: number;
  pointSelectedRadius: number;
  /** 选中点外圈相对点半径的额外距离 */
  selectedRingExtra: number;

  /* 虚线样式：屏幕像素下的 on/off 交替长度 */
  dashConstruction: number[];
  dashPreview: number[];
  dashDim: number[];
  dashMarquee: number[];

  /* 箭头（屏幕像素） */
  arrowSize: number;
  arrowHalfWidth: number;

  snapArm: number;
  marqueeFillAlpha: number;
  /** 描边像素对齐量：0.5 让 1px 线落在像素中心 */
  pixelAlign: number;
  dimFont: string;
}

/** 每个 token 的默认值必须与 src/styles.css 的 :root 保持一致 */
const DEFAULT_BG = '#0e101a';
const DEFAULT_GRID = 'rgba(142, 159, 199, 0.1)';
const DEFAULT_AXIS = 'rgba(142, 159, 199, 0.18)';
const DEFAULT_GEOM = '#9fd4ff';
const DEFAULT_CONSTRUCTION = 'rgba(109, 213, 255, 0.45)';
const DEFAULT_HOT = '#ffd38f';
const DEFAULT_SELECTION = '#ff7ab6';
const DEFAULT_POINT = '#dbe4ff';
const DEFAULT_POINT_FIXED = '#ff9aa8';
const DEFAULT_DIM = '#e0a56b';
const DEFAULT_PREVIEW = '#6dd5ff';
const DEFAULT_SNAP = '#8ee6a5';
const DEFAULT_MARQUEE_WINDOW = '#6dd5ff';
const DEFAULT_MARQUEE_CROSS = '#8ee6a5';
const DEFAULT_DIM_FONT = "12px 'JetBrains Mono Slashed', ui-monospace, monospace";

const DEFAULT_STROKE_WIDTH = 1.5;
const DEFAULT_STROKE_WIDTH_HOT = 2.4;
const DEFAULT_SELECTION_WIDTH = 2.6;
const DEFAULT_HAIRLINE_WIDTH = 1;
const DEFAULT_POINT_RADIUS = 2.6;
const DEFAULT_POINT_RADIUS_HOT = 4.5;
const DEFAULT_POINT_SELECTED_RADIUS = 5.4;
const DEFAULT_SELECTED_RING_EXTRA = 2;
const DEFAULT_ARROW_SIZE = 8;
const DEFAULT_ARROW_HALF_WIDTH = 3;
const DEFAULT_SNAP_ARM = 6;
const DEFAULT_MARQUEE_FILL_ALPHA = 0.08;
const DEFAULT_PIXEL_ALIGN = 0.5;

const DEFAULT_DASH_CONSTRUCTION: readonly number[] = [5, 5];
const DEFAULT_DASH_PREVIEW: readonly number[] = [5, 4];
const DEFAULT_DASH_DIM: readonly number[] = [3, 3];
const DEFAULT_DASH_MARQUEE: readonly number[] = [4, 3];

/** 测试/无 DOM 环境下没有 document：直接用默认值，不当作「缺 token」报警 */
const documentStyle = (): CSSStyleDeclaration | undefined => {
  if (typeof document === 'undefined') return undefined;
  return getComputedStyle(document.documentElement);
};

/** 缺失告警只发一次，避免同一份缺失在多次 readTheme 时刷屏 */
let missingWarned = false;

/** Vite 构建下为布尔值；纯 node 环境（如直接跑类型剥离脚本）没有 import.meta.env，按生产处理 */
const IS_DEV = (import.meta.env as ImportMetaEnv | undefined)?.DEV === true;

const warnMissing = (names: readonly string[]): void => {
  if (missingWarned || !IS_DEV) return;
  missingWarned = true;
  // eslint-disable-next-line no-console -- P3：dev 下暴露缺失的 canvas 主题 token，避免静默沿用默认值
  console.warn(`[theme] src/styles.css 缺少主题 token，已回退默认值：${names.join(', ')}`);
};

/**
 * 读取主题。
 * @param style 传入 getComputedStyle(document.documentElement) 的结果；
 *              省略时自动读 document（无 document 时全部用默认值）。
 */
export function readTheme(style?: CSSStyleDeclaration): Theme {
  const source = style ?? documentStyle();
  const missing = new Set<string>();

  /** 原样读取字符串 token */
  const str = (name: string, fallback: string): string => {
    const v = source?.getPropertyValue(name).trim() ?? '';
    if (v) return v;
    if (source) missing.add(name);
    return fallback;
  };

  /** 读取数值 token；空值或非有限值都回退默认值 */
  const num = (name: string, fallback: number): number => {
    const v = source?.getPropertyValue(name).trim() ?? '';
    if (!v) {
      if (source) missing.add(name);
      return fallback;
    }
    const parsed = Number.parseFloat(v);
    if (!Number.isFinite(parsed)) {
      if (source) missing.add(name);
      return fallback;
    }
    return parsed;
  };

  /** 读取虚线 token：空白或逗号分隔的数字序列 */
  const dash = (name: string, fallback: readonly number[]): number[] => {
    const v = source?.getPropertyValue(name).trim() ?? '';
    if (!v) {
      if (source) missing.add(name);
      return [...fallback];
    }
    const parsed = v
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (parsed.length === 0 || parsed.some((n) => !Number.isFinite(n))) {
      if (source) missing.add(name);
      return [...fallback];
    }
    return parsed;
  };

  const theme: Theme = {
    bg: str('--canvas-bg', DEFAULT_BG),
    grid: str('--canvas-grid', DEFAULT_GRID),
    axis: str('--canvas-axis', DEFAULT_AXIS),
    geom: str('--geom', DEFAULT_GEOM),
    construction: str('--geom-construction', DEFAULT_CONSTRUCTION),
    hot: str('--geom-hot', DEFAULT_HOT),
    selection: str('--selection', DEFAULT_SELECTION),
    point: str('--point', DEFAULT_POINT),
    pointFixed: str('--point-fixed', DEFAULT_POINT_FIXED),
    dim: str('--dim', DEFAULT_DIM),
    preview: str('--preview', DEFAULT_PREVIEW),
    snap: str('--snap', DEFAULT_SNAP),
    marqueeWindow: str('--marquee-window', DEFAULT_MARQUEE_WINDOW),
    marqueeCross: str('--marquee-cross', DEFAULT_MARQUEE_CROSS),

    strokeWidth: num('--stroke-width', DEFAULT_STROKE_WIDTH),
    strokeWidthHot: num('--stroke-width-hot', DEFAULT_STROKE_WIDTH_HOT),
    selectionWidth: num('--selection-width', DEFAULT_SELECTION_WIDTH),
    hairlineWidth: num('--hairline-width', DEFAULT_HAIRLINE_WIDTH),

    pointRadius: num('--point-radius', DEFAULT_POINT_RADIUS),
    pointRadiusHot: num('--point-radius-hot', DEFAULT_POINT_RADIUS_HOT),
    pointSelectedRadius: num('--point-selected-radius', DEFAULT_POINT_SELECTED_RADIUS),
    selectedRingExtra: num('--selected-ring-extra', DEFAULT_SELECTED_RING_EXTRA),

    dashConstruction: dash('--dash-construction', DEFAULT_DASH_CONSTRUCTION),
    dashPreview: dash('--dash-preview', DEFAULT_DASH_PREVIEW),
    dashDim: dash('--dash-dim', DEFAULT_DASH_DIM),
    dashMarquee: dash('--dash-marquee', DEFAULT_DASH_MARQUEE),

    arrowSize: num('--arrow-size', DEFAULT_ARROW_SIZE),
    arrowHalfWidth: num('--arrow-half-width', DEFAULT_ARROW_HALF_WIDTH),

    snapArm: num('--snap-arm', DEFAULT_SNAP_ARM),
    marqueeFillAlpha: num('--marquee-fill-alpha', DEFAULT_MARQUEE_FILL_ALPHA),
    pixelAlign: num('--pixel-align', DEFAULT_PIXEL_ALIGN),
    dimFont: str('--dim-font', DEFAULT_DIM_FONT),
  };

  if (missing.size > 0) warnMissing([...missing]);
  return theme;
}
