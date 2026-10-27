/**
 * 场景文档 scene.json v1 的纯 codec 与校验：草图模型 ⇄ 文档、场景级样式、计数。
 *
 * 是什么：`serializeScene()` 按 Map 插入序导出点/图元/约束；`applyScene()` 清空模型后
 * 用**显式 id** 重建，并把 `mapStyle` 换成文档里的样式。
 * 为什么文档里不存相机/视图状态：视图是瞬态，载入时按底图自适应（app/map-mode.ts 调 fitBounds）。
 * 为什么圆弧不存 r/起终角：半径与角度由圆心 + 起点 + 终点派生（entities.ts 的 arcGeometry），
 * 存派生量会让「手改 scene」与「求解结果」出现两份真值。
 * 为什么不在这里做残差检查：载入不自动求解（坐标是权威值），残差告警由调用方按阈值提示。
 */

import {
  ENTITY_REF_KEYS,
  MAPDOC_MAX_ITEMS,
  MAPDOC_SCENE_FORMAT,
  MAPDOC_SCENE_VERSION,
  MAPDOC_STYLE_DEFAULTS,
  POINT_REF_KEYS,
} from '../config';
import { ArcEntity, CircleEntity, LineEntity, PointEntity, type Entity } from './entities';
import { model, restoreModel } from './model';
import { resetInteraction } from './state';
import type { Constraint, Point } from './types';

/** 场景里的一个点（自由点/端点/圆心/文本锚点统一在 points 容器） */
export interface ScenePoint {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly fixed: boolean;
}

/**
 * 场景里的一条图元：只存结构引用（端点/圆心 id），不存派生几何。
 * 圆的半径是独立求解参数，必须存；圆弧半径由三点派生，不存。
 */
export type SceneEntity =
  | {
      readonly id: number;
      readonly type: 'line';
      readonly a: number;
      readonly b: number;
      readonly construction: boolean;
    }
  | {
      readonly id: number;
      readonly type: 'circle';
      readonly c: number;
      readonly r: number;
      readonly construction: boolean;
    }
  | {
      readonly id: number;
      readonly type: 'arc';
      readonly c: number;
      readonly a: number;
      readonly b: number;
      readonly construction: boolean;
    }
  | {
      readonly id: number;
      readonly type: 'point';
      readonly p: number;
      readonly construction: boolean;
    };

/** 约束与内核 `Constraint` 一一对应（作者态字段 angleSector/offset/leaderAngle 必须落盘） */
export type SceneConstraint = Constraint;

/** 场景级样式：几何线色/线宽/虚线 + 点半径 + 文字默认（字族 v1 全场景唯一） */
export interface SceneStyle {
  readonly stroke: string;
  readonly stroke_width_pt: number;
  readonly construction_dash_pt: readonly [number, number];
  readonly point_radius_pt: number;
  readonly font_family: string;
  readonly font_size_pt: number;
  readonly text_color: string;
}

/** 浏览器回传的底图声明，仅用于变更检测（服务器用真实 base 校验） */
export interface SceneBaseClaim {
  readonly sha256: string;
  readonly width_pt: number;
  readonly height_pt: number;
}

/** 浏览器提交/接收的语义体（不含 figure/base 声明） */
export interface SceneContent {
  readonly format: typeof MAPDOC_SCENE_FORMAT;
  readonly version: typeof MAPDOC_SCENE_VERSION;
  readonly style: SceneStyle;
  readonly seq: number;
  readonly points: readonly ScenePoint[];
  readonly entities: readonly SceneEntity[];
  readonly constraints: readonly SceneConstraint[];
}

/** 服务器返回的完整场景（落盘内容） */
export interface SceneDoc extends SceneContent {
  readonly figure: string;
  readonly base: SceneBaseClaim;
}

/** 场景级样式单例：载入时来自文档，之后由样式面板/P4 修改 */
export const mapStyle: {
  stroke: string;
  stroke_width_pt: number;
  construction_dash_pt: [number, number];
  point_radius_pt: number;
  font_family: string;
  font_size_pt: number;
  text_color: string;
} = {
  ...MAPDOC_STYLE_DEFAULTS,
  construction_dash_pt: [...MAPDOC_STYLE_DEFAULTS.construction_dash_pt] as [number, number],
};

