/**
 * 排版布局公式（`docs/PAGE-EDITOR.md` §5）与初始排版 `defaultPageLayout`。
 *
 * 是什么：底图坐标 → 纸张坐标的变换、图框/刻度位置、text/legend/colorbar 的基线/行位置、
 * 文字折行与文本宽度估算，以及「从 geo 生成默认 A4 横向排版」。
 * 为什么放在 core：预览（`render/page-svg.ts`）与成品合成（`render/compose-svg.ts`）
 * 必须逐字一致；这里只写纯函数，文本测量以参数注入（`MeasureText`），node 单测时用
 * 内置的无 DOM 估算回退，浏览器里注入 canvas measureText。
 * 已知口径：字符宽度估算按「CJK/全角 = 1em，其余 = 0.55em」；只服务没有测量器时的
 * 折行兜底，最终排版以注入的真实测量为准。文字样式（颜色/字重/字距/行高/描边）不在本文件，
 * 全部来自 `config/text-style.ts`；这里只做几何与换算。
 * 元信息：作者 frontend，2026-10-27，随 `docs/PAGE-EDITOR.md` 新契约落地；
 *         2026-10-29 geo v2：地名 y 改为「文字块垂直中心」，makeLabelItem 按固定比例换算回基线。
 */

import {
  PAGE_COLORBAR_GAP_PT,
  PAGE_COLORBAR_HEIGHT_PT,
  PAGE_COLORBAR_LABEL_GAP_PT,
  PAGE_COLORBAR_LABEL_SIZE_PT,
  PAGE_COLORBAR_TICK_LENGTH_PT,
  PAGE_COLORBAR_TITLE_SIZE_PT,
  PAGE_COLORBAR_WIDTH_PT,
  PAGE_DEFAULT_COLUMN_GAP_PT,
  PAGE_DEFAULT_FONT_FAMILY,
  PAGE_DEFAULT_MAP_TOP_PT,
  PAGE_DEFAULT_MARGIN_PT,
  PAGE_DEFAULT_PAPER_COLOR,
  PAGE_DEFAULT_PAPER_HEIGHT_PT,
  PAGE_DEFAULT_PAPER_WIDTH_PT,
  PAGE_DEFAULT_RIGHT_COLUMN_MAX_PT,
  PAGE_DEFAULT_RIGHT_COLUMN_MIN_PT,
  PAGE_DEFAULT_TEXT_COLOR,
  PAGE_FRAME_DEFAULTS,
  PAGE_LAYOUT_SCALE_MAX,
  PAGE_LAYOUT_SCALE_MIN,
  PAGE_LEGEND_DEFAULTS,
  PAGE_MAX_TEXT_LINE_CHARS,
  PAGE_MAX_TEXT_LINES,
  PAGE_MIN_COLORBAR_HEIGHT_PT,
  PAGE_MIN_MAP_WIDTH_PT,
  PAGE_NOTE_SIZE_PT,
  PAGE_NOTES_GAP_PT,
  PAGE_SOURCE_RESERVED_PT,
  PAGE_SOURCE_SIZE_PT,
  PAGE_SUBTITLE_BASELINE_OFFSET_PT,
  PAGE_SUBTITLE_SIZE_PT,
  PAGE_TEXT_FALLBACK_ASCENT_RATIO,
  PAGE_TEXT_FALLBACK_DESCENT_RATIO,
  PAGE_TITLE_BASELINE_OFFSET_PT,
  PAGE_TITLE_SIZE_PT,
} from '../config/page';
import { MAP_LABEL_ROLE_STYLES, MAP_LABEL_STYLE, PAGE_TEXT_STYLES } from '../config/text-style';
import type { MeasureText, TextMeasure } from './types';
import type {
  ColorbarItem,
  Geo,
  GeoLabel,
  GeoLegendEntry,
  GeoRelief,
  GraticuleSide,
  Halo,
  ItemSpace,
  LegendEntry,
  LegendItem,
  MapPlacement,
  PageFrame,
  PageItem,
  PagePaper,
  PageStyle,
  PageLayout,
  TextAnchor,
  TextItem,
  TextRole,
} from './page';

/* =========================== 底图 → 纸张（§5.1） =========================== */

/** 底图坐标 → 纸张坐标的仿射参数：page = (tx + x*s, ty + y*s) */
export interface PageTransform {
  readonly s: number;
  readonly tx: number;
  readonly ty: number;
}

/** 地图像素比：map.height = map.width_pt × base.height_pt / base.width_pt */
export function mapHeightPt(geo: Geo, map: MapPlacement): number {
  return (map.width_pt * geo.base.height_pt) / geo.base.width_pt;
}

/** §5.1：s = map.width / base.width；tx/ty 让 map.x/y 对齐到 viewBox 左上角 */
export function mapTransform(geo: Geo, map: MapPlacement): PageTransform {
  const s = map.width_pt / geo.base.width_pt;
  const [viewX = 0, viewY = 0] = geo.base.view_box;
  return { s, tx: map.x - viewX * s, ty: map.y - viewY * s };
}

/** 底图坐标点 → 纸张坐标点 */
export function mapPointToPage(
  transform: PageTransform,
  point: { readonly x: number; readonly y: number },
): { x: number; y: number } {
  return { x: transform.tx + point.x * transform.s, y: transform.ty + point.y * transform.s };
}

/** 纸张坐标点 → 底图坐标点（拖拽写回 map 空间 item 用） */
export function pagePointToMap(
  transform: PageTransform,
  point: { readonly x: number; readonly y: number },
): { x: number; y: number } {
  return {
    x: (point.x - transform.tx) / transform.s,
    y: (point.y - transform.ty) / transform.s,
  };
}

/* =========================== 文本测量 =========================== */

/**
 * 字体简写：canvas 的 `ctx.font` 与无 DOM 估算器共用同一口径。
 * 为什么 weight 为 400 时省略字重：保持旧串 `"12px family"` 的格式，未改字重的既有写法
 * （canvas 测量、字体串快照）不产生无意义差异；非 400 才写成 `"700 12px family"`（CSS font 语法）。
 */
export function fontShorthand(sizePt: number, fontFamily: string, weight = 400): string {
  const size = Math.max(0, sizePt);
  return weight === 400 ? `${size}px ${fontFamily}` : `${weight} ${size}px ${fontFamily}`;
}

