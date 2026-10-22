/**
 * 尺寸标注：单一元数据表 DIM_META 集中「哪些约束算尺寸 + 取值/设值/标签/布局/图元匹配」，
 * 其余函数都查表，新增尺寸种类只需加一条元数据。
 * 布局是纯函数：屏幕变换由调用方传 CameraView 快照，文字宽度由注入的 MeasureText 测量，
 * 因此本文件不依赖全局相机/主题/DOM。renderer 画图与 pickDim 命中判定共用同一份布局。
 */

import {
  DIM_PICK_PX,
  DIM_TEXT_GAP_PX,
  RADIUS_LABEL_DX_PX,
  RADIUS_LABEL_DY_PX,
  TEXT_FALLBACK_FONT_PX,
  formatDimValue,
} from './config';
import { distToSeg } from './geometry';
import { isCurveEntity } from './entities';
import { getEntity, getPoint, model } from './model';
import { vec } from './vec';
import { w2s } from './camera';
import type { CameraView } from './camera';
import type { Constraint, Entity, MeasureText, Vec } from './types';

/** 能画成尺寸标注的约束种类 */
export type DimKind = 'distancePointPoint' | 'radius';

/**
 * 尺寸类约束：按 kind 收窄，数值字段必填。
 * 创建路径必须在 addCon 时同时写入 distance/radius（见 sketch-actions），
 * 因此取值/布局不需要 `?? 0` 兜底；类型收窄由 isDimConstraint 守卫完成。
 */
export type DimConstraint =
  | (Constraint & { type: 'distancePointPoint'; distance: number })
  | (Constraint & { type: 'radius'; radius: number });