/** 把场景级样式整体换成给定值（载入与样式面板共用；copy 一份避免外部数组被共享） */
export function setMapStyle(style: SceneStyle): void {
  mapStyle.stroke = style.stroke;
  mapStyle.stroke_width_pt = style.stroke_width_pt;
  mapStyle.construction_dash_pt = [...style.construction_dash_pt];
  mapStyle.point_radius_pt = style.point_radius_pt;
  mapStyle.font_family = style.font_family;
  mapStyle.font_size_pt = style.font_size_pt;
  mapStyle.text_color = style.text_color;
}

/** 图元 → 场景图元（只取结构字段；类实例的其它成员不落盘） */
function toSceneEntity(e: Entity): SceneEntity {
  switch (e.type) {
    case 'line':
      return { id: e.id, type: 'line', a: e.a, b: e.b, construction: e.construction };
    case 'circle':
      return { id: e.id, type: 'circle', c: e.c, r: e.r, construction: e.construction };
    case 'arc':
      return { id: e.id, type: 'arc', c: e.c, a: e.a, b: e.b, construction: e.construction };
    case 'point':
      return { id: e.id, type: 'point', p: e.p, construction: e.construction };
  }
}

/**
 * 约束 → 场景约束。
 * 为什么显式列字段而不是展开对象：`Constraint` 是可选字段的宽接口，直接展开会把
 * 运行期多出来的键带进文档（服务器对未知字段是拒绝而不是忽略）。
 */
function toSceneConstraint(c: Constraint): SceneConstraint {
  const out: Constraint = { id: c.id, type: c.type };
  if (c.e !== undefined) out.e = c.e;
  if (c.e1 !== undefined) out.e1 = c.e1;
  if (c.e2 !== undefined) out.e2 = c.e2;
  if (c.line !== undefined) out.line = c.line;
  if (c.circ !== undefined) out.circ = c.circ;
  if (c.a !== undefined) out.a = c.a;
  if (c.b !== undefined) out.b = c.b;
  if (c.p !== undefined) out.p = c.p;
  if (c.distance !== undefined) out.distance = c.distance;
  if (c.radius !== undefined) out.radius = c.radius;
  if (c.angle !== undefined) out.angle = c.angle;
  if (c.offset !== undefined) out.offset = c.offset;
  if (c.leaderAngle !== undefined) out.leaderAngle = c.leaderAngle;
  if (c.angleSector !== undefined) out.angleSector = c.angleSector;
  return out;
}

/** 场景图元 → 内核图元（显式 id，构造标记照搬） */
function toEntity(e: SceneEntity): Entity {
  switch (e.type) {
    case 'line':
      return new LineEntity(e.id, e.a, e.b, e.construction);
    case 'circle':
      return new CircleEntity(e.id, e.c, e.r, e.construction);
    case 'arc':
      return new ArcEntity(e.id, e.c, e.a, e.b, e.construction);
    case 'point':
      return new PointEntity(e.id, e.p, e.construction);
  }
}

/** 导出当前模型与场景样式为文档语义体（点/图元/约束都按 Map 插入序） */
export function serializeScene(): SceneContent {
  return {
    format: MAPDOC_SCENE_FORMAT,
    version: MAPDOC_SCENE_VERSION,
    style: {
      stroke: mapStyle.stroke,
      stroke_width_pt: mapStyle.stroke_width_pt,
      construction_dash_pt: [...mapStyle.construction_dash_pt] as [number, number],
      point_radius_pt: mapStyle.point_radius_pt,
      font_family: mapStyle.font_family,
      font_size_pt: mapStyle.font_size_pt,
      text_color: mapStyle.text_color,
    },
    seq: model.seq,
    points: [...model.pts.values()].map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      fixed: p.fixed,
    })),
    entities: [...model.ents.values()].map(toSceneEntity),
    constraints: [...model.cons.values()].map(toSceneConstraint),
  };
}