/**
 * 从字体简写里取字号；解析失败回退 12px（与 render/theme 的回退字号一致）。
 * 为什么用正则找 `px` 而不是 `parseFloat`：非 400 字重的简写以数字开头（如 `"700 12px …"`），
 * `parseFloat` 会把字重 700 当成字号；这里只认 `<数字>px` 那一段。
 */
function fontSizeOf(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  const parsed = match === null ? Number.NaN : Number.parseFloat(match[1] ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
}

/** 全角/CJK 判定：按 Unicode 区段粗分，够折行用即可 */
function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK 部首/标点
    (code >= 0x3041 && code <= 0x33ff) || // 假名/注音/CJK 兼容
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意
    (code >= 0xa000 && code <= 0xa4cf) || // 彝文
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul 音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/**
 * 无 DOM 的文本宽度估算：CJK/全角按 1em，其余按 0.55em。
 * 为什么不是 0.5em：等宽字体里数字/字母约 0.55~0.6em，取中位数让折行偏保守。
 */
export function estimateTextWidth(text: string, font: string): number {
  const size = fontSizeOf(font);
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += isWideCodePoint(code) ? size : size * 0.55;
  }
  return width;
}

/** 没有注入测量器时使用的默认测量（导出给单测与侧栏估算用） */
export const fallbackMeasureText: MeasureText = (text, font) => estimateTextWidth(text, font);

/**
 * 没有注入测量器时的行盒回退：按 config 的 0.8em / 0.2em 比例（相对字号）。
 * 只有 node 单测与无 canvas 环境会走到；浏览器用 canvas `fontBoundingBox*` 实测字体行盒。
 */
export const fallbackTextMeasure: TextMeasure = {
  width: fallbackMeasureText,
  ascent: (font) => fontSizeOf(font) * PAGE_TEXT_FALLBACK_ASCENT_RATIO,
  descent: (font) => fontSizeOf(font) * PAGE_TEXT_FALLBACK_DESCENT_RATIO,
};

/** 逐词切分：CJK 单字成词，拉丁词按空格断；空白串单独保留（折行时用来定位断点） */
function tokenizeForWrap(text: string): string[] {
  const tokens: string[] = [];
  let buffer = '';
  let bufferIsSpace = false;
  const flush = (): void => {
    if (buffer.length > 0) tokens.push(buffer);
    buffer = '';
  };
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const space = char === ' ' || char === '\t';
    if (isWideCodePoint(code)) {
      flush();
      tokens.push(char);
      bufferIsSpace = false;
      continue;
    }
    if (space !== bufferIsSpace) {
      flush();
      bufferIsSpace = space;
    }
    buffer += char;
  }
  flush();
  return tokens;
}

/**
 * 按最大宽度折行（不做自动换行：结果要写进 `lines` 数组，契约 §11）。
 * 返回至少一行；超长单词按字符硬切，避免一行溢出右栏。
 */
export function wrapText(
  text: string,
  font: string,
  maxWidth: number,
  measure: MeasureText = fallbackMeasureText,
): string[] {
  if (text.length === 0) return [''];
  if (!(maxWidth > 0)) return [text];
  const lines: string[] = [];

  /**
   * 超长单词（无空格长串）按字符硬切：返回已落定的行与剩余片段。
   * 单独成函数是为了「token 位于行首」与「上一行已满后才遇到超长 token」两条路径共用。
   */
  const splitLongToken = (token: string): { lines: string[]; rest: string } => {
    const produced: string[] = [];
    let chunk = '';
    for (const char of token) {
      if (chunk.length > 0 && measure(chunk + char, font) > maxWidth) {
        produced.push(chunk);
        chunk = char;
      } else {
        chunk += char;
      }
    }
    return { lines: produced, rest: chunk };
  };

  let current = '';
  for (const token of tokenizeForWrap(text)) {
    const spaceOnly = token.trim().length === 0;
    if (spaceOnly) {
      // 行首空白吞掉；行内空白保留（后续 token 会触发断行）
      if (current.length > 0) current += token;
      continue;
    }
    const candidate = current + token;
    if (measure(candidate, font) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current.trimEnd());
    if (measure(token, font) <= maxWidth) {
      current = token;
      continue;
    }
    const split = splitLongToken(token);
    lines.push(...split.lines);
    current = split.rest;
  }
  if (current.length > 0 || lines.length === 0) lines.push(current.trimEnd());
  return lines;
}

/** 多段文字（每段可含换行）折行后压平；行数与每行长度按契约上限截断 */
export function wrapParagraphs(
  paragraphs: readonly string[],
  font: string,
  maxWidth: number,
  measure: MeasureText = fallbackMeasureText,
): string[] {
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    for (const rawLine of paragraph.split('\n')) {
      const wrapped = wrapText(rawLine, font, maxWidth, measure);
      lines.push(...wrapped);
    }
  }
  if (lines.length === 0) return [''];
  const limited = lines.slice(0, PAGE_MAX_TEXT_LINES).map((line) => {
    const text =
      line.length > PAGE_MAX_TEXT_LINE_CHARS ? line.slice(0, PAGE_MAX_TEXT_LINE_CHARS) : line;
    return text;
  });
  if (lines.length > PAGE_MAX_TEXT_LINES) {
    const lastIndex = limited.length - 1;
    const last = limited[lastIndex] ?? '';
    limited[lastIndex] = `${last.slice(0, Math.max(0, PAGE_MAX_TEXT_LINE_CHARS - 1))}…`;
  }
  return limited;
}

/**
 * 文字块宽度（多行取最宽）：选中框/命中盒与导出越界估算共用。
 * `fontFamily` 是 `item.font_family` 为空时的回退字体（调用方传 `layout.style.font_family`，
 * 与 §5.3 渲染同一口径）；缺省用默认字体栈，只服务没有 layout 的独立调用。
 * 字距按 SVG/CSS 的前进宽度口径加在每行末尾：`letter_spacing_em × 字号 × max(0, 字符数-1)`
 * （最后一个字符后面不再算字距，与「文字块宽度」的视觉边界一致）。
 */
export function textBlockWidth(
  item: TextItem,
  measure: MeasureText = fallbackMeasureText,
  fontFamily: string = PAGE_DEFAULT_FONT_FAMILY,
): number {
  const font = fontShorthand(item.font_size_pt, item.font_family ?? fontFamily, item.font_weight);
  const spacing = item.letter_spacing_em * item.font_size_pt;
  let width = 0;
  for (const line of item.lines) {
    const chars = [...line].length;
    const advance = measure(line, font) + spacing * Math.max(0, chars - 1);
    width = Math.max(width, advance);
  }
  return width;
}

