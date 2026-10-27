/**
 * 出版排版编辑器（map.html）的常量与默认值。
 *
 * 是什么：`scene.json`（format `mapdoc-page`）的格式标识、上传/下载参数、纸张预设、
 * 默认页边距/字号/图框/图例/色标参数、校验上下限与交互缩放系数。
 * 为什么集中在这里：预览（浏览器 DOM）与成品（浏览器内 `render/compose-svg.ts`）必须共享同一套
 * 默认值；把它们放在 config 层，core/render/ui/app 只读不写，避免「预览与成品标定不一致」。
 * 数字口径：全部是 pt（1 用户单位 = 1pt），写进 SVG 时最多 3 位小数、去尾零（见
 * `render/page-format.ts` 与 `docs/PAGE-EDITOR.md` §5）。
 * 元信息：作者 frontend，2026-10-27，随 `docs/PAGE-EDITOR.md` 新契约落地。
 */

/* ---------------- scene 文档标识 ---------------- */

/** scene.json 的格式标识（契约 §4） */
export const PAGE_SCENE_FORMAT = 'mapdoc-page';

/** 版本：必须精确匹配，新增可选字段也升版本 */
export const PAGE_SCENE_VERSION = 1;

/** geo.json 的格式标识（只读，前端只校验这两个字段用于提示） */
export const PAGE_GEO_FORMAT = 'mapdoc-geo';
export const PAGE_GEO_VERSION = 1;

/* ---------------- 上传与下载（文件 I/O，无后端） ---------------- */

/**
 * 上传文件选择框的 accept：底图 SVG 与 JSON（geo / scene）。
 * 只看扩展名即可：内容格式由 `core/document.ts` 按 `format` 字段再判一次。
 */
export const PAGE_UPLOAD_ACCEPT = '.svg,.json,application/json,image/svg+xml';

/** 导出下载用 Blob objectURL 的延迟 revoke（毫秒）：给浏览器留出读取下载数据的时间 */
export const PAGE_DOWNLOAD_REVOKE_MS = 1000;

/**
 * 打开校验的尺寸容差（pt）：`geo.base` 的 viewBox/width/height 与底图根标签的
 * 对应值比较时允许的最大偏差。Cartopy 落盘会做 3 位小数规范化，0.01pt 足够容下。
 */
export const PAGE_BASE_SIZE_TOLERANCE_PT = 0.01;

/* ---------------- 数值口径与上限（契约 §4） ---------------- */

/** 落盘/输出的小数位 */
export const PAGE_DECIMALS = 3;

/** 一页最多元素数 */
export const PAGE_MAX_ITEMS = 500;

/** 纸张宽高允许范围（pt） */
export const PAGE_PAPER_MIN_PT = 50;
export const PAGE_PAPER_MAX_PT = 5000;

/** 地图宽度必须严格大于它（pt） */
export const PAGE_MIN_MAP_WIDTH_PT = 1;

/** 单条文字元素的行数与每行字符数上限 */
export const PAGE_MAX_TEXT_LINES = 40;
export const PAGE_MAX_TEXT_LINE_CHARS = 200;

/** 图例条目数的软上限：只用于 UI 防御，契约未规定 */
export const PAGE_MAX_LEGEND_ENTRIES = 100;

/* ---------------- 纸张预设 ---------------- */

/** 预设 id；`Custom` 表示自定义尺寸（只记忆在 paper.preset 里） */
export type PaperPresetId = 'A5' | 'A4' | 'A3' | 'Letter' | 'Custom';

/** 纸张方向；landscape 交换宽高 */
export type PaperOrientation = 'portrait' | 'landscape';

export interface PaperPreset {
  readonly id: Exclude<PaperPresetId, 'Custom'>;
  readonly label: string;
  /** 纵向宽（pt） */
  readonly width_pt: number;
  /** 纵向高（pt） */
  readonly height_pt: number;
}

/**
 * 纸张预设（纵向尺寸，单位 pt，精确到 6 位小数）。
 * 为什么不用 841.89：A4 的精确值是 210mm × 297mm = 595.275591 × 841.889764 pt，
 * 预览与成品都按这个值排版；落盘时再按 3 位小数规范化。
 */
