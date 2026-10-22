/**
 * 数据模型的静态类型定义。
 * 运行时数据结构与方法见 model.ts；约束残差见 constraints.ts；
 * 数值常量与约束元数据见 config/。
 */

export interface Vec {
  x: number;
  y: number;
}

/** 轴对齐矩形，用于框选与包围盒 */
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
}

interface EntityBase {
  id: number;
  /**
   * 构造线：canvas 与导出都用虚线。
   * 目前由工具栏「构造」按钮切换选中的图元，默认 false。
   */
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
  /** 不变量：r >= 0（由 model.addCircle 与 solver 参数钳制保证） */
  r: number;
}

export interface ArcEntity extends EntityBase {
  type: 'arc';
  c: number;
  /** 不变量：r >= 0 */
  r: number;
  /** 起点角（弧度） */
  a0: number;
  /** 终点角（弧度）；扫角语义见 config/angle.ts 的 sweepOf() */
  a1: number;
}

export type Entity = LineEntity | CircleEntity | ArcEntity;

/** 图元种类 */
export type EntityKind = Entity['type'];

/**
 * 约束种类。
 * distancePointPoint / distancePointLine / radius 同时是「尺寸」；
 * 哪些种类有 UI 入口见 config/constraints-meta.ts 的 CONSTRAINT_META / CONSTRAINT_ACTIONS。
 */
export type ConstraintKind =
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'equalLength'
  | 'pointOnLine'
  | 'pointOnCircle'
  | 'tangentLineCircle'
  | 'tangentCircleCircle'
  | 'concentric'
  | 'equalRadius'
  | 'distancePointPoint'
  | 'distancePointLine'
  | 'radius'
  | 'angle'
  | 'midpoint'
  | 'symmetric';

/**
 * 约束用可选字段表达不同种类，具体哪些字段有效由 config/constraints-meta.ts 的 refs 表决定：
 * 图元引用字段：e / e1 / e2 / line / circ；点引用字段：a / b / p / p1 / p2。
 */
export interface Constraint {
  id: number;
  type: ConstraintKind;
  /* -------- 图元引用 -------- */
  e?: number;
  e1?: number;
  e2?: number;
  line?: number;
  circ?: number;
  /* -------- 点引用 -------- */
  a?: number;
  b?: number;
  p?: number;
  p1?: number;
  p2?: number;
  /* -------- 数值 -------- */
  /** 距离类尺寸的目标值（世界单位），用于 distancePointPoint / distancePointLine */
  distance?: number;
  /** 半径类尺寸的目标值（世界单位），用于 radius */
  radius?: number;
  /** 角度约束的目标值（弧度）；angle 暂无 UI 入口，不与点引用字段 a 复用 */
  angle?: number;
  /** 距离尺寸线相对两点的世界偏移 */
  offset?: number;
}

export type ToolId = 'select' | 'line' | 'circle' | 'arc' | 'rect' | 'dim' | 'erase';

/** 吸附候选；pri 越小优先级越高（0 已有点 … 5 网格） */
export interface Snap {
  pos: Vec;
  /** 吸附到已有点时带出该点，便于直接复用而不是新建重合点 */
  pt?: Point;
  /** 到指针的世界距离 */
  d: number;
  /** 优先级 */
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

/** 选择集：图元 id 与点 id 分开存，避免靠 id 全局唯一性做二次解释 */
export interface Selection {
  ents: number[];
  pts: number[];
}

/**
 * 框选进行中的屏幕状态。
 * 世界矩形由 s0 / currentS 经 s2w 换算，不再另存一份世界坐标；
 * 方向判定（交叉/窗口）看 currentS.y < s0.y。
 */
export interface Marquee {
  s0: Vec;
  currentS: Vec;
  /** 位移超过拖拽阈值后才为 true */
  active: boolean;
  /** 是否累加到已有选择（Shift 框选） */
  add: boolean;
}

export interface EditorState {
  tool: ToolId;
  /** 指针的世界坐标 */
  cursorWorld: Vec;
  snap: Snap | null;
  /** 吸附总开关：关闭后不吸附到点/中点/曲线/网格 */
  snapEnabled: boolean;
  hoverPt: Point | null;
  hoverEnt: Entity | null;
  pending: Pending | null;
  selection: Selection;
  /** 框选状态；不在框选中时为 null */
  marquee: Marquee | null;
}

/**
 * 测量文本像素宽度。
 * 由 main.ts 用 canvas 2d 上下文实现并注入，纯模块不直接依赖 DOM。
 */
export type MeasureText = (text: string, font: string) => number;
