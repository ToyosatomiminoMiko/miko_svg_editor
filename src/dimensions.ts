/**
 * 尺寸标注：布局、命中、查找与取值。
 * 布局统一在屏幕坐标里算，renderer 画图和 pickDim 命中判定共用同一份，
 * 避免「画的位置」和「点的位置」两套代码逐渐不一致。
 */

import { w2s } from './camera';
import { distToSeg } from './geometry';
import { E, P, model } from './model';
import { vec } from './vec';
import type { Theme } from './theme';
import type { Constraint, Entity, Vec } from './types';

/** 尺寸文字：最多两位小数，去掉多余的 0 */
export const formatDimValue = (v: number): string =>
  Math.abs(v) < 1e-9 ? '0' : (+v.toFixed(2)).toString();

export interface DistanceDimLayout {
  kind: 'distance';
  /** 屏幕坐标：被标注的两点 */
  A: Vec;
  B: Vec;
  /** 屏幕坐标：沿法线偏移后的尺寸线端点 */
  A2: Vec;
  B2: Vec;
  text: string;
  /** 屏幕坐标：文字中心，baseline bottom */
  textPos: Vec;
}

export interface RadiusDimLayout {
  kind: 'radius';
  text: string;
  /** 屏幕坐标：文字左端，baseline bottom */
  textPos: Vec;
}

export type DimLayout = DistanceDimLayout | RadiusDimLayout;

/** 目前只有距离和半径两种约束画成尺寸标注 */
const isEditableDim = (c: Constraint): boolean =>
  c.type === 'distancePP' || c.type === 'radius';

export function dimValue(c: Constraint): number {
  if (c.type === 'radius') return c.r ?? 0;
  if (c.type === 'distancePP') return c.d ?? 0;
  return 0;
}

export function setDimValue(c: Constraint, v: number): void {
  if (c.type === 'radius') c.r = v;
  else if (c.type === 'distancePP') c.d = v;
}

/** 计算一条尺寸在屏幕上的画法；不支持的约束返回 null */
export function dimLayout(c: Constraint): DimLayout | null {
  if (c.type === 'distancePP') {
    const a = P(c.a);
    const b = P(c.b);
    if (!a || !b) return null;

    const d = vec.sub(b, a);
    const len = vec.len(d) || 1;
    const nrm = { x: -d.y / len, y: d.x / len };
    const off = c.offset ?? 0;
    const A = w2s(a);
    const B = w2s(b);
    const A2 = w2s({ x: a.x + nrm.x * off, y: a.y + nrm.y * off });
    const B2 = w2s({ x: b.x + nrm.x * off, y: b.y + nrm.y * off });

    return {
      kind: 'distance',
      A,
      B,
      A2,
      B2,
      text: formatDimValue(c.d ?? 0),
      textPos: { x: (A2.x + B2.x) / 2, y: (A2.y + B2.y) / 2 - 4 },
    };
  }

  if (c.type === 'radius') {
    const e = E(c.e);
    if (!e || e.type === 'line') return null;
    const center = P(e.c);
    if (!center) return null;
    const C = w2s(center);
    return {
      kind: 'radius',
      text: 'R' + formatDimValue(c.r ?? e.r),
      textPos: { x: C.x + 8, y: C.y - 8 },
    };
  }

  return null;
}

let measureCtx: CanvasRenderingContext2D | null = null;
let measureReady = false;

/** 量文字宽度；拿不到 canvas 上下文时按字数估算，避免命中判定直接崩溃 */
function textWidth(text: string, font: string): number {
  if (!measureReady) {
    measureReady = true;
    measureCtx = document.createElement('canvas').getContext('2d');
  }
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

const fontSize = (font: string): number => Number.parseFloat(font) || 12;

/** 文字框到屏幕点的距离，框内为 0 */
function textHitDistance(
  textPos: Vec,
  text: string,
  align: 'center' | 'left',
  theme: Theme,
  s: Vec,
): number {
  const w = textWidth(text, theme.dimFont);
  const h = fontSize(theme.dimFont);
  const minx = align === 'center' ? textPos.x - w / 2 : textPos.x;
  const maxx = align === 'center' ? textPos.x + w / 2 : textPos.x + w;
  const miny = textPos.y - h;
  const maxy = textPos.y;
  const dx = Math.max(minx - s.x, 0, s.x - maxx);
  const dy = Math.max(miny - s.y, 0, s.y - maxy);
  return Math.hypot(dx, dy);
}

/** 尺寸标注到屏幕点的命中距离；只在 pickDim 里用 */
function dimHitDistance(layout: DimLayout, theme: Theme, s: Vec): number {
  if (layout.kind === 'distance') {
    const text = textHitDistance(layout.textPos, layout.text, 'center', theme, s);
    return Math.min(text, distToSeg(s, layout.A2, layout.B2));
  }
  return textHitDistance(layout.textPos, layout.text, 'left', theme, s);
}

/** 命中已有的尺寸标注（屏幕容差），多条命中时取最近的 */
export function pickDim(w: Vec, theme: Theme, tolPx = 6): Constraint | null {
  const s = w2s(w);
  let best: Constraint | null = null;
  let bestD = tolPx;
  for (const c of model.cons.values()) {
    if (!isEditableDim(c)) continue;
    const layout = dimLayout(c);
    if (!layout) continue;
    const d = dimHitDistance(layout, theme, s);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

const samePair = (c: Constraint, a: number, b: number): boolean =>
  (c.a === a && c.b === b) || (c.a === b && c.b === a);

/** 图元已经有的尺寸：尺寸工具再点它时改为编辑，避免重复堆积 */
export function findDimForEntity(e: Entity): Constraint | undefined {
  for (const c of model.cons.values()) {
    if (e.type === 'line') {
      if (c.type === 'distancePP' && samePair(c, e.a, e.b)) return c;
    } else if (c.type === 'radius' && c.e === e.id) {
      return c;
    }
  }
  return undefined;
}

/** 两点之间已有的距离尺寸 */
export function findDistanceDim(a: number, b: number): Constraint | undefined {
  for (const c of model.cons.values()) {
    if (c.type === 'distancePP' && samePair(c, a, b)) return c;
  }
  return undefined;
}
