/**
 * 数据模型的静态类型定义。
 * 运行时数据结构与方法见 model.ts；约束方程见 constraints.ts。
 */

export interface Vec {
  x: number;
  y: number;
}

/** 轴对齐矩形，用于框选 */
export interface Rect {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
}

export interface Point {
  id: number;
  x: number;
  y: number;
  /** 固定点不参与求解 */
  fixed: boolean;
  /** 拖拽中的点暂时不参与求解 */
  dragging: boolean;
}

interface EntityBase {
  id: number;
  /** 构造线以虚线显示，不参与导出为实线 */
  construction: boolean;
}

export interface LineEntity extends EntityBase {
  type: 'line';
  a: number;
  b: number;
}

export interface CircleEntity extends EntityBase {
  type: 'circle';
  c: number;
  r: number;
}

export interface ArcEntity extends EntityBase {
  type: 'arc';
  c: number;
  r: number;
  a0: number;
  a1: number;
}

export type Entity = LineEntity | CircleEntity | ArcEntity;

export type ConstraintKind =
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'equalLength'
  | 'pointOnLine'
  | 'pointOnCircle'
  | 'tangentLC'
  | 'tangentCC'
  | 'concentric'
  | 'equalRadius'
  | 'distancePP'
  | 'distancePL'
  | 'radius'
  | 'angle'
  | 'midpoint'
  | 'symmetric';

/**
 * 约束用可选字段表达不同种类，具体哪些字段有效由 constraints.ts 的 RESID 表决定：
 * 图元引用：e / e1 / e2 / line / circ；点引用：a / b / p / p1 / p2。
 */
export interface Constraint {
  id: number;
  type: ConstraintKind;
  e?: number;
  e1?: number;
  e2?: number;
  a?: number;
  b?: number;
  p?: number;
  p1?: number;
  p2?: number;
  line?: number;
  circ?: number;
  d?: number;
  r?: number;
  offset?: number;
}

export type ToolId = 'select' | 'line' | 'circle' | 'arc' | 'rect' | 'dim' | 'erase';

export type SnapKind = 'point' | 'mid' | 'on' | 'quad' | 'grid';

export interface Snap {
  type: SnapKind;
  pos: Vec;
  /** 吸附到已有点时带出该点，便于直接复用 */
  pt?: Point;
  d: number;
  pri: number;
}

/**
 * 未完成的绘制操作。
 * newPt：这次点击顺手创建的点的 id；取消时要把这个孤立点删掉，
 * 已经并入图元的点不会再标在这里。
 */
export type Pending =
  | { type: 'line'; start: Vec; startPt: Point; newPt?: number }
  | { type: 'circle'; center: number; newPt?: number }
  | { type: 'arc'; c: number; stage: 1 | 2; r?: number; a0?: number; newPt?: number }
  | { type: 'rect'; p0: Vec }
  | { type: 'dim'; a: number };

export interface EditorState {
  tool: ToolId;
  cursorW: Vec;
  snap: Snap | null;
  /** 吸附总开关：关闭后不吸附到点/中点/曲线/网格 */
  snapEnabled: boolean;
  hoverPt: Point | null;
  hoverEnt: Entity | null;
  pending: Pending | null;
  sel: number[];
  /** 框选矩形（世界坐标），拖拽中才有值 */
  marquee: { a: Vec; b: Vec } | null;
}
