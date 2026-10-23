/**
 * 图元模型：每个图元都是 EntityBase 的子类，种类差异通过重写基类方法表达。
 * 调用点只依赖 Entity / EntityBase 接口，不再对 e.type 写 switch：
 * - 几何统一归一到 EntityPrimitive（线段 / 圆弧 / 点）；拾取、吸附、包围盒、框选、
 *   canvas 渲染与 SVG 导出都只消费这三种基元，圆与圆弧的半径/角度数学因此只有一份；
 * - 尺寸目标、重合/相切约束映射、求解自由度、圆弧结构残差也由子类各自实现，
 *   新增图元种类时只需在本文件加子类并加进 Entity 联合（必要时再扩展基元种类），
 *   不会把种类集合复制到各个调用点的 switch 里。
 *
 * 本文件不依赖模型容器：需要点对象的方法接收 PointLookup（由 model.getPoint 注入），
 * 避免 entities → model 的反向依赖（model 的增删查要用 pointIds）。
 */

import { TAU, sweepOf, type ResolvedConstraint } from '../config';
import { vec } from './vec';
import type { Point, Vec } from './types';

/** 点 id → 点对象；model.getPoint 满足这个签名 */
export type PointLookup = (id: number) => Point | undefined;

/** 图元大类：按共享几何语义分组（直线 / 圆-弧曲线 / 点） */
export type EntityCategory = 'line' | 'curve' | 'point';

/** 图元联合：新增图元时把子类加进这里，EntityKind 会自动扩展 */
export type Entity = LineEntity | CircleEntity | ArcEntity | PointEntity;

/** 图元种类字面量联合（由 Entity 联合推导，不另维护一份手写清单） */
export type EntityKind = Entity['type'];

/** 圆/弧：共享圆心 c 的曲线图元 */
export type CurveEntity = CircleEntity | ArcEntity;

/**
 * 几何基元：拾取距离、吸附候选、折线近似、包围盒、canvas 绘制、SVG 导出都只认这三种。
 * 图元种类到基元的映射写在各类的 primitive() 里——新增图元若复用已有基元，
 * 视图/导出/拾取/吸附不需要任何改动。
 */
export type EntityPrimitive =
  /** 线段：两端点 */
  | { readonly kind: 'segment'; readonly a: Vec; readonly b: Vec }
  /**
   * 圆弧基元：圆心 + 半径 + 起始角 + 正向扫角。
   * 整圆用 sweep = TAU 表示，下游不再区分「圆」与「圆弧」两种画法。
   */
  | {
      readonly kind: 'circular';
      readonly center: Vec;
      readonly radius: number;
      readonly start: number;
      readonly sweep: number;
    }
  /** 点基元：零尺寸图元（点图元），拾取容差由调用方决定 */
  | { readonly kind: 'dot'; readonly at: Vec };

/** 尺寸工具点中图元后的目标：直线 → 两端点距离，圆/弧 → 半径 */
export type DimTarget =
  | { readonly kind: 'distance'; readonly a: number; readonly b: number }
  | { readonly kind: 'radius'; readonly e: number };

/** 求解器标量自由度：坐标自由度统一在 Point 上，不经过这里 */
export interface FreeParam {
  get(): number;
  set(v: number): void;
}

/** 圆弧派生几何：三个引用点 + 由点算出的半径与起终角 */
export interface ArcGeometry {
  readonly center: Point;
  readonly start: Point;
  readonly end: Point;
  /** 半径 = |起点 - 圆心| */
  readonly r: number;
  /** 起点角（弧度） */
  readonly a0: number;
  /** 终点角（弧度）；扫角语义见 config/angle.ts 的 sweepOf() */
  readonly a1: number;
}

/**
 * 图元基类：所有按种类分派的行为都是这里的可重写方法。
 * 默认实现对应「该图元没有这种能力」（返回 null / 空数组），子类只重写自己关心的部分；
 * 需要模型数据的几何方法接收 PointLookup，类本身不持有容器引用。
 */
export abstract class EntityBase {
  protected constructor(
    readonly id: number,
    public construction: boolean,
  ) {}

  /** 种类字面量；同时用于可辨识联合收窄与约束元数据的 accepts 校验 */
  abstract readonly type: EntityKind;
  abstract readonly category: EntityCategory;
  abstract readonly label: string;

