/**
 * 出版排版编辑器(map.html)的常量与默认值.
 *
 * 是什么:单文件地图文档 `<stem>.geo.json`(format `mapdoc-geo`)与成品 SVG 内嵌可编辑源
 * (format `mapdoc-final-source`)的格式标识,上传/下载参数,纸张预设,页边距默认值,默认排版
 * 间距/字号/图框/图例/色标参数,校验上下限与交互缩放系数.
 * 为什么集中在这里:预览(浏览器 DOM)与成品(浏览器内 `render/compose-svg.ts`)必须共享同一套
 * 默认值;把它们放在 config 层,core/render/ui/app 只读不写,避免「预览与成品标定不一致」.
 * 数字口径:`page` 块与内部排版**只有一个坐标系**--纸张坐标,单位 mm,原点 = 纸张左上角,
 * x 向右, y 向下;写进 SVG 时最多 3 位小数,去尾零(见 `render/page-format.ts` 与
 * `docs/PAGE-EDITOR.md` §5).geo 块(只读输入)仍沿用 Cartopy 契约的 pt / viewBox 坐标,
 * 只在打开时换算一次.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import { FONT_FAMILY_STACK } from './fonts';

/* ---------------- 文档标识 ---------------- */

/**
 * geo.json 的格式标识:Cartopy 直出的地理块与编辑器导出的单文件文档共用同一个 format.
 * 为什么不再有独立的 `mapdoc-page`:排版是同一份文件的 `page` 块(见 core/page.ts),
 * 文件身份只有这一处,避免「两份 JSON 谁是真值」的歧义.
 */
export const PAGE_GEO_FORMAT = 'mapdoc-geo';

/**
 * 版本:必须精确匹配.geo v2 的 `labels[]` 只含 role/text/位置/锚点/字号,
 * 样式由 `config/text-style.ts` 决定;旧 v1 产物直接拒绝(提示用更新的 Cartopy 重新生成).
 * 排版块仍是同一份文档里的可选 `page` 键,不参与 geo 版本号.
 */
export const PAGE_GEO_VERSION = 2;

/**
 * 成品 SVG 内嵌可编辑源的格式标识(`<metadata id="mapdoc-source">`)与版本.
 * 为什么单独一个 format:内嵌的是「导出时的整份 geo.json 原文 + 底图前后缀」,
 * 与 geo.json 自身(mapdoc-geo)是两种载荷,必须能分别识别版本,分别拒绝坏数据.
 */
export const PAGE_FINAL_SOURCE_FORMAT = 'mapdoc-final-source';
export const PAGE_FINAL_SOURCE_VERSION = 1;

/** 成品 SVG 尾部 marker(`<!-- mapdoc-final:... -->`)的版本;v2 起排版摘要键名是 `page` */
export const PAGE_FINAL_MARKER_VERSION = 2;

/* ---------------- 上传与下载(文件 I/O,无后端) ---------------- */

/**
 * 底图 SVG 选择框的 accept(SVG 与 JSON 是两个独立选择框,见 `ui/page-open.ts`).
 * 只看扩展名即可:内容格式由 `core/document.ts` 按 `format` 字段再判一次.
 */
export const PAGE_UPLOAD_SVG_ACCEPT = '.svg,image/svg+xml';

/**
 * JSON 选择框的 accept:只接受 geo.json(单文件,内含可选 page 排版块).
 * 扩展名只用于分栏与快速分桶,JSON 内容的 `format` 才是真值(`core/document.ts`).
 */
export const PAGE_UPLOAD_JSON_ACCEPT = '.json,application/json';

/** 导出下载用 Blob objectURL 的延迟 revoke(毫秒):给浏览器留出读取下载数据的时间 */
export const PAGE_DOWNLOAD_REVOKE_MS = 1000;

/**
 * 打开校验的尺寸容差(pt):`geo.base` 的 viewBox/width/height 与底图根标签的对应值比较时
 * 允许的最大偏差.这是 geo 契约(Cartopy 侧)的口径,不随 page 块的 mm 改动.
 */
export const PAGE_BASE_SIZE_TOLERANCE_PT = 0.01;

/* ---------------- 数值口径与上限(契约 §4) ---------------- */

/** 落盘/输出的小数位(mm) */
export const PAGE_DECIMALS = 3;

/** 一页最多元素数 */
export const PAGE_MAX_ITEMS = 500;