/* =========================== 文字布局（§5.3） =========================== */

export interface TextLineLayout {
  readonly text: string;
  /** 行基线 y（纸张坐标） */
  readonly y: number;
}

export interface TextLayout {
  /** 第一行锚点（纸张坐标） */
  readonly px: number;
  readonly py: number;
  /** 每行偏移（已含 line_height） */
  readonly lines: readonly TextLineLayout[];
}

/** 文本起始点：page 空间直接用；map 空间过 §5.1（字号不随地图缩放，契约 §5.3） */
export function textLayout(item: TextItem, geo: Geo, layout: PageLayout): TextLayout {
  const transform = mapTransform(geo, layout.map);
  const origin = item.space === 'map' ? mapPointToPage(transform, item) : { x: item.x, y: item.y };
  const step = item.font_size_pt * item.line_height;
  const lines = item.lines.map((text, index) => ({ text, y: origin.y + index * step }));
  return { px: origin.x, py: origin.y, lines };
}

/* =========================== 图框/刻度（§5.2） =========================== */

/** 一条刻度的几何：线端点 + 标签锚点/基线（全部已换算成纸张坐标） */
export interface FrameTickLayout {
  readonly axis: 'lon' | 'lat';
  readonly side: GraticuleSide;
  readonly label: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly textX: number;
  readonly textY: number;
  readonly anchor: TextAnchor;
}

/**
 * §5.2 图框刻度几何。
 * - 经度：page(tick.x).x 落在 [0, paper.width] 才画；bottom 向下、top 向上；
 * - 纬度：page(tick.y).y 落在 [0, paper.height] 才画；left 向左、right 向右。
 * 基线公式按契约原样（bottom 用 tick_gap + tick_font_size，left 用 font*0.35）。
 */
export function frameTickLayout(layout: PageLayout, geo: Geo): FrameTickLayout[] {
  const { paper, map, frame } = layout;
  const transform = mapTransform(geo, map);
  const height = mapHeightPt(geo, map);
  const mapBottom = map.y + height;
  const mapRight = map.x + map.width_pt;
  const result: FrameTickLayout[] = [];

  for (const tick of geo.graticule.lon) {
    const px = transform.tx + tick.x * transform.s;
    if (px < 0 || px > paper.width_pt) continue;
    const side: GraticuleSide = tick.side === 'top' ? 'top' : 'bottom';
    if (side === 'bottom') {
      result.push({
        axis: 'lon',
        side,
        label: tick.label,
        x1: px,
        y1: mapBottom,
        x2: px,
        y2: mapBottom + frame.tick_length_pt,
        textX: px,
        textY: mapBottom + frame.tick_length_pt + frame.tick_gap_pt + frame.tick_font_size_pt,
        anchor: 'middle',
      });
    } else {
      result.push({
        axis: 'lon',
        side,
        label: tick.label,
        x1: px,
        y1: map.y,
        x2: px,
        y2: map.y - frame.tick_length_pt,
        textX: px,
        textY: map.y - frame.tick_length_pt - frame.tick_gap_pt,
        anchor: 'middle',
      });
    }
  }

  for (const tick of geo.graticule.lat) {
    const py = transform.ty + tick.y * transform.s;
    if (py < 0 || py > paper.height_pt) continue;
    const side: GraticuleSide = tick.side === 'right' ? 'right' : 'left';
    if (side === 'left') {
      result.push({
        axis: 'lat',
        side,
        label: tick.label,
        x1: map.x,
        y1: py,
        x2: map.x - frame.tick_length_pt,
        y2: py,
        textX: map.x - frame.tick_length_pt - frame.tick_gap_pt,
        textY: py + frame.tick_font_size_pt * 0.35,
        anchor: 'end',
      });
    } else {
      result.push({
        axis: 'lat',
        side,
        label: tick.label,
        x1: mapRight,
        y1: py,
        x2: mapRight + frame.tick_length_pt,
        y2: py,
        textX: mapRight + frame.tick_length_pt + frame.tick_gap_pt,
        textY: py + frame.tick_font_size_pt * 0.35,
        anchor: 'start',
      });
    }
  }

  return result;
}

/* =========================== 图例布局（§5.4） =========================== */

export interface LegendRowLayout {
  /** 行中心线 y（纸张坐标） */
  readonly centerY: number;
  readonly swatchX0: number;
  readonly swatchX1: number;
  readonly labelX: number;
  readonly labelBaseline: number;
}

export interface LegendLayout {
  /** 由内容派生的高度（不落 layout） */
  readonly height: number;
  readonly titleBaseline: number;
  /** 标题水平中心（契约未写，预览与成品统一取宽度中点） */
  readonly titleX: number;
  readonly rows: readonly LegendRowLayout[];
}

/**
 * §5.4 图例布局。
 * @param sizeScale 仅 map 空间的图例用：契约未定义，成品合成把 width_pt 乘 s，
 *                  这里同样只缩放宽度（行高/字号保持 pt），保持预览与成品口径一致。
 */
export function legendLayout(item: LegendItem, sizeScale = 1): LegendLayout {
  const padding = item.padding_pt;
  const width = item.width_pt * sizeScale;
  const rowHeight = Math.max(item.row_height_pt, item.font_size_pt * 1.5);
  const titleHeight = item.title.length > 0 ? item.title_size_pt * 1.4 : 0;
  const height = padding * 2 + titleHeight + item.entries.length * rowHeight;
  const rows: LegendRowLayout[] = item.entries.map((_entry, index) => {
    const centerY = item.y + padding + titleHeight + rowHeight * (index + 0.5);
    const swatchX0 = item.x + padding;
    const swatchX1 = swatchX0 + item.swatch_width_pt;
    return {
      centerY,
      swatchX0,
      swatchX1,
      labelX: swatchX1 + item.swatch_gap_pt,
      labelBaseline: centerY + item.font_size_pt * 0.35,
    };
  });
  return {
    height,
    titleBaseline: item.y + padding + item.title_size_pt,
    titleX: item.x + width / 2,
    rows,
  };
}

/* =========================== 色标布局（§5.5） =========================== */