  /** 结构引用的点 id（删除级联、选择、拖拽、点归属共用） */
  abstract get pointIds(): readonly number[];

  /** 点图元包装的点 id；其它图元为 null */
  get ownedPointId(): number | null {
    return null;
  }

  /** 尺寸工具点中该图元时的目标；null = 没有独立尺寸（点图元只能作为两点距离的一端） */
  dimTarget(): DimTarget | null {
    return null;
  }

  /** 点在该图元中的结构角色（端点/圆心）；「重合」用它挡掉恒成立的假约束 */
  pointRole(_pointId: number): string | null {
    return null;
  }

  /** 「点落在该图元上」对应的约束；null = 该图元不能作为「重合」的目标 */
  pointOnConstraint(_pointId: number): ResolvedConstraint | null {
    return null;
  }

  /** 与另一个图元相切时生成的约束；null = 这个组合不支持相切 */
  tangentWith(_other: EntityBase): ResolvedConstraint | null {
    return null;
  }

  /** 求解器的标量自由度（目前只有圆的半径） */
  freeParams(): FreeParam[] {
    return [];
  }

  /**
   * 不写成 Constraint 的内部结构残差（圆弧端点共圆）。
   * 与用户约束分开：它不可删除、不出现在约束按钮里，只维持图元自洽。
   */
  structuralResiduals(_pts: PointLookup): number[] {
    return [];
  }

  /** 曲线半径；非曲线返回 null */
  radius(_pts: PointLookup): number | null {
    return null;
  }

  /** 几何基元；引用缺失等异常数据返回 null，由只读路径跳过 */
  abstract primitive(pts: PointLookup): EntityPrimitive | null;
}

/** 直线：两端点，无独立标量参数 */
export class LineEntity extends EntityBase {
  readonly type = 'line' as const;
  readonly category = 'line' as const;
  readonly label = '直线';

  constructor(
    id: number,
    public a: number,
    public b: number,
    construction = false,
  ) {
    super(id, construction);
  }

  get pointIds(): readonly number[] {
    return [this.a, this.b];
  }

  override pointRole(pointId: number): string | null {
    return pointId === this.a || pointId === this.b ? '端点' : null;
  }

  override dimTarget(): DimTarget {
    return { kind: 'distance', a: this.a, b: this.b };
  }

  override pointOnConstraint(pointId: number): ResolvedConstraint {
    return { kind: 'pointOnLine', props: { p: pointId, e: this.id } };
  }

  override tangentWith(other: EntityBase): ResolvedConstraint | null {
    if (other instanceof CurveEntityBase) {
      return { kind: 'tangentLineCircle', props: { line: this.id, circ: other.id } };
    }
    return null;
  }

  override primitive(pts: PointLookup): EntityPrimitive | null {
    const a = pts(this.a);
    const b = pts(this.b);
    return a && b ? { kind: 'segment', a, b } : null;
  }
}

/** 圆/弧基类：共享圆心引用，重合目标是 pointOnCircle、相切按「线-圆 / 圆-圆」分派 */
export abstract class CurveEntityBase extends EntityBase {
  readonly category = 'curve' as const;
  /** 圆心点 id */
  abstract c: number;

  override pointRole(pointId: number): string | null {
    return pointId === this.c ? '圆心' : null;
  }

  override pointOnConstraint(pointId: number): ResolvedConstraint {
    return { kind: 'pointOnCircle', props: { p: pointId, e: this.id } };
  }

  override tangentWith(other: EntityBase): ResolvedConstraint | null {
    if (other instanceof LineEntity) {
      return { kind: 'tangentLineCircle', props: { line: other.id, circ: this.id } };
    }
    if (other instanceof CurveEntityBase) {
      return { kind: 'tangentCircleCircle', props: { e1: this.id, e2: other.id } };
    }
    return null;
  }
}

/** 圆：圆心 + 半径；半径是独立求解参数（钳制 >= 0） */
export class CircleEntity extends CurveEntityBase {
  readonly type = 'circle' as const;
  readonly label = '圆';

  constructor(
    id: number,
    public c: number,
    public r: number,
    construction = false,
  ) {
    super(id, construction);
  }

  get pointIds(): readonly number[] {
    return [this.c];
  }