/** 纸张宽高允许范围(mm) */
export const PAGE_PAPER_MIN_MM = 20;
export const PAGE_PAPER_MAX_MM = 2000;

/** 地图宽度必须严格大于它(mm) */
export const PAGE_MIN_MAP_WIDTH_MM = 1;

/** 单条文字元素的行数与每行字符数上限 */
export const PAGE_MAX_TEXT_LINES = 40;
export const PAGE_MAX_TEXT_LINE_CHARS = 200;

/* ---------------- 纸张预设 ---------------- */

/** 预设 id;`Custom` 表示自定义尺寸(只记忆在 paper.preset 里) */
export type PaperPresetId = 'A5' | 'A4' | 'A3' | 'Letter' | 'Custom';

/** 纸张方向;landscape 交换宽高 */
export type PaperOrientation = 'portrait' | 'landscape';

export interface PaperPreset {
  readonly id: Exclude<PaperPresetId, 'Custom'>;
  readonly label: string;
  /** 纵向宽(mm) */
  readonly width_mm: number;
  /** 纵向高(mm) */
  readonly height_mm: number;
}

/**
 * 纸张预设(纵向尺寸,单位 mm).
 * 为什么用 mm:mm 是出版/印刷的纸面标准单位,ISO A 系列与 Letter 的标称值本身就是 mm
 * (A4 = 210×297mm,Letter = 215.9×279.4mm);预览与成品都按同一组 mm 排版.
 * 为什么不再从 pt 反算:A4 的 pt 值(595.275591×841.889764)是 mm 换算出来的中间量,
 * 直接写 mm 少一次舍入,落盘数字也更可读.
 */
export const PAGE_PAPER_PRESETS: readonly PaperPreset[] = [
  { id: 'A5', label: 'A5', width_mm: 148, height_mm: 210 },
  { id: 'A4', label: 'A4', width_mm: 210, height_mm: 297 },
  { id: 'A3', label: 'A3', width_mm: 297, height_mm: 420 },
  { id: 'Letter', label: 'Letter', width_mm: 215.9, height_mm: 279.4 },
];