export interface ColorbarTickLayout {
  readonly value: number;
  readonly ty: number;
  readonly x1: number;
  readonly x2: number;
  readonly labelX: number;
  readonly labelBaseline: number;
}

export interface ColorbarLayout {
  readonly width: number;
  readonly height: number;
  readonly titleX: number;
  readonly titleBaseline: number;
  readonly titleText: string;
  readonly ticks: readonly ColorbarTickLayout[];
}

/** 色标标题：unit 非空且标题不含单位时追加 ` (unit)`（契约 §5.5） */
export function colorbarTitleText(item: ColorbarItem): string {
  const unit = item.unit.trim();
  if (unit.length === 0) return item.title;
  if (item.title.includes(unit)) return item.title;
  return `${item.title} (${unit})`;
}

/**
 * §5.5 色标布局。
 * @param sizeScale 仅 map 空间的色标用：宽度/高度乘 s（字号保持 pt，预览与成品一致）。
 */
export function colorbarLayout(
  item: ColorbarItem,
  relief: GeoRelief,
  sizeScale = 1,
): ColorbarLayout {
  const width = item.width_pt * sizeScale;
  const height = item.height_pt * sizeScale;
  const titleX = item.x + width / 2;
  const titleBaseline = item.y - 4;
  const ticks: ColorbarTickLayout[] = [];
  const span = relief.vmax - relief.vmin;
  if (item.show_ticks && Number.isFinite(span) && span !== 0) {
    for (const value of relief.ticks) {
      if (!Number.isFinite(value)) continue;
      const ty = item.y + height * (1 - (value - relief.vmin) / span);
      ticks.push({
        value,
        ty,
        x1: item.x + width,
        x2: item.x + width + PAGE_COLORBAR_TICK_LENGTH_PT,
        labelX: item.x + width + PAGE_COLORBAR_LABEL_GAP_PT,
        labelBaseline: ty + item.label_size_pt * 0.35,
      });
    }
  }
  return {
    width,
    height,
    titleX,
    titleBaseline,
    titleText: colorbarTitleText(item),
    ticks,
  };
}

/* =========================== item 几何框（§5.7，选中框/命中盒） =========================== */

/** 图例/色标在纸张坐标里的摆放；`scale` 只作用于图例/色标的尺寸（字号保持 pt） */
export interface ItemPlacement {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/**
 * 图例/色标的摆放公式（§5.4/§5.5 的共同入口）。
 * 为什么抽出来：预览（page-svg）、成品（compose）与选中框（itemBoundsPt）三处都需要同一份
 * 坐标换算；各写一份会漂移，契约 §5 也要求几何只在 page-layout 实现一次。
 */
export function itemPlacement(
  item: { readonly x: number; readonly y: number; readonly space: ItemSpace },
  layout: PageLayout,
  geo: Geo,
): ItemPlacement {
  if (item.space !== 'map') return { x: item.x, y: item.y, scale: 1 };
  const transform = mapTransform(geo, layout.map);
  const origin = mapPointToPage(transform, item);
  return { x: origin.x, y: origin.y, scale: transform.s };
}

/** item 在纸张坐标里的未旋转几何框 + 旋转参数（选中框与命中盒的唯一来源） */
export interface ItemBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 绕 (rotationX, rotationY) 旋转的度数；0 = 不旋转（legend/colorbar 恒为 0） */
  readonly rotation_deg: number;
  readonly rotationX: number;
  readonly rotationY: number;
}

/**
 * §5.7：item 的声明几何框（纸张坐标，未旋转）。
 *
 * - text：水平 = 锚点 + 各行前进宽度（measureText，字体来自 CSS font 简写）；
 *   垂直 = 首行基线 − ascent .. 末行基线 + descent（ascent/descent 是 CSS font 的行盒度量）；
 *   旋转 = §5.3 规定的 `rotate(rotation_deg px py)`；
 * - legend：`rect(x, y, width_pt*s, legendLayout().height)`（§5.4 的声明框）；
 * - colorbar：`rect(x, y, width_pt*s, height_pt*s)`（§5.5 的声明框）。
 *
 * 为什么不用 DOM `getBBox()`：它不含元素自身的 transform（旋转文字会画在锚点附近而错位），
 * 还会把透明命中盒算进包围盒（框因此变成外扩容差）；这里是纯函数，公式来自 §5，
 * 单测可断言，且预览/导出/选中框用同一批函数。
 */
export function itemBoundsPt(
  item: PageItem,
  layout: PageLayout,
  geo: Geo,
  measure: TextMeasure = fallbackTextMeasure,
): ItemBounds {
  switch (item.kind) {
    case 'text': {
      const text = textLayout(item, geo, layout);
      const font = fontShorthand(
        item.font_size_pt,
        item.font_family ?? layout.style.font_family,
        item.font_weight,
      );
      const width = textBlockWidth(item, measure.width, layout.style.font_family);
      const step = item.font_size_pt * item.line_height;
      const top = text.py - measure.ascent(font);
      const bottom = text.py + (item.lines.length - 1) * step + measure.descent(font);
      const left =
        item.anchor === 'start'
          ? text.px
          : item.anchor === 'end'
            ? text.px - width
            : text.px - width / 2;
      return {
        x: left,
        y: top,
        width,
        height: bottom - top,
        rotation_deg: item.rotation_deg,
        rotationX: text.px,
        rotationY: text.py,
      };
    }
    case 'legend': {
      const placement = itemPlacement(item, layout, geo);
      const effective: LegendItem = { ...item, x: placement.x, y: placement.y };
      const legend = legendLayout(effective, placement.scale);
      return {
        x: placement.x,
        y: placement.y,
        width: item.width_pt * placement.scale,
        height: legend.height,
        rotation_deg: 0,
        rotationX: placement.x,
        rotationY: placement.y,
      };
    }
    case 'colorbar': {
      const placement = itemPlacement(item, layout, geo);
      return {
        x: placement.x,
        y: placement.y,
        width: item.width_pt * placement.scale,
        height: item.height_pt * placement.scale,
        rotation_deg: 0,
        rotationX: placement.x,
        rotationY: placement.y,
      };
    }
  }
}

/* =========================== 默认排版 =========================== */

export interface DefaultPageLayoutOptions {
  /** 页边距（「重新排默认版式」可改） */
  readonly margin_pt?: number;
  /** 纸张（重新排版时保留用户当前纸张）；缺省 A4 横向 */
  readonly paper?: PagePaper;
  /** 文本测量器；缺省用无 DOM 估算 */
  readonly measureText?: MeasureText;
}

