/**
 * 文本宽度测量适配器：把 DOM 的 canvas 2d measureText 包成 types.MeasureText，
 * 由 main.ts 注入给 dimensions 等需要量文字宽度的模块，纯逻辑模块因此不依赖 DOM。
 */

import { TEXT_FALLBACK_CHAR_WIDTH, TEXT_FALLBACK_FONT_PX } from '../config';
import type { MeasureText } from '../core/types';

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