interface DistanceDimLayout {
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

interface RadiusDimLayout {
  kind: 'radius';
  text: string;
  /** 屏幕坐标：文字左端，baseline bottom */
  textPos: Vec;
}

type DimLayout = DistanceDimLayout | RadiusDimLayout;

interface DimMeta {
  label: string;
  value(c: DimConstraint): number;
  setValue(c: DimConstraint, v: number): void;
  layout(c: DimConstraint, view: CameraView): DimLayout | null;
  /** 尺寸工具再点该图元时是否命中这条尺寸（用于「改为编辑」而不是重复添加） */
  matchesEntity(c: DimConstraint, e: Entity): boolean;
  matchesPoints?(c: DimConstraint, a: number, b: number): boolean;
}

const samePair = (c: Constraint, a: number, b: number): boolean =>
  (c.a === a && c.b === b) || (c.a === b && c.b === a);

/**
 * 尺寸元数据表：新增一种尺寸 = 加一条记录，取值/布局/匹配/文案不需要再改别处。
 * distance/radius 字段由「addCon 时同时写入数值」的创建路径保证存在，
 * 因此用非空断言而非 `?? 0` 兜底（兜底会把未初始化错误静默变成 0）。
 */
export const DIM_META: Record<DimKind, DimMeta> = {
  distancePointPoint: {
    label: '距离',
    value: (c) => c.distance!,
    setValue: (c, v) => {
      c.distance = v;
    },
    layout(c, view) {
      const a = getPoint(c.a);
      const b = getPoint(c.b);
      if (!a || !b) return null;
      const nrm = vec.unitPerp(vec.sub(b, a));
      // offset 是世界偏移：按当前缩放换算一次后固定，缩放时尺寸线跟着图形走；缺省 0 表示贴线
      const off = c.offset ?? 0;
      const A = w2s(a, view);
      const B = w2s(b, view);
      const A2 = w2s({ x: a.x + nrm.x * off, y: a.y + nrm.y * off }, view);
      const B2 = w2s({ x: b.x + nrm.x * off, y: b.y + nrm.y * off }, view);
      return {
        kind: 'distance',
        A,
        B,
        A2,
        B2,
        text: formatDimValue(c.distance!),
        textPos: { x: (A2.x + B2.x) / 2, y: (A2.y + B2.y) / 2 - DIM_TEXT_GAP_PX },
      };
    },
    matchesEntity: (c, e) => e.type === 'line' && samePair(c, e.a, e.b),
    matchesPoints: (c, a, b) => samePair(c, a, b),
  },

  radius: {
    label: '半径',
    value: (c) => c.radius!,
    setValue: (c, v) => {
      c.radius = v;
    },
    layout(c, view) {
      const e = getEntity(c.e);
      if (!isCurveEntity(e)) return null;
      const center = getPoint(e.c);
      if (!center) return null;
      const C = w2s(center, view);
      return {
        kind: 'radius',
        text: `R${formatDimValue(c.radius!)}`,
        textPos: { x: C.x + RADIUS_LABEL_DX_PX, y: C.y + RADIUS_LABEL_DY_PX },
      };
    },
    matchesEntity: (c, e) => c.e === e.id,
  },
};

/** 尺寸类约束的类型守卫：addCon 返回泛型 Constraint，创建尺寸后据此收窄 */
export const isDimConstraint = (c: Constraint): c is DimConstraint => c.type in DIM_META;

/** 约束是否尺寸标注；不是则返回 null */
export function dimKindOf(c: Constraint): DimKind | null {
  return isDimConstraint(c) ? c.type : null;
}

export const dimValue = (c: DimConstraint): number => DIM_META[c.type].value(c);

export const setDimValue = (c: DimConstraint, v: number): void => DIM_META[c.type].setValue(c, v);

/** 尺寸文案：可传尺寸种类，或已收窄的尺寸约束 */
export const dimLabel = (dim: DimKind | DimConstraint): string =>
  DIM_META[typeof dim === 'string' ? dim : dim.type].label;

/**
 * 计算一条尺寸在屏幕上的画法；非尺寸约束或引用悬空返回 null。
 * 传 view 快照而不是读全局 cam，renderer 与命中判定因此可以共用同一份布局。
 */
export function dimLayout(c: Constraint, view: CameraView): DimLayout | null {
  if (!isDimConstraint(c)) return null;
  return DIM_META[c.type].layout(c, view);
}

/** 从字体简写里取字号；解析失败时按 config/ui 的回退字号算 */
const fontSizePx = (font: string): number => Number.parseFloat(font) || TEXT_FALLBACK_FONT_PX;

/** 文字框到屏幕点的距离，框内为 0 */
function textHitDistance(
  textPos: Vec,
  text: string,
  align: 'center' | 'left',
  measure: MeasureText,
  font: string,
  s: Vec,
): number {
  const w = measure(text, font);
  const h = fontSizePx(font);
  const minx = align === 'center' ? textPos.x - w / 2 : textPos.x;
  const maxx = align === 'center' ? textPos.x + w / 2 : textPos.x + w;
  const miny = textPos.y - h;
  const maxy = textPos.y;
  const dx = Math.max(minx - s.x, 0, s.x - maxx);
  const dy = Math.max(miny - s.y, 0, s.y - maxy);
  return Math.hypot(dx, dy);
}

/** 尺寸标注到屏幕点的命中距离 */
function dimHitDistance(layout: DimLayout, measure: MeasureText, font: string, s: Vec): number {
  if (layout.kind === 'distance') {
    const text = textHitDistance(layout.textPos, layout.text, 'center', measure, font, s);
    return Math.min(text, distToSeg(s, layout.A2, layout.B2));
  }
  return textHitDistance(layout.textPos, layout.text, 'left', measure, font, s);
}

/**
 * 命中已有的尺寸标注（屏幕容差），多条命中时取最近的。
 * font 由调用方从主题传入（editor 传 theme.dimFont），与 renderer 绘制用同一份字体，
 * 这样文字命中框不会和画面上的字宽分叉。
 */
export function pickDim(
  w: Vec,
  view: CameraView,
  measure: MeasureText,
  font: string,
  pickTolPx = DIM_PICK_PX,
): DimConstraint | null {
  const s = w2s(w, view);
  let best: DimConstraint | null = null;
  let bestD = pickTolPx;
  for (const c of model.cons.values()) {
    if (!isDimConstraint(c)) continue;
    const layout = DIM_META[c.type].layout(c, view);
    if (!layout) continue;
    const d = dimHitDistance(layout, measure, font, s);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** 图元已经有的尺寸：尺寸工具再点它时改为编辑，避免重复堆积 */
export function findDimForEntity(e: Entity): DimConstraint | undefined {
  for (const c of model.cons.values()) {
    if (isDimConstraint(c) && DIM_META[c.type].matchesEntity(c, e)) return c;
  }
  return undefined;
}

/** 两点之间已有的距离尺寸 */
export function findDistanceDim(a: number, b: number): DimConstraint | undefined {
  for (const c of model.cons.values()) {
    if (!isDimConstraint(c)) continue;
    if (DIM_META[c.type].matchesPoints?.(c, a, b)) return c;
  }
  return undefined;
}