/** A4 横向的默认纸张 */
function defaultPaper(): PagePaper {
  return {
    preset: 'A4',
    orientation: 'landscape',
    width_pt: PAGE_DEFAULT_PAPER_WIDTH_PT,
    height_pt: PAGE_DEFAULT_PAPER_HEIGHT_PT,
  };
}

/**
 * 图例宽度测量：左右 padding + swatch + gap + 最长标签，同时要容得下标题。
 * @param fontScale 纸张自适应比例 k（defaultPageLayout 的 k）；图例的字号/色块/边距都随它缩放
 */
function measureLegendColumn(
  geo: Geo,
  style: PageStyle,
  measure: MeasureText,
  fontScale: number,
): number {
  const labelFont = fontShorthand(
    PAGE_LEGEND_DEFAULTS.font_size_pt * fontScale,
    style.font_family,
    PAGE_TEXT_STYLES.annotation.font_weight,
  );
  const titleFont = fontShorthand(
    PAGE_LEGEND_DEFAULTS.title_size_pt * fontScale,
    style.font_family,
    PAGE_TEXT_STYLES.annotation.font_weight,
  );
  let labelWidth = 0;
  for (const entry of geo.legend.entries) {
    labelWidth = Math.max(labelWidth, measure(entry.label, labelFont));
  }
  const title = geo.suggestions.legend_title || geo.legend.title || '图例';
  const entryWidth =
    PAGE_LEGEND_DEFAULTS.padding_pt * 2 * fontScale +
    PAGE_LEGEND_DEFAULTS.swatch_width_pt * fontScale +
    PAGE_LEGEND_DEFAULTS.swatch_gap_pt * fontScale +
    labelWidth;
  const titleWidth = PAGE_LEGEND_DEFAULTS.padding_pt * 2 * fontScale + measure(title, titleFont);
  return Math.max(entryWidth, titleWidth);
}

/**
 * 没有图例时的右栏宽度（pt）：只放注记/色标，不需要图例列那么宽。
 *
 * 为什么取 0.7 × 右栏最小宽：横向右栏最小宽是 150pt，只放色标（14pt）时右侧还要容纳
 * 3pt 刻度线 + 5pt 间距 + 数字标签，约 40pt 就够；取 105pt 既够放折行注记，又比图例列
 * 窄，让地图在高度允许时可以多占宽度。乘 k 与其它纸面尺寸同一口径。
 */
function compactRightColumnWidth(fontScale: number): number {
  return PAGE_DEFAULT_RIGHT_COLUMN_MIN_PT * 0.7 * fontScale;
}

/** 把 geo 图例条目复制成 layout 条目，补齐可选字段 */
function legendEntriesOf(geo: Geo): LegendEntry[] {
  return geo.legend.entries.map((entry: GeoLegendEntry) => ({
    label: entry.label,
    shape: entry.shape,
    stroke: entry.stroke,
    width_pt: entry.width_pt,
    dash: entry.dash === null ? null : [...entry.dash],
    fill: entry.fill,
    opacity: entry.opacity,
    marker: entry.marker,
  }));
}

/** 克隆光晕（避免 defaultPageLayout 与 geo 共享可变对象） */
function haloOf(halo: Halo | null): Halo | null {
  return halo === null ? null : { color: halo.color, width_pt: halo.width_pt };
}

/**
 * 文字元素工厂：所有可选字段都显式写出，保证 layout 形状固定。
 * 颜色/斜体/字重/字距/行高/光晕的默认值全部来自 `PAGE_TEXT_STYLES[role]`（单一真源）；
 * overrides 只用于调用方确有语义差异的字段（如锚点、坐标空间）。
 */
function makeTextItem(
  id: number,
  role: TextRole,
  x: number,
  y: number,
  lines: readonly string[],
  fontPt: number,
  overrides: Partial<
    Pick<
      TextItem,
      | 'anchor'
      | 'space'
      | 'color'
      | 'halo'
      | 'italic'
      | 'rotation_deg'
      | 'line_height'
      | 'font_weight'
      | 'letter_spacing_em'
    >
  > = {},
): TextItem {
  const style = PAGE_TEXT_STYLES[role];
  return {
    id,
    kind: 'text',
    space: overrides.space ?? 'page',
    role,
    x,
    y,
    lines: [...lines],
    font_size_pt: fontPt,
    font_family: null,
    color: overrides.color ?? style.color,
    anchor: overrides.anchor ?? 'middle',
    rotation_deg: overrides.rotation_deg ?? 0,
    line_height: overrides.line_height ?? style.line_height,
    italic: overrides.italic ?? style.italic,
    font_weight: overrides.font_weight ?? style.font_weight,
    letter_spacing_em: overrides.letter_spacing_em ?? style.letter_spacing_em,
    halo: haloOf(overrides.halo ?? style.halo),
  };
}

/**
 * geo v2 地名 → map 空间文字元素（把「文字块垂直中心」换算成第一行基线）。
 *
 * 输入约定：`label.y` 是文字块垂直中心（生成端不再算基线）；`label.x` 是水平锚点。
 * 换算公式（§4）：
 *   step        = size × line_height
 *   offsetPaper = baseline_ratio × size − (行数−1) × step / 2
 *   item.y      = label.y + offsetPaper / mapScale
 * 为什么这么换：旧实现把 `0.36*size - (n-1)*step/2` 直接烤进 map 坐标；v2 把同一偏移换成
 * 纸面 pt 再除以 mapScale 加回去，底图坐标 → 纸面后的视觉位置与旧图一致（多行统一 1.2 行高，
 * 整块中心最多 ≤1pt 位移，可接受）。
 * 字号/描边换算：geo 字号按原图 896pt 地图设计，放到 A4 左栏需乘地图缩放 s；字号夹到 4..40pt
 * 避免不可读；描边宽度是纸面常量（不随 s 缩放）。颜色/斜体/字重/字距/行高全部来自
 * `config/text-style.ts`。地名只跟地图缩放 s，不跟纸张自适应比例 k（两者语义不同）。
 * 生成端不再给旋转：`rotation_deg` 固定 0（编辑器里仍可旋转）。
 */