/** 按 id 查预设;`Custom` 或未知 id 返回 null */
export function findPaperPreset(id: string): PaperPreset | null {
  return PAGE_PAPER_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** 预设 + 方向 -> 页面宽高(mm);方向为 landscape 时交换 */
export function presetSize(
  preset: PaperPreset,
  orientation: PaperOrientation,
): { width_mm: number; height_mm: number } {
  return orientation === 'landscape'
    ? { width_mm: preset.height_mm, height_mm: preset.width_mm }
    : { width_mm: preset.width_mm, height_mm: preset.height_mm };
}

/** 默认纸张宽高:A4 横向(mm,契约 §9) */
export const PAGE_DEFAULT_PAPER_WIDTH_MM = 297;
export const PAGE_DEFAULT_PAPER_HEIGHT_MM = 210;

/* ---------------- 页边距 ---------------- */

/**
 * 页边距默认值(mm,四边相同):0 = 不设内边距,内容框与纸张等大.
 * 为什么默认 0:页边距是「出版时按刊物版面自己定」的参数,默认值不该假装成某个刊物的
 * 版心;`defaultPageLayout` 的初始版式自带内缩常量(见下一节),用户设了边距后画布会高亮
 * 内容框,便于把内容挪进版心.
 */
export const PAGE_DEFAULT_MARGIN_MM = 0;

/* ---------------- 默认排版(defaultPageLayout 用) ---------------- */

/**
 * 初始版式的左/下内缩(mm):只在 `defaultPageLayout` 生成初始排版时使用,不是页边距.
 * 为什么和页边距分开:页边距是用户在「页面」面板里改的版心参考,初始版式则是打开时的
 * 一次性起点;两者混用会让「改边距」看起来像「重新排版」,而本项目明确不做自动重排.
 */
export const PAGE_DEFAULT_INSET_MM = 10;

/** 地图顶部起始 y(mm):给标题/副标题留出的高度 */
export const PAGE_DEFAULT_MAP_TOP_MM = 25.5;

/** 地图与右栏之间的间距(mm) */
export const PAGE_DEFAULT_COLUMN_GAP_MM = 5.6;

/** 右栏(图例/注记/色标)最小/最大宽度(mm) */
export const PAGE_DEFAULT_RIGHT_COLUMN_MIN_MM = 53;
export const PAGE_DEFAULT_RIGHT_COLUMN_MAX_MM = 92;

/** 页面底部给「来源」一行预留的高度(mm,含与地图的间隔) */
export const PAGE_SOURCE_RESERVED_MM = 8.5;

/** 默认字号(mm) */
export const PAGE_TITLE_SIZE_MM = 6.35;
export const PAGE_SUBTITLE_SIZE_MM = 3.175;
export const PAGE_NOTE_SIZE_MM = 2.646;
export const PAGE_SOURCE_SIZE_MM = 2.469;

/**
 * 标题/副标题首行基线的纸张坐标(mm,从纸张上边缘量起,不再相对页边距).
 * 为什么用绝对坐标:全项目只有纸张坐标系,标题位置就是页面上的一个 y,没有第二套原点;
 * 页边距只画内容框参考,不参与排版计算.
 */
export const PAGE_TITLE_BASELINE_MM = 15.2;
export const PAGE_SUBTITLE_BASELINE_MM = 21.2;

/** 注记首行与图例底部的间距(mm) */
export const PAGE_NOTES_GAP_MM = 4.2;

/**
 * 自动折行(注记/来源)的宽度下限(mm).
 * 为什么有下限:折行宽度接近 0 时每行只能放一个字符,行数迅速撞上 `PAGE_MAX_TEXT_LINES`
 * 并被截断;统一夹到 7mm 既保证可读,也让同一条 item 在「编辑 / 打开 / 导出」三段里
 * 用同一个宽度复现折行结果(幂等).
 */
export const PAGE_AUTO_WRAP_MIN_MM = 7;

/** 色标默认尺寸与与注记的间距(mm) */
export const PAGE_COLORBAR_WIDTH_MM = 5;
export const PAGE_COLORBAR_HEIGHT_MM = 63.5;
export const PAGE_COLORBAR_GAP_MM = 6.5;

/**
 * 排版自适应比例 k 的上下限(相对 A4 横向):小纸张(A5)把图例/色标与版式间距整体缩小,
 * 大纸张(A3)整体放大;0.62/1.6 之外不再继续缩/放,避免图例不可读或版面失衡.
 * 页面文字(标题/副标题/注记/来源)字号是固定值,不受 k 影响.
 */
export const PAGE_LAYOUT_SCALE_MIN = 0.62;
export const PAGE_LAYOUT_SCALE_MAX = 1.6;

/**
 * 纸张自适应比例 k(相对 A4 纸面):A4/A3/Letter/A5 共用同一套版式公式.
 *
 * 用「长边 / 短边」分别对照 A4 的长边/短边,而不是直接拿 width/height 对 A4 横向:
 * 这样 A4 横向与 A4 纵向都得到 k=1(同一张纸换个方向,图例/间距不该变),A5 两个方向都是
 * ≈0.705,A3 两个方向都是 ≈1.414.夹在 0.62..1.6,避免图例不可读或版面失衡.
 * 为什么需要:A5 只有 A4 的 70% 线性尺寸,图例/色标/间距不缩会把右栏(或纵向的下方一排)
 * 挤出纸面并互相重叠.
 * 为什么放在 config 而不是 core/page-layout:默认排版(core/page-layout)与图例/色标公式
 * 都要用同一口径,放在 config 才不会形成 core 内部的运行期环.
 * 页面文字字号不乘 k(固定默认值,见 config/text-style.ts).
 */
export function layoutScaleForPaper(widthMm: number, heightMm: number): number {
  const paperLong = Math.max(widthMm, heightMm);
  const paperShort = Math.min(widthMm, heightMm);
  const a4Long = Math.max(PAGE_DEFAULT_PAPER_WIDTH_MM, PAGE_DEFAULT_PAPER_HEIGHT_MM);
  const a4Short = Math.min(PAGE_DEFAULT_PAPER_WIDTH_MM, PAGE_DEFAULT_PAPER_HEIGHT_MM);
  const ratio = Math.min(paperLong / a4Long, paperShort / a4Short);
  return Math.min(PAGE_LAYOUT_SCALE_MAX, Math.max(PAGE_LAYOUT_SCALE_MIN, ratio));
}

/** 色标在默认排版里的最小高度(mm):再小就压成一条线,不如与注记留 3mm 后贴底 */
export const PAGE_MIN_COLORBAR_HEIGHT_MM = 14;

/* ---------------- 默认样式(page.style / page.frame) ---------------- */

/**
 * 页面默认字体栈 = 全项目字体栈(`config/fonts.ts` 的 `FONT_FAMILY_STACK` 唯一真源).
 * 为什么这里还导出一个名字:页面文档的字段叫 `style.font_family`,渲染/默认排版读的是
 * 页面级语义;值本身不复制(不写第二份字面量),改字体只开 `config/fonts.ts`.
 * 字体不内嵌(契约 §11 已知限制,v2 仍未做),跨机器靠本机同名/兜底字体.
 */
export const PAGE_DEFAULT_FONT_FAMILY = FONT_FAMILY_STACK;

export const PAGE_DEFAULT_PAPER_COLOR = '#ffffff';
export const PAGE_DEFAULT_TEXT_COLOR = '#111111';

/** 图框默认值(契约 §4 frame) */
export const PAGE_FRAME_DEFAULTS = {
  show: true,
  stroke: '#000000',
  width_mm: 0.3,
  ticks: true,
  tick_length_mm: 1.8,
  tick_font_size_mm: 2.5,
  tick_color: '#444444',
  tick_gap_mm: 0.7,
} as const;

/** 图例默认值(契约 §5.4 参数) */
export const PAGE_LEGEND_DEFAULTS = {
  font_size_mm: 3.2,
  title_size_mm: 4.2,
  row_height_mm: 4.9,
  padding_mm: 2.5,
  swatch_width_mm: 8.5,
  swatch_gap_mm: 2.1,
  frame_stroke: '#bbbbbb',
  frame_width_mm: 0.3,
  frame_fill: '#ffffff',
  frame_opacity: 0.94,
} as const;

/** 色标默认字号(mm,契约 §5.5) */
export const PAGE_COLORBAR_TITLE_SIZE_MM = 2.8;
export const PAGE_COLORBAR_LABEL_SIZE_MM = 2.5;

/** 色标刻度短线长度与标签间距(mm,契约 §5.5 的 1 / 1.8,写死公式里,不落 page) */
export const PAGE_COLORBAR_TICK_LENGTH_MM = 1;
export const PAGE_COLORBAR_LABEL_GAP_MM = 1.8;

/* ---------------- 预览交互 ---------------- */

/** 预览缩放下限(相对 1mm = 1 CSS px) */
export const PAGE_ZOOM_MIN = 0.05;
/** 预览缩放上限:再放大只会看到底图像素 */
export const PAGE_ZOOM_MAX = 16;
/** 滚轮缩放灵敏度:缩放因子 = exp(-deltaY × 该值) */
export const PAGE_WHEEL_ZOOM_SENSITIVITY = 0.0015;
/** 「适应页面」在纸张四周留出的比例 */
export const PAGE_FIT_PADDING_RATIO = 0.04;
/** 方向键微移步长(mm);Shift 加倍 */
export const PAGE_KEY_MOVE_MM = 0.5;
export const PAGE_KEY_MOVE_LARGE_MM = 5;

/**
 * 命中盒在 item 声明几何框外的容差(mm):只服务指针精度,不是视觉框的一部分.
 * 为什么单独一个量:选中框必须原样等于 item 的声明几何框(§5.7),容差只让细小的文字/
 * 图例更容易点中;把容差混进选中框,框就会变成没有依据的外扩装饰.
 */
export const PAGE_HIT_TOLERANCE_MM = 0.7;

/**
 * 无 canvas 时的字体行盒回退比例(相对字号):上伸 0.8em,下伸 0.2em.
 * 只在 node 单测/无 DOM 环境使用;浏览器路径取 canvas `fontBoundingBoxAscent/Descent`
 * (CSS font 的实测行盒),所以选中框/命中盒在浏览器里是字体度量值,不是常量.
 */
export const PAGE_TEXT_FALLBACK_ASCENT_RATIO = 0.8;
export const PAGE_TEXT_FALLBACK_DESCENT_RATIO = 0.2;

/** 新建元素的默认尺寸/位置偏移(mm) */
export const PAGE_NEW_COLORBAR_WIDTH_MM = 5;
export const PAGE_NEW_COLORBAR_HEIGHT_MM = 56.5;
export const PAGE_NEW_LEGEND_WIDTH_MM = 61;