export const PAGE_PAPER_PRESETS: readonly PaperPreset[] = [
  { id: 'A5', label: 'A5', width_pt: 419.527559, height_pt: 595.275591 },
  { id: 'A4', label: 'A4', width_pt: 595.275591, height_pt: 841.889764 },
  { id: 'A3', label: 'A3', width_pt: 841.889764, height_pt: 1190.551181 },
  { id: 'Letter', label: 'Letter', width_pt: 612, height_pt: 792 },
];

/** 按 id 查预设；`Custom` 或未知 id 返回 null */
export function findPaperPreset(id: string): PaperPreset | null {
  return PAGE_PAPER_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** 预设 + 方向 → 页面宽高（pt）；方向为 landscape 时交换 */
export function presetSize(
  preset: PaperPreset,
  orientation: PaperOrientation,
): { width_pt: number; height_pt: number } {
  return orientation === 'landscape'
    ? { width_pt: preset.height_pt, height_pt: preset.width_pt }
    : { width_pt: preset.width_pt, height_pt: preset.height_pt };
}

/** 默认纸张：A4 横向（契约 §9） */
export const PAGE_DEFAULT_PAPER_PRESET: PaperPresetId = 'A4';
export const PAGE_DEFAULT_ORIENTATION: PaperOrientation = 'landscape';
export const PAGE_DEFAULT_PAPER_WIDTH_PT = 841.889764;
export const PAGE_DEFAULT_PAPER_HEIGHT_PT = 595.275591;

/* ---------------- 默认排版（defaultScene 用） ---------------- */

/** 默认页边距（pt）；「重新排默认版式」的初始值 */
export const PAGE_DEFAULT_MARGIN_PT = 28;

/** 地图顶部起始 y：给标题/副标题留出的高度 */
export const PAGE_DEFAULT_MAP_TOP_PT = 72;

/** 地图与右栏之间的间距 */
export const PAGE_DEFAULT_COLUMN_GAP_PT = 16;

/** 右栏（图例/注记/色标）最小/最大宽度 */
export const PAGE_DEFAULT_RIGHT_COLUMN_MIN_PT = 150;
export const PAGE_DEFAULT_RIGHT_COLUMN_MAX_PT = 260;

/** 页面底部给「来源」一行预留的高度（含与地图的间隔） */
export const PAGE_SOURCE_RESERVED_PT = 24;

/** 默认字号（pt） */
export const PAGE_TITLE_SIZE_PT = 18;
export const PAGE_SUBTITLE_SIZE_PT = 9;
export const PAGE_NOTE_SIZE_PT = 7.5;
export const PAGE_SOURCE_SIZE_PT = 7;

/** 标题/副标题首行基线相对页边的偏移（pt） */
export const PAGE_TITLE_BASELINE_OFFSET_PT = 15;
export const PAGE_SUBTITLE_BASELINE_OFFSET_PT = 32;

/** 注记首行与图例底部的间距 */
export const PAGE_NOTES_GAP_PT = 12;

/** 色标默认尺寸与与注记的间距 */
export const PAGE_COLORBAR_WIDTH_PT = 14;
export const PAGE_COLORBAR_HEIGHT_PT = 180;
export const PAGE_COLORBAR_GAP_PT = 18;

/**
 * 排版自适应比例 k 的上下限（相对 A4 横向）：小纸张（A5）把标题/注记/图例/色标整体缩小，
 * 大纸张（A3）整体放大；0.62/1.6 之外不再继续缩/放，避免字号不可读或版面失衡。
 */
export const PAGE_LAYOUT_SCALE_MIN = 0.62;
export const PAGE_LAYOUT_SCALE_MAX = 1.6;

/** 色标在默认排版里的最小高度（pt）：再小就压成一条线，不如与注记留 8pt 后贴底 */
export const PAGE_MIN_COLORBAR_HEIGHT_PT = 40;

/** 文字默认行高（倍数） */
export const PAGE_TEXT_LINE_HEIGHT = 1.35;
/** map 空间地名默认行高（多行地名更紧一点） */
export const PAGE_LABEL_LINE_HEIGHT = 1.2;

/* ---------------- 默认样式（scene.style / frame） ---------------- */

/**
 * 默认字体栈（契约 §4 示例原样）。
 * 为什么用「CJK 等宽 → 拉丁等宽 → DejaVu → sans-serif」：印刷图的中英文混排需要
 * 一套主字体兜底一套通用字体；v1 不内嵌字体（契约 §11 已知限制）。
 */
export const PAGE_DEFAULT_FONT_FAMILY =
  "'Noto Sans Mono CJK SC', 'JetBrains Mono Slashed Medium', 'DejaVu Sans', sans-serif";

export const PAGE_DEFAULT_PAPER_COLOR = '#ffffff';
export const PAGE_DEFAULT_TEXT_COLOR = '#111111';

/** 图框默认值（契约 §4 frame） */
export const PAGE_FRAME_DEFAULTS = {
  show: true,
  stroke: '#000000',
  width_pt: 0.8,
  ticks: true,
  tick_length_pt: 5,
  tick_font_size_pt: 7,
  tick_color: '#444444',
  tick_gap_pt: 2,
} as const;

/** 图例默认值（契约 §5.4 参数） */
export const PAGE_LEGEND_DEFAULTS = {
  font_size_pt: 9,
  title_size_pt: 12,
  row_height_pt: 14,
  padding_pt: 7,
  swatch_width_pt: 24,
  swatch_gap_pt: 6,
  frame_stroke: '#bbbbbb',
  frame_width_pt: 0.8,
  frame_fill: '#ffffff',
  frame_opacity: 0.94,
} as const;

/** 色标默认字号（契约 §5.5） */
export const PAGE_COLORBAR_TITLE_SIZE_PT = 8;
export const PAGE_COLORBAR_LABEL_SIZE_PT = 7;

/** 色标刻度短线长度与标签间距（契约 §5.5 的 3 / 5，写死公式里，不落 scene） */
export const PAGE_COLORBAR_TICK_LENGTH_PT = 3;
export const PAGE_COLORBAR_LABEL_GAP_PT = 5;

/* ---------------- 预览交互 ---------------- */

/** 预览缩放下限（相对 1pt = 1 CSS px） */
export const PAGE_ZOOM_MIN = 0.05;
/** 预览缩放上限：再放大只会看到底图像素 */
export const PAGE_ZOOM_MAX = 16;
/** 滚轮缩放灵敏度：缩放因子 = exp(-deltaY × 该值) */
export const PAGE_WHEEL_ZOOM_SENSITIVITY = 0.0015;
/** 「适应页面」在纸张四周留出的比例 */
export const PAGE_FIT_PADDING_RATIO = 0.04;
/** 方向键微移步长（pt）；Shift 加倍 */
export const PAGE_KEY_MOVE_PT = 1;
export const PAGE_KEY_MOVE_LARGE_PT = 10;

/**
 * 命中盒在 item 声明几何框外的容差（pt）：只服务指针精度，不是视觉框的一部分。
 * 为什么单独一个量：选中框必须原样等于 item 的声明几何框（§5.7），容差只让细小的文字/
 * 图例更容易点中；把容差混进选中框，框就会变成没有依据的外扩装饰。
 */
export const PAGE_HIT_TOLERANCE_PT = 2;

/**
 * 无 canvas 时的字体行盒回退比例（相对字号）：上伸 0.8em、下伸 0.2em。
 * 只在 node 单测/无 DOM 环境使用；浏览器路径取 canvas `fontBoundingBoxAscent/Descent`
 * （CSS font 的实测行盒），所以选中框/命中盒在浏览器里是字体度量值，不是常量。
 */
export const PAGE_TEXT_FALLBACK_ASCENT_RATIO = 0.8;
export const PAGE_TEXT_FALLBACK_DESCENT_RATIO = 0.2;

/** 新建元素的默认尺寸/位置偏移 */
export const PAGE_NEW_COLORBAR_WIDTH_PT = 14;
export const PAGE_NEW_COLORBAR_HEIGHT_PT = 160;
export const PAGE_NEW_LEGEND_WIDTH_PT = 172.2;
export const PAGE_NEW_LEGEND_HEIGHT_PT = 120;