function makeLabelItem(id: number, label: GeoLabel, mapScale: number): TextItem {
  const lines = label.text
    .split('\n')
    .slice(0, PAGE_MAX_TEXT_LINES)
    .map((line) => line.slice(0, PAGE_MAX_TEXT_LINE_CHARS));
  const sourceSize = label.font_size_pt > 0 ? label.font_size_pt : 12;
  const scaledSize = Math.min(40, Math.max(4, sourceSize * mapScale));
  // 防御式回退：正常路径已由 validateGeo 保证 role 在枚举内，坏数据落到 area 也不崩。
  const roleStyle = MAP_LABEL_ROLE_STYLES[label.role] ?? MAP_LABEL_ROLE_STYLES.area;
  const step = scaledSize * MAP_LABEL_STYLE.line_height;
  const offsetPaper = MAP_LABEL_STYLE.baseline_ratio * scaledSize - ((lines.length - 1) * step) / 2;
  const scale = mapScale > 0 ? mapScale : 1;
  return {
    id,
    kind: 'text',
    space: 'map',
    role: 'label',
    x: label.x,
    y: label.y + offsetPaper / scale,
    lines,
    font_size_pt: scaledSize,
    font_family: null,
    color: roleStyle.color,
    anchor: label.anchor,
    rotation_deg: 0,
    line_height: MAP_LABEL_STYLE.line_height,
    italic: roleStyle.italic,
    font_weight: MAP_LABEL_STYLE.font_weight,
    letter_spacing_em: MAP_LABEL_STYLE.letter_spacing_em,
    halo: { color: MAP_LABEL_STYLE.halo_color, width_pt: MAP_LABEL_STYLE.halo_width_pt },
  };
}

/**
 * 纸张自适应比例 k（相对 A4 纸面）：A4/A3/Letter/A5 共用同一套版式公式。
 *
 * 用「长边 / 短边」分别对照 A4 的长边/短边，而不是直接拿 width/height 对 A4 横向：
 * 这样 A4 横向与 A4 纵向都得到 k=1（同一张纸换个方向，字号不该变），A5 两个方向都是
 * ≈0.705，A3 两个方向都是 ≈1.414。夹在 0.62..1.6，避免字号不可读或版面失衡。
 * 为什么需要：A5 只有 A4 的 70% 线性尺寸，字号/行高/间距不缩会把右栏（或纵向的下方一排）
 * 挤出纸面并互相重叠。
 */
function layoutScaleFor(paper: PagePaper): number {
  const paperLong = Math.max(paper.width_pt, paper.height_pt);
  const paperShort = Math.min(paper.width_pt, paper.height_pt);
  const a4Long = Math.max(PAGE_DEFAULT_PAPER_WIDTH_PT, PAGE_DEFAULT_PAPER_HEIGHT_PT);
  const a4Short = Math.min(PAGE_DEFAULT_PAPER_WIDTH_PT, PAGE_DEFAULT_PAPER_HEIGHT_PT);
  const ratio = Math.min(paperLong / a4Long, paperShort / a4Short);
  return Math.min(PAGE_LAYOUT_SCALE_MAX, Math.max(PAGE_LAYOUT_SCALE_MIN, ratio));
}

/**
 * 由 geo 生成初始排版（契约 §9：A4 横向默认、地图占左、右栏图例/注记/色标）。
 *
 * 两套版式：
 * - 横向（默认）：左地图 + 右栏（图例→注记→色标）；
 * - 纵向（`paper.height > paper.width * 1.05`）：整宽地图 + 下方一排（图例 / 注记 / 色标），
 *   避免竖版纸上地图只占半宽、下方大片空白。
 * 两套都按纸张自适应比例 k 缩放纸面字号与间距；地名只按地图缩放 s（见 makeLabelItem）。
 */
