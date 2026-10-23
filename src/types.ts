/**
 * 数据模型的静态类型定义：点、约束、选择集、交互瞬态。
 * 图元是多态类（EntityBase 子类），定义在 entities.ts；
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

/**
 * 约束种类。
 * distancePointPoint / radius 同时是「尺寸」；
 * 每种种类的 UI 入口见 operations.ts 的约束操作与 config/constraints-meta.ts 的 CONSTRAINT_META。
 */
export type ConstraintKind =
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'equalLength'
  | 'collinear'
  | 'pointOnLine'
  | 'pointOnCircle'
  | 'tangentLineCircle'
  | 'tangentCircleCircle'
  | 'concentric'
  | 'equalRadius'
  | 'distancePointPoint'
  | 'radius';

/**
 * 约束用可选字段表达不同种类，具体哪些字段有效由 config/constraints-meta.ts 的 refs 表决定：
 * 图元引用字段：e / e1 / e2 / line / circ；点引用字段：a / b / p。
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
  /* -------- 数值 -------- */
  /** 距离类尺寸的目标值（世界单位），用于 distancePointPoint */
  distance?: number;
  /** 半径类尺寸的目标值（世界单位），用于 radius */
  radius?: number;
  /** 距离尺寸线相对两点的世界偏移 */
  offset?: number;
}

export type ToolId = 'select' | 'point' | 'line' | 'circle' | 'arc' | 'rect' | 'dim' | 'erase';

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

/** 选择项种类：图元或点（id 分属两个容器，必须带种类才能解释） */
export type SelectionKind = 'ent' | 'pt';

/**
 * 选择集里的一项。
 * 用 { kind, id } 而不是裸 id：model 的点/图元各有自己的 id 空间解释，带种类才不歧义。
 */
export interface SelectionItem {
  kind: SelectionKind;
  id: number;
}

/**
 * 选择集：有序的 SelectionItem 列表，顺序即用户选中顺序。
 * 用一份列表而不是「图元数组 + 点数组」，是为了让已选列表的展示顺序稳定，
 * 也让「拖动任一已选图元移动全部已选」只需要遍历这一份集合。
 */
export interface Selection {
  items: SelectionItem[];
}

/**
 * 已选列表行内的一颗约束胶囊：id 用于删除动作定位，text 只用于展示。
 * 必须带 id：文案会随尺寸值变化，也不能保证同一对象上两条约束的文案不同
 * （相切、半径等种类可重复），删除只能按模型 id 找目标。
 */
export interface SelectionConstraint {
  id: number;
  /** 展示文案（尺寸类带显示值，如「距离 20.00」） */
  text: string;
}

/** 已选列表的一行：label 与 constraints 由 selection.ts 生成，UI 层不查模型 */
export interface SelectionEntry {
  kind: SelectionKind;
  id: number;
  label: string;
  /**
   * 该对象已有的约束（尺寸类带显示值，如「距离 20.00」），id 用于行内「×」删除。
   * 只用于「已选择」行内展示，按模型插入顺序排列；没有约束时为空数组。
   */
  constraints: readonly SelectionConstraint[];
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

/**
 * 测量文本像素宽度。
 * 由 main.ts 用 canvas 2d 上下文实现并注入，纯模块不直接依赖 DOM。
 */
export type MeasureText = (text: string, font: string) => number;