  override dimTarget(): DimTarget {
    return { kind: 'radius', e: this.id };
  }

  override freeParams(): FreeParam[] {
    return [
      {
        get: () => this.r,
        // 与 model.addCircle 一致：求解器写回时也钳制到 >= 0，下游不必再 Math.abs
        set: (v) => {
          this.r = Math.max(0, v);
        },
      },
    ];
  }

  override radius(_pts: PointLookup): number {
    return this.r;
  }

  override primitive(pts: PointLookup): EntityPrimitive | null {
    const c = pts(this.c);
    return c ? { kind: 'circular', center: c, radius: this.r, start: 0, sweep: TAU } : null;
  }
}

/**
 * 圆弧：圆心 + 起点 + 终点三个点；半径与起终角由点推出（arcGeometry），没有 r 字段。
 * 端点因此是真实的求解自由度，可以像线段端点一样被拾取/拖拽/固定/约束/共享。
 */
export class ArcEntity extends CurveEntityBase {
  readonly type = 'arc' as const;
  readonly label = '圆弧';

  constructor(
    id: number,
    public c: number,
    /** 起点（决定半径与起始角） */
    public a: number,
    /** 终点（决定终止角）；与起点同角/同位置时按整圆处理 */
    public b: number,
    construction = false,
  ) {
    super(id, construction);
  }

  get pointIds(): readonly number[] {
    return [this.c, this.a, this.b];
  }

  override dimTarget(): DimTarget {
    return { kind: 'radius', e: this.id };
  }

  /** 由圆心/起点/终点推导圆弧几何；引用缺失返回 null，只读路径据此跳过 */
  arcGeometry(pts: PointLookup): ArcGeometry | null {
    const center = pts(this.c);
    const start = pts(this.a);
    const end = pts(this.b);
    if (!center || !start || !end) return null;
    return {
      center,
      start,
      end,
      r: vec.dist(center, start),
      a0: Math.atan2(start.y - center.y, start.x - center.x),
      a1: Math.atan2(end.y - center.y, end.x - center.x),
    };
  }

  override pointRole(pointId: number): string | null {
    return super.pointRole(pointId) ?? (pointId === this.a || pointId === this.b ? '端点' : null);
  }

  override radius(pts: PointLookup): number | null {
    return this.arcGeometry(pts)?.r ?? null;
  }

  override structuralResiduals(pts: PointLookup): number[] {
    const g = this.arcGeometry(pts);
    // |终点-圆心| - |起点-圆心| = 0：终点始终落在「圆心 + 起点」确定的圆上
    return g ? [vec.dist(g.end, g.center) - g.r] : [];
  }

  override primitive(pts: PointLookup): EntityPrimitive | null {
    const g = this.arcGeometry(pts);
    return g
      ? {
          kind: 'circular',
          center: g.center,
          radius: g.r,
          start: g.a0,
          // 扫角统一走 sweepOf：起终点同角 = 整圆，与创建/渲染/拾取/导出只有一种解释
          sweep: sweepOf(g.a0, g.a1),
        }
      : null;
  }
}

/**
 * 点图元：可独立绘制、选择、导出的点。
 * 几何坐标仍由被引用的 Point 持有（点的 x/y/fixed 是求解自由度），
 * 本类只负责「这个点是一个图元」：进入图元容器后按图元参与包围盒/导出/删除级联/选择。
 */
export class PointEntity extends EntityBase {
  readonly type = 'point' as const;
  readonly category = 'point' as const;
  readonly label = '点';

  constructor(
    id: number,
    public p: number,
    construction = false,
  ) {
    super(id, construction);
  }

  get pointIds(): readonly number[] {
    return [this.p];
  }

  override get ownedPointId(): number {
    return this.p;
  }

  override primitive(pts: PointLookup): EntityPrimitive | null {
    const p = pts(this.p);
    return p ? { kind: 'dot', at: p } : null;
  }
}

/**
 * 圆/弧类型守卫：instanceof 由子类关系判断（新增曲线子类时自动覆盖），
 * 并顺带收窄 undefined，调用点不必再写 `!e || (e.type !== 'circle' && e.type !== 'arc')`。
 */
export const isCurveEntity = (e: Entity | undefined): e is CurveEntity =>
  e instanceof CurveEntityBase;