export function defaultPageLayout(geo: Geo, options: DefaultPageLayoutOptions = {}): PageLayout {
  const measure = options.measureText ?? fallbackMeasureText;
  const margin = options.margin_pt ?? PAGE_DEFAULT_MARGIN_PT;
  const paper = options.paper === undefined ? defaultPaper() : { ...options.paper };
  const style: PageStyle = {
    paper_color: PAGE_DEFAULT_PAPER_COLOR,
    font_family: PAGE_DEFAULT_FONT_FAMILY,
    color: PAGE_DEFAULT_TEXT_COLOR,
  };
  const frame: PageFrame = { ...PAGE_FRAME_DEFAULTS };
  const legendTitle = geo.suggestions.legend_title || geo.legend.title || '图例';

  /*
   * 可选块降级：Cartopy 不画图例 / 不画色标 / 没有默认文案时，这些块整体缺省。
   * 默认排版必须按「有哪些块」决定右栏（或纵向一排）存不存在，否则会留下空图例框、
   * 画出没有数据来源的色标，或者让地图白白让出宽度。
   */
  const relief = geo.relief;
  const hasLegend = geo.legend.entries.length > 0;
  const hasNotes = geo.suggestions.notes.some((note) => note.trim().length > 0);
  const hasColorbar = relief !== null;
  const hasRightColumn = hasLegend || hasNotes || hasColorbar;

  // 纸张自适应比例 k：所有「纸面元素」的字号/间距按它缩放（地名另有地图缩放 s）
  const k = layoutScaleFor(paper);
  const columnGap = PAGE_DEFAULT_COLUMN_GAP_PT * k;
  const sourceReserved = PAGE_SOURCE_RESERVED_PT * k;
  const titleArea = (PAGE_DEFAULT_MAP_TOP_PT - PAGE_DEFAULT_MARGIN_PT) * k;
  const notesGap = PAGE_NOTES_GAP_PT * k;
  const contentWidth = paper.width_pt - margin * 2;
  const mapTop = margin + titleArea;
  const baseRatio = geo.base.height_pt / geo.base.width_pt;
  // 竖版判定：高度超过宽度 1.05 倍（容忍近方形自定义纸仍走横向）
  const portrait = paper.height_pt > paper.width_pt * 1.05;

  // 图例最小宽度：先按文字测量，再按纸张比例夹到可读区间。
  // 横向沿用固定 150..260pt 区间（A5 横向已验证）；纵向随 k 收缩，避免小纸上图例占比过大。
  const measuredColumn = measureLegendColumn(geo, style, measure, k);
  const legendColumnMin = PAGE_DEFAULT_RIGHT_COLUMN_MIN_PT * (portrait ? k : 1);
  const legendColumnMax = PAGE_DEFAULT_RIGHT_COLUMN_MAX_PT * (portrait ? k : 1);
  const legendMinWidth = Math.min(legendColumnMax, Math.max(legendColumnMin, measuredColumn));

  /** 图例元素（两套版式共用同一套字号/色块/边框，只有摆放不同） */
  const makeLegendItem = (id: number, x: number, y: number, width: number): LegendItem => ({
    id,
    kind: 'legend',
    space: 'page',
    x,
    y,
    width_pt: width,
    title: legendTitle,
    entries: legendEntriesOf(geo),
    font_size_pt: PAGE_LEGEND_DEFAULTS.font_size_pt * k,
    title_size_pt: PAGE_LEGEND_DEFAULTS.title_size_pt * k,
    row_height_pt: PAGE_LEGEND_DEFAULTS.row_height_pt * k,
    padding_pt: PAGE_LEGEND_DEFAULTS.padding_pt * k,
    swatch_width_pt: PAGE_LEGEND_DEFAULTS.swatch_width_pt * k,
    swatch_gap_pt: PAGE_LEGEND_DEFAULTS.swatch_gap_pt * k,
    frame: {
      show: true,
      stroke: PAGE_LEGEND_DEFAULTS.frame_stroke,
      width_pt: PAGE_LEGEND_DEFAULTS.frame_width_pt * k,
      fill: PAGE_LEGEND_DEFAULTS.frame_fill,
      opacity: PAGE_LEGEND_DEFAULTS.frame_opacity,
    },
  });

  /** 色标元素（配色/刻度来自 geo.relief，只落摆放与字号；relief 已在外层判空） */
  const makeColorbarItem = (
    id: number,
    x: number,
    y: number,
    width: number,
    height: number,
    reliefData: GeoRelief,
  ): ColorbarItem => ({
    id,
    kind: 'colorbar',
    space: 'page',
    x,
    y,
    width_pt: width,
    height_pt: height,
    title: geo.suggestions.colorbar_title || reliefData.title || '色标',
    unit: reliefData.unit,
    show_title: true,
    show_ticks: true,
    title_size_pt: PAGE_COLORBAR_TITLE_SIZE_PT * k,
    label_size_pt: PAGE_COLORBAR_LABEL_SIZE_PT * k,
  });

  // 右栏预留宽度：有图例时沿用图例列宽（保持既有 demo 版式/数值），只有注记/色标时用窄列。
  const reservedRightWidth = hasRightColumn
    ? hasLegend
      ? legendMinWidth
      : compactRightColumnWidth(k)
    : 0;

  // 地图宽度：横向受右栏与高度双重约束；纵向用满内容宽度
  let mapWidth: number;
  if (portrait) {
    mapWidth = Math.max(PAGE_MIN_MAP_WIDTH_PT + 1, contentWidth);
  } else {
    const availableWidth =
      reservedRightWidth > 0 ? contentWidth - columnGap - reservedRightWidth : contentWidth;
    const availableHeight = paper.height_pt - margin - sourceReserved - mapTop;
    const widthByHeight = baseRatio > 0 ? availableHeight / baseRatio : availableWidth;
    mapWidth = Math.max(PAGE_MIN_MAP_WIDTH_PT + 1, Math.min(availableWidth, widthByHeight));
  }
  const mapHeight = baseRatio > 0 ? mapWidth * baseRatio : 0;

  let nextId = 1;
  const items: PageItem[] = [];

  // 1) 标题
  const titleY = margin + PAGE_TITLE_BASELINE_OFFSET_PT * k;
  if (geo.suggestions.title.length > 0) {
    items.push(
      makeTextItem(
        nextId++,
        'title',
        paper.width_pt / 2,
        titleY,
        [geo.suggestions.title],
        PAGE_TITLE_SIZE_PT * k,
      ),
    );
  }

  // 2) 副标题
  const subtitleY = margin + PAGE_SUBTITLE_BASELINE_OFFSET_PT * k;
  if (geo.suggestions.subtitle.length > 0) {
    items.push(
      makeTextItem(
        nextId++,
        'subtitle',
        paper.width_pt / 2,
        subtitleY,
        [geo.suggestions.subtitle],
        PAGE_SUBTITLE_SIZE_PT * k,
      ),
    );
  }

  if (portrait) {
    // 3P) 纵向：地图下方一排 = [图例 |] 注记 | [色标]（缺省块不占位、不留空框）
    // 地图底边不是内容底边：经度刻度标签占 mapBottom + tick_length + tick_gap + tick_font_size
    // （刻度字号是纸面字号、不随 k 缩），纵向一排必须让开这段高度。
    // 注意 notes 的首行基线 = rowY，但文字 group 的包围盒上沿还要再高约 0.9em：
    // 所以让位量按「刻度标签基线 + max(16k, 注记上沿+4)」算，保证注记上沿不压 "35°E…"。
    const noteSize = PAGE_NOTE_SIZE_PT * k;
    const tickLabelExtent = frame.ticks
      ? frame.tick_length_pt +
        frame.tick_gap_pt +
        frame.tick_font_size_pt +
        Math.max(16 * k, noteSize * 0.9 + 4)
      : 0;
    const rowY = mapTop + mapHeight + Math.max(notesGap, tickLabelExtent);
    // 图例不存在时不占列：注记从左边距开始，只有色标时仍贴右；间距按实际存在的列计。
    const legendWidth = hasLegend ? legendMinWidth : 0;
    const leadingGap = hasLegend ? columnGap : 0;
    const colorbarWidth = PAGE_COLORBAR_WIDTH_PT * k;
    const notesX = margin + legendWidth + leadingGap;
    const notesWidth = Math.max(
      40,
      contentWidth - legendWidth - leadingGap - (hasColorbar ? colorbarWidth + columnGap : 0),
    );
    const noteFont = fontShorthand(noteSize, style.font_family, PAGE_TEXT_STYLES.note.font_weight);
    const noteLines = wrapParagraphs(geo.suggestions.notes, noteFont, notesWidth, measure).filter(
      (line) => line.length > 0,
    );

    // 空图例不生成元素（也就没有空图例框）；有图例时高度仍由 §5.4 公式派生。
    let legendHeight = 0;
    if (hasLegend) {
      const legendItem = makeLegendItem(nextId++, margin, rowY, legendWidth);
      items.push(legendItem);
      legendHeight = legendLayout(legendItem).height;
    }

    let noteBlockHeight = 0;
    if (noteLines.length > 0) {
      items.push(
        makeTextItem(nextId++, 'note', notesX, rowY, noteLines, noteSize, {
          anchor: 'start',
          color: style.color,
        }),
      );
      noteBlockHeight = noteLines.length * noteSize * PAGE_TEXT_STYLES.note.line_height;
    }

    if (hasColorbar && relief !== null) {
      // 行高 = 图例/注记/色标三块内容的最大高度；色标底部与图例/注记底对齐。
      // 色标标题基线 = colorbarY - 4，必须落在 row 内：给标题预留 title_size*1.4 + 4，
      // 再只在剩余高度里放色条，避免标题画到地图底/经度标签上。
      const colorbarMaxHeight = PAGE_COLORBAR_HEIGHT_PT * k;
      const bottomLimit = paper.height_pt - margin - sourceReserved;
      const availableRow = Math.max(PAGE_MIN_COLORBAR_HEIGHT_PT, bottomLimit - rowY);
      const colorbarTitleBlock = PAGE_COLORBAR_TITLE_SIZE_PT * k * 1.4 + 4;
      let rowHeight = Math.max(
        legendHeight,
        noteBlockHeight,
        PAGE_MIN_COLORBAR_HEIGHT_PT + colorbarTitleBlock,
      );
      if (rowHeight > availableRow) rowHeight = availableRow;
      const colorbarHeight = Math.max(
        PAGE_MIN_COLORBAR_HEIGHT_PT,
        Math.min(colorbarMaxHeight, rowHeight - colorbarTitleBlock),
      );
      const colorbarY = rowY + rowHeight - colorbarHeight;
      items.push(
        makeColorbarItem(
          nextId++,
          paper.width_pt - margin - colorbarWidth,
          colorbarY,
          colorbarWidth,
          colorbarHeight,
          relief,
        ),
      );
    }
  } else {
    // 3L) 横向：右栏自上而下 = 图例 | 注记 | 色标（缺省块不占位）
    const rightX = margin + mapWidth + columnGap;
    const rightWidth = hasRightColumn
      ? Math.max(reservedRightWidth, paper.width_pt - margin - rightX)
      : 0;

    // 没有图例时注记/色标直接从栏顶开始；有图例时保持既有版式（回归 demo）。
    let contentTop = mapTop;
    if (hasLegend) {
      const legendItem = makeLegendItem(nextId++, rightX, mapTop, rightWidth);
      items.push(legendItem);
      contentTop = mapTop + legendLayout(legendItem).height;
    }

    const noteSize = PAGE_NOTE_SIZE_PT * k;
    const noteFont = fontShorthand(noteSize, style.font_family, PAGE_TEXT_STYLES.note.font_weight);
    const noteLines = wrapParagraphs(geo.suggestions.notes, noteFont, rightWidth, measure).filter(
      (line) => line.length > 0,
    );
    let notesBottom = contentTop;
    if (noteLines.length > 0) {
      const notesY = hasLegend ? contentTop + notesGap : contentTop;
      items.push(
        makeTextItem(nextId++, 'note', rightX, notesY, noteLines, noteSize, {
          anchor: 'start',
          color: style.color,
        }),
      );
      notesBottom = notesY + noteLines.length * noteSize * PAGE_TEXT_STYLES.note.line_height;
    }

    if (hasColorbar && relief !== null) {
      // 色标：高度按剩余空间压缩；不够 40pt 时贴右栏底、与注记留 8pt
      const colorbarWidth = PAGE_COLORBAR_WIDTH_PT * k;
      const colorbarMaxHeight = PAGE_COLORBAR_HEIGHT_PT * k;
      const colorbarX = rightX + (rightWidth - colorbarWidth) / 2;
      const bottomLimit = paper.height_pt - margin - sourceReserved;
      const colorbarGap = PAGE_COLORBAR_GAP_PT * k;
      let colorbarY = notesBottom + colorbarGap;
      let colorbarHeight = Math.min(colorbarMaxHeight, bottomLimit - colorbarY);
      if (colorbarHeight < PAGE_MIN_COLORBAR_HEIGHT_PT) {
        colorbarHeight = Math.min(
          colorbarMaxHeight,
          Math.max(PAGE_MIN_COLORBAR_HEIGHT_PT, bottomLimit - (notesBottom + 8)),
        );
        colorbarY = bottomLimit - colorbarHeight;
        if (colorbarY < notesBottom + 8) colorbarY = notesBottom + 8;
      }
      colorbarHeight = Math.max(PAGE_MIN_COLORBAR_HEIGHT_PT, colorbarHeight);
      items.push(
        makeColorbarItem(nextId++, colorbarX, colorbarY, colorbarWidth, colorbarHeight, relief),
      );
    }
  }

  // 4) 来源（页底一行或折行后多行，最后一行基线贴住页边距）
  const sourceSize = PAGE_SOURCE_SIZE_PT * k;
  const sourceFont = fontShorthand(
    sourceSize,
    style.font_family,
    PAGE_TEXT_STYLES.source.font_weight,
  );
  const sourceLines = wrapParagraphs(
    geo.suggestions.source.length > 0 ? [geo.suggestions.source] : [],
    sourceFont,
    contentWidth,
    measure,
  ).filter((line) => line.length > 0);
  if (sourceLines.length > 0) {
    const baselines = sourceLines.length;
    const firstY =
      paper.height_pt - margin - (baselines - 1) * sourceSize * PAGE_TEXT_STYLES.source.line_height;
    items.push(
      makeTextItem(nextId++, 'source', paper.width_pt / 2, firstY, sourceLines, sourceSize, {
        anchor: 'middle',
        color: style.color,
      }),
    );
  }

  // 5) 地名标注：按 geo 原始绘制顺序铺成 map 空间文字（字号/光晕按地图缩放比 s 换算）
  const mapScale = geo.base.width_pt > 0 ? mapWidth / geo.base.width_pt : 1;
  const labels = [...geo.labels].sort((a, b) => a.order - b.order);
  for (const label of labels) items.push(makeLabelItem(nextId++, label, mapScale));

  return {
    paper,
    map: { x: margin, y: mapTop, width_pt: mapWidth },
    frame,
    style,
    items,
    // seq 是「下一个可用 id」：保证大于所有 item id（契约 §4）
    seq: nextId,
  };
}
