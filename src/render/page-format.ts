/**
 * 排版预览的数值/转义/SVG 属性格式（与 Python `tools/mapdoc/render.py` 逐字一致）。
 *
 * 是什么：3 位小数去尾零的 `formatPageNumber`、颜色与虚线属性、XML 文本/属性转义，
 * 以及 colorbar 渐变 id 的唯一命名。
 * 为什么单列一层：SVG 里「28.0」与「28」不是同一份字节，预览、scene 摘要与最终成品
 * 必须共用同一套格式化；Python 侧复刻同一语义（`Math.round(v*1000)/1000` 再去掉尾零）。
 * 元信息：作者 frontend，2026-10-27，随 `docs/PAGE-EDITOR.md` 新契约落地。
 */

import { PAGE_DECIMALS } from '../config/page';

/**
 * 数字 → SVG 文本：最多 3 位小数、去掉尾零、不带单位后缀。
 *
 * 为什么是 `Math.round(v*1000)/1000` 而不是 `toFixed`：`toFixed` 在 .xxx5 边界上
 * 的舍入与 Python 的 `round()` 都是「四舍六入五成双」，而 Python 合成侧已约定用
 * `floor(v*1000+0.5)/1000` 复刻 JS 语义，两侧必须完全同源，否则同一 scene 会得到
 * 不同字节。非有限值落成 "0"（不让 NaN/Infinity 进 SVG）。
 */
export function formatPageNumber(value: number, decimals: number = PAGE_DECIMALS): string {
  if (!Number.isFinite(value)) return '0';
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  if (rounded === 0) return '0';
  return String(rounded);
}

/** XML 文本转义：`& < >`（契约 §5.3；属性值另外还要转引号） */
export function escapeXmlText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** XML 属性转义：在文本转义基础上加 `"` 与 `'` */
export function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/** 颜色属性：null → none；其余原样（校验阶段已限定 #rrggbb） */
export function colorValue(color: string | null): string {
  return color ?? 'none';
}

/** 虚线属性：null → undefined（不写属性）；数字用同一套 3 位小数格式化 */
export function dashArray(dash: readonly number[] | null): string | undefined {
  if (dash === null || dash.length === 0) return undefined;
  return dash.map((entry) => formatPageNumber(entry)).join(' ');
}

/** 不透明度属性：0..1，3 位小数；越界值夹取，避免 SVG 丢弃非法值 */
export function opacityValue(value: number): string {
  if (!Number.isFinite(value)) return '1';
  const clamped = Math.min(1, Math.max(0, value));
  return formatPageNumber(clamped);
}

/** 字号：用户单位就是 pt，不带 "px"/"pt" 后缀（契约 §5.3） */
export function fontSizeValue(sizePt: number): string {
  return formatPageNumber(sizePt);
}

/**
 * colorbar 线性渐变 id：`mapdoc-cbar-<item.id>`（契约 §5.5）。
 * 前缀 `mapdoc-` 同时避免与底图内部 id 冲突（契约 §6）。
 */
export function colorbarGradientId(id: number): string {
  return `mapdoc-cbar-${id}`;
}

/** 线性渐变 stop 的 offset：0..1，3 位小数 */
export function gradientOffset(offset: number): string {
  if (!Number.isFinite(offset)) return '0';
  return formatPageNumber(Math.min(1, Math.max(0, offset)));
}
