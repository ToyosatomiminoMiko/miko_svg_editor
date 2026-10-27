/**
 * 文本测量适配器：把 DOM 的 canvas 2d measureText 包成两种注入口径。
 *
 * 是什么：`createTextMeasurer()` 只给宽度（types.MeasureText，草图内核用）；
 * `createTextMeasure()` 另带字体行盒的 ascent/descent（types.TextMeasure，地图排版用）。
 * 为什么分两个：宽度与字体行盒是两件事——宽度随文本变化，行盒只随 CSS font 变化；
 * 拆开后草图侧不必认识行盒，地图侧的选中框/命中盒又能拿到确定的高度依据。
 */

import { TEXT_FALLBACK_CHAR_WIDTH, TEXT_FALLBACK_FONT_PX } from '../config';
import { PAGE_TEXT_FALLBACK_ASCENT_RATIO, PAGE_TEXT_FALLBACK_DESCENT_RATIO } from '../config/page';
import type { MeasureText, TextMeasure } from '../core/types';

/** 从字体简写里取字号；解析失败时按回退字号算 */
const fontPx = (font: string): number => {
  const v = Number.parseFloat(font);
  return Number.isFinite(v) && v > 0 ? v : TEXT_FALLBACK_FONT_PX;
};

/**
 * 回退估算：每字符宽度按回退字号标定，再按实际字号等比缩放。
 * 默认字号下即 text.length × TEXT_FALLBACK_CHAR_WIDTH，保持无 canvas 环境（测试）可跑。
 */
const estimate = (text: string, font: string): number =>
  text.length * TEXT_FALLBACK_CHAR_WIDTH * (fontPx(font) / TEXT_FALLBACK_FONT_PX);

export function createTextMeasurer(): MeasureText {
  const ctx =
    typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!ctx) return (text, font) => estimate(text, font);
  return (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

/** 无 canvas 时的字体行盒：按字号 × config 里的回退比例（与 core/page-layout 的回退同值） */
const fallbackAscent = (font: string): number => fontPx(font) * PAGE_TEXT_FALLBACK_ASCENT_RATIO;
const fallbackDescent = (font: string): number => fontPx(font) * PAGE_TEXT_FALLBACK_DESCENT_RATIO;

/**
 * 带字体行盒的文本度量（地图排版用）。
 * 为什么行盒用 `fontBoundingBoxAscent/Descent`：这两个值就是 CSS font 的字体行盒
 * （hhea/OS2 度量，与文本内容无关），是浏览器实际排版 `<text>` 时用的同一份字体度量；
 * 取固定样本 `'Hg'` 只为拿到 font 对象，内容不影响结果。
 * 按 font 简写缓存：一页几十个标注每帧重绘，避免每帧重复 measureText。
 */
export function createTextMeasure(): TextMeasure {
  const ctx =
    typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!ctx) {
    return {
      width: (text, font) => estimate(text, font),
      ascent: fallbackAscent,
      descent: fallbackDescent,
    };
  }
  const boxes = new Map<string, { readonly ascent: number; readonly descent: number }>();
  const boxOf = (font: string): { readonly ascent: number; readonly descent: number } => {
    const cached = boxes.get(font);
    if (cached) return cached;
    ctx.font = font;
    const metrics = ctx.measureText('Hg');
    const ascent = Number.isFinite(metrics.fontBoundingBoxAscent)
      ? metrics.fontBoundingBoxAscent
      : fallbackAscent(font);
    const descent = Number.isFinite(metrics.fontBoundingBoxDescent)
      ? metrics.fontBoundingBoxDescent
      : fallbackDescent(font);
    const box = { ascent, descent };
    boxes.set(font, box);
    return box;
  };
  return {
    width: (text, font) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    },
    ascent: (font) => boxOf(font).ascent,
    descent: (font) => boxOf(font).descent,
  };
}
