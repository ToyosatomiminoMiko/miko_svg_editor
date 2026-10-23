/**
 * 画布渲染器：网格、图元、点、尺寸标注、预览、框选与吸附标记。
 * 外观（颜色/线宽/虚线/箭头/像素对齐）全部来自构造时注入的 Theme，
 * 主题单一来源是应用样式 src/styles.css 的 :root（theme.ts 只负责读取一次）。
 */

import { cam, gridSize, s2w, w2s } from './camera';
import { TAU, sweepOf } from './config';
import { dimLayout } from './dimensions';
import { getPoint, model, ownedPointIds, primitiveOf } from './model';
import { commandPreview } from './operations';
import {
  isCommandEntity,
  isCommandPoint,
  isCrossing,
  isEntitySelected,
  isPointSelected,
} from './selection';
import { state } from './state';
import type { Theme } from './theme';
import type { Entity } from './entities';
import type { Constraint, Point, Vec } from './types';

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly theme: Theme;

  constructor(canvas: HTMLCanvasElement, theme: Theme) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持 canvas 2d');
    this.canvas = canvas;
    this.ctx = ctx;
    this.theme = theme;
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    cam.viewportW = w;
    cam.viewportH = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  render(): void {
    const { ctx, theme } = this;
    const W = cam.viewportW;
    const H = cam.viewportH;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, W, H);

    this.drawGrid();

    for (const e of model.ents.values()) {
      this.drawEntity(e, this.isSelectedForRender(e), state.hoverEnt === e);
    }
    // 点图元的点由 drawEntity 画成「外环 + 实心中心」，这里跳过，避免同一位置画两遍
    const owned = ownedPointIds();
    for (const p of model.pts.values()) {
      if (owned.has(p.id)) continue;
      this.drawPoint(p, state.hoverPt === p, isPointSelected(p) || isCommandPoint(p));
    }

    for (const c of model.cons.values()) this.drawDim(c);

    this.drawPreview();
    this.drawMarquee();
    this.drawSnapMarker();
  }

  private drawGrid(): void {
    const { ctx, theme } = this;
    const W = cam.viewportW;
    const H = cam.viewportH;
    const g = gridSize();
    const a = s2w({ x: 0, y: 0 });
    const b = s2w({ x: W, y: H });

    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = theme.hairlineWidth;
    ctx.beginPath();
    for (let x = Math.floor(a.x / g) * g; x <= b.x; x += g) {
      const sx = Math.round(w2s({ x, y: 0 }).x) + theme.pixelAlign;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, H);
    }
    for (let y = Math.floor(a.y / g) * g; y <= b.y; y += g) {
      const sy = Math.round(w2s({ x: 0, y }).y) + theme.pixelAlign;
      ctx.moveTo(0, sy);
      ctx.lineTo(W, sy);
    }
    ctx.stroke();

    // 原点十字
    const o = w2s({ x: 0, y: 0 });
    ctx.strokeStyle = theme.axis;
    ctx.beginPath();
    ctx.moveTo(0, o.y + theme.pixelAlign);
    ctx.lineTo(W, o.y + theme.pixelAlign);
    ctx.moveTo(o.x + theme.pixelAlign, 0);
    ctx.lineTo(o.x + theme.pixelAlign, H);
    ctx.stroke();
  }

  /**
   * 图元是否按选中态画。
   * 点图元额外看它的点是否被隐含选中：选中一条直线时，它的端点在界面上是选中态；
   * 若该端点同时被点图元拥有，点图元的高亮必须与点保持一致。
   */
  private isSelectedForRender(e: Entity): boolean {
    if (isEntitySelected(e.id) || isCommandEntity(e)) return true;
    const owned = e.ownedPointId;
    if (owned === null) return false;
    const p = getPoint(owned);
    return p !== undefined && (isPointSelected(p) || isCommandPoint(p));
  }

  private drawEntity(e: Entity, selected: boolean, hovered: boolean): void {
    const { ctx, theme } = this;
    ctx.lineWidth = selected
      ? theme.selectionWidth
      : hovered
        ? theme.strokeWidthHot
        : theme.strokeWidth;
    ctx.strokeStyle = selected
      ? theme.selection
      : hovered
        ? theme.hot
        : e.construction
          ? theme.construction
          : theme.geom;
    ctx.setLineDash(e.construction ? theme.dashConstruction : []);
    ctx.lineCap = 'round';

    // 图元已多态归一到基元：这里只认线段 / 圆弧 / 点三种画法，不再按图元种类 switch
    const prim = primitiveOf(e);
    if (prim) {
      switch (prim.kind) {
        case 'segment': {
          const A = w2s(prim.a);
          const B = w2s(prim.b);
          ctx.beginPath();
          ctx.moveTo(A.x, A.y);
          ctx.lineTo(B.x, B.y);
          ctx.stroke();
          break;
        }
        case 'circular': {
          const C = w2s(prim.center);
          // 圆与圆弧共用同一段画法：整圆只是 sweep = TAU 的圆弧
          ctx.beginPath();
          ctx.arc(C.x, C.y, prim.radius * cam.z, prim.start, prim.start + prim.sweep);
          ctx.stroke();
          break;
        }
        case 'dot': {
          // 点图元画成「外环 + 实心中心」，与线段端点/圆心的小圆点区分；
          // 构造点只留外环（虚线外环），表达「不参与导出实体」的构造语义
          const S = w2s(prim.at);
          const p = e.ownedPointId === null ? undefined : getPoint(e.ownedPointId);
          // 固定点与其他点一致始终显示为红色（选中/悬停也不改色，靠线宽与选择环区分）
          if (p?.fixed) ctx.strokeStyle = theme.pointFixed;
          ctx.beginPath();
          ctx.arc(S.x, S.y, theme.pointGraphicRingRadius, 0, TAU);
          ctx.stroke();
          if (!e.construction) {
            ctx.beginPath();
            ctx.arc(S.x, S.y, theme.pointRadius, 0, TAU);
            ctx.fillStyle = ctx.strokeStyle;
            ctx.fill();
          }
          break;
        }
      }
    }
    ctx.setLineDash([]);
  }

  private drawPoint(p: Point, hovered: boolean, selected: boolean): void {
    const s = w2s(p);
    const { ctx, theme } = this;
    const r = selected
      ? theme.pointSelectedRadius
      : hovered
        ? theme.pointRadiusHot
        : theme.pointRadius;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, TAU);
    ctx.fillStyle = p.fixed
      ? theme.pointFixed
      : selected
        ? theme.selection
        : hovered
          ? theme.hot
          : theme.point;
    ctx.fill();
    if (selected) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + theme.selectedRingExtra, 0, TAU);
      ctx.lineWidth = theme.hairlineWidth;
      ctx.strokeStyle = theme.selection;
      ctx.stroke();
    }
  }

  /** 世界坐标线段（预览用） */
  private lineWorld(a: Vec, b: Vec): void {
    const A = w2s(a);
    const B = w2s(b);
    this.ctx.beginPath();
    this.ctx.moveTo(A.x, A.y);
    this.ctx.lineTo(B.x, B.y);
    this.ctx.stroke();
  }

  /** 屏幕坐标线段（尺寸标注用） */
  private lineScreen(from: Vec, to: Vec): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  /** 从 from 指向 to 画实心三角箭头（屏幕坐标） */
  private arrowScreen(from: Vec, to: Vec): void {
    const { ctx, theme } = this;
    const d = { x: from.x - to.x, y: from.y - to.y };
    const L = Math.hypot(d.x, d.y) || 1;
    const ux = d.x / L;
    const uy = d.y / L;
    const size = theme.arrowSize;
    const w = theme.arrowHalfWidth;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(from.x - ux * size + uy * w, from.y - uy * size - ux * w);
    ctx.lineTo(from.x - ux * size - uy * w, from.y - uy * size + ux * w);
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }

  private drawDim(c: Constraint): void {
    const layout = dimLayout(c, cam);
    if (!layout) return;

    const { ctx, theme } = this;
    ctx.strokeStyle = theme.dim;
    ctx.fillStyle = theme.dim;

    if (layout.kind === 'distance') {
      ctx.lineWidth = theme.hairlineWidth;
      ctx.setLineDash(theme.dashDim);
      this.lineScreen(layout.A, layout.A2);
      this.lineScreen(layout.B, layout.B2);
      ctx.setLineDash([]);
      this.lineScreen(layout.A2, layout.B2);
      this.arrowScreen(layout.A2, layout.B2);
      this.arrowScreen(layout.B2, layout.A2);

      this.drawDimText(layout.text, layout.textPos, 'center');
    } else {
      this.drawDimText(layout.text, layout.textPos, 'left');
    }
  }

  private drawDimText(text: string, pos: Vec, align: CanvasTextAlign): void {
    const { ctx, theme } = this;
    ctx.font = theme.dimFont;
    ctx.textAlign = align;
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, pos.x, pos.y);
  }

  /** 命令预览：操作表给出世界坐标形状，这里只按画布主题画（不再按 pending 类型分叉） */
  private drawPreview(): void {
    const command = state.command;
    if (!command) return;
    const cur = state.snap ? state.snap.pos : state.cursorWorld;
    const shapes = commandPreview(command, cur);
    if (shapes.length === 0) return;
    const { ctx, theme } = this;

    ctx.save();
    ctx.strokeStyle = theme.preview;
    ctx.lineWidth = theme.strokeWidth;
    ctx.setLineDash(theme.dashPreview);

    for (const shape of shapes) {
      switch (shape.kind) {
        case 'line':
          this.lineWorld(shape.a, shape.b);
          break;
        case 'circle': {
          const c = w2s(shape.c);
          ctx.beginPath();
          ctx.arc(c.x, c.y, shape.r * cam.z, 0, TAU);
          ctx.stroke();
          break;
        }
        case 'arc': {
          const c = w2s(shape.c);
          ctx.beginPath();
          // 扫角统一走 sweepOf：同角时预览也画整圆（BUG-10）
          ctx.arc(c.x, c.y, shape.r * cam.z, shape.a0, shape.a0 + sweepOf(shape.a0, shape.a1));
          ctx.stroke();
          break;
        }
        case 'rect': {
          const A = w2s(shape.a);
          const B = w2s(shape.b);
          ctx.strokeRect(A.x, A.y, B.x - A.x, B.y - A.y);
          break;
        }
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** 框选矩形：方向判定与命中判定共用 selection.isCrossing（下→上交叉 / 上→下窗口） */
  private drawMarquee(): void {
    const m = state.marquee;
    if (!m) return;
    const { ctx, theme } = this;
    const crossing = isCrossing(m.s0, m.currentS);
    const x = Math.min(m.s0.x, m.currentS.x);
    const y = Math.min(m.s0.y, m.currentS.y);
    const w = Math.abs(m.currentS.x - m.s0.x);
    const h = Math.abs(m.currentS.y - m.s0.y);

    ctx.save();
    ctx.strokeStyle = crossing ? theme.marqueeCross : theme.marqueeWindow;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = theme.strokeWidth;
    ctx.setLineDash(theme.dashMarquee);
    ctx.globalAlpha = theme.marqueeFillAlpha;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  private drawSnapMarker(): void {
    const snap = state.snap;
    if (!snap) return;
    const { ctx, theme } = this;
    const s = w2s(snap.pos);
    ctx.save();
    ctx.strokeStyle = theme.snap;
    ctx.lineWidth = theme.strokeWidth;
    ctx.beginPath();
    ctx.moveTo(s.x - theme.snapArm, s.y);
    ctx.lineTo(s.x + theme.snapArm, s.y);
    ctx.moveTo(s.x, s.y - theme.snapArm);
    ctx.lineTo(s.x, s.y + theme.snapArm);
    ctx.stroke();
    ctx.restore();
  }
}