/** 用文档重建模型与场景样式（调用前应先 validateScene；空文档 = 空场景） */
export function applyScene(doc: SceneContent): void {
  const points: Point[] = doc.points.map((p) => ({
    id: p.id,
    x: p.x,
    y: p.y,
    fixed: p.fixed,
  }));
  const ents: Entity[] = doc.entities.map(toEntity);
  const cons: Constraint[] = doc.constraints.map((c) => toSceneConstraint(c));
  restoreModel(points, ents, cons, doc.seq);
  setMapStyle(doc.style);
  resetInteraction();
}

/** 当前模型的对象计数（状态栏与保存提示用） */
export function sceneCounts(): { points: number; entities: number; constraints: number } {
  return {
    points: model.pts.size,
    entities: model.ents.size,
    constraints: model.cons.size,
  };
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isPositiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0;

/** 运行期「是不是数组」检查：返回 boolean 而不是类型守卫，避免把已标注的数组收窄成 any[] */
const isArrayLike = (v: unknown): boolean => Array.isArray(v);

/** 颜色白名单：只接受 #rrggbb（A4），避免把命名色/CSS 注入写进成品 */
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * 文档结构校验：返回错误列表（空数组 = 合法）。
 * 只做「能重建模型」的必要检查：id/引用/数值有限/圆弧半径非零/约束引用种类；
 * 不检查残差（载入不自动求解），也不检查样式以外的 UI 偏好。
 */
export function validateScene(doc: SceneContent): string[] {
  const errors: string[] = [];
  // 文案里不再插值被比较的字面量：`doc.format` 的类型就是该字面量，`!==` 的否定分支会被
  // TS 收窄成 never，模板串里用它反而触发 restrict-template-expressions。
  if (doc.format !== MAPDOC_SCENE_FORMAT) errors.push('format 必须为 mapdoc-scene');
  if (doc.version !== MAPDOC_SCENE_VERSION) errors.push('version 必须为 1');
  if (!isPositiveInt(doc.seq)) errors.push('seq 必须是正整数');

  const points = doc.points;
  const entities = doc.entities;
  const constraints = doc.constraints;
  // 用返回 boolean 的包装而不是直接 Array.isArray：后者是类型守卫，`!Array.isArray(...)`
  // 返回后的分支会把元素类型收窄成 any[]，后续的 p.id/e.a 就全变成 any（no-unsafe-* 炸）。
  if (!isArrayLike(points) || !isArrayLike(entities) || !isArrayLike(constraints)) {
    errors.push('points/entities/constraints 必须是数组');
    return errors;
  }
  if (points.length > MAPDOC_MAX_ITEMS) errors.push(`points 超过上限 ${MAPDOC_MAX_ITEMS}`);
  if (entities.length > MAPDOC_MAX_ITEMS) errors.push(`entities 超过上限 ${MAPDOC_MAX_ITEMS}`);
  if (constraints.length > MAPDOC_MAX_ITEMS)
    errors.push(`constraints 超过上限 ${MAPDOC_MAX_ITEMS}`);

  const pointIds = new Set<number>();
  let maxId = 0;
  for (const p of points) {
    if (!isPositiveInt(p.id)) errors.push(`点 id 非法：${String(p.id)}`);
    else if (pointIds.has(p.id)) errors.push(`点 id 重复：${p.id}`);
    else {
      pointIds.add(p.id);
      maxId = Math.max(maxId, p.id);
    }
    if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) errors.push(`点 #${p.id} 坐标非有限值`);
    if (typeof p.fixed !== 'boolean') errors.push(`点 #${p.id} 的 fixed 必须是布尔`);
  }

  const entityIds = new Set<number>();
  for (const e of entities) {
    if (!isPositiveInt(e.id)) {
      errors.push(`图元 id 非法：${String(e.id)}`);
      continue;
    }
    if (entityIds.has(e.id)) errors.push(`图元 id 重复：${e.id}`);
    entityIds.add(e.id);
    maxId = Math.max(maxId, e.id);
    if (typeof e.construction !== 'boolean')
      errors.push(`图元 #${e.id} 的 construction 必须是布尔`);
    switch (e.type) {
      case 'line':
        if (!pointIds.has(e.a) || !pointIds.has(e.b)) errors.push(`直线 #${e.id} 端点引用不存在`);
        break;
      case 'circle':
        if (!pointIds.has(e.c)) errors.push(`圆 #${e.id} 圆心引用不存在`);
        if (!isFiniteNumber(e.r) || e.r <= 0) errors.push(`圆 #${e.id} 半径必须 > 0`);
        break;
      case 'arc':
        if (!pointIds.has(e.c) || !pointIds.has(e.a) || !pointIds.has(e.b))
          errors.push(`圆弧 #${e.id} 引用不存在`);
        else if (e.c === e.a || e.c === e.b)
          errors.push(`圆弧 #${e.id} 圆心与端点重合（半径为 0）`);
        break;
      case 'point':
        if (!pointIds.has(e.p)) errors.push(`点图元 #${e.id} 引用不存在`);
        break;
      default:
        errors.push(`未知图元类型：${String((e as { type?: unknown }).type)}`);
    }
  }

  for (const c of constraints) {
    if (!isPositiveInt(c.id)) {
      errors.push(`约束 id 非法：${String(c.id)}`);
      continue;
    }
    maxId = Math.max(maxId, c.id);
    const kind = c.type;
    // 引用字段白名单由 config/constraints-meta 推导，不为每种约束再写一份 switch
    const entityKeys = ENTITY_REF_KEYS.filter((key) => c[key] !== undefined);
    const pointKeys = POINT_REF_KEYS.filter((key) => c[key] !== undefined);
    for (const key of entityKeys) {
      const ref = c[key];
      if (typeof ref !== 'number' || !entityIds.has(ref))
        errors.push(`约束 #${c.id}（${kind}）的图元引用 ${String(key)}=${String(ref)} 不存在`);
    }
    for (const key of pointKeys) {
      const ref = c[key];
      if (typeof ref !== 'number' || !pointIds.has(ref))
        errors.push(`约束 #${c.id}（${kind}）的点引用 ${String(key)}=${String(ref)} 不存在`);
    }
    for (const key of ['distance', 'radius', 'angle', 'offset', 'leaderAngle'] as const) {
      const value = c[key];
      if (value !== undefined && !isFiniteNumber(value))
        errors.push(`约束 #${c.id} 的 ${key} 非有限值`);
    }
    if (c.angleSector !== undefined && !Number.isInteger(c.angleSector))
      errors.push(`约束 #${c.id} 的 angleSector 必须是整数`);
  }

  if (isPositiveInt(doc.seq) && doc.seq <= maxId)
    errors.push(`seq(${doc.seq}) 必须大于最大 id(${maxId})`);

  const style = doc.style;
  if (!COLOR_RE.test(style.stroke)) errors.push('style.stroke 必须是 #rrggbb');
  if (!COLOR_RE.test(style.text_color)) errors.push('style.text_color 必须是 #rrggbb');
  if (!isFiniteNumber(style.stroke_width_pt) || style.stroke_width_pt <= 0)
    errors.push('style.stroke_width_pt 必须 > 0');
  if (!isFiniteNumber(style.point_radius_pt) || style.point_radius_pt <= 0)
    errors.push('style.point_radius_pt 必须 > 0');
  if (!isFiniteNumber(style.font_size_pt) || style.font_size_pt <= 0)
    errors.push('style.font_size_pt 必须 > 0');
  if (typeof style.font_family !== 'string' || style.font_family.length === 0)
    errors.push('style.font_family 不能为空');
  const dash = style.construction_dash_pt;
  if (!Array.isArray(dash) || dash.length !== 2 || !dash.every((v) => isFiniteNumber(v) && v > 0))
    errors.push('style.construction_dash_pt 必须是两个正数');

  return errors;
}
