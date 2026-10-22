/**
 * 画布渲染器：网格、图元、点、尺寸标注、预览与吸附标记。
 * 所有颜色/线宽来自 theme.ts（即 styles.css 的 CSS 变量）。
 */

import { cam, gridSize, s2w, w2s } from './camera';
import { E, P, ends, model } from './model';
import { state } from './state';
import { readTheme, type Theme } from './theme';
import { vec } from './vec';
import type { Constraint, Entity, Point, Vec } from './types';

const fmt = (v: number): string => (Math.abs(v) < 1e-9 ? '0' : (+v.toFixed(2)).toString());

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly theme: Theme;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持 canvas 2d');
    this.canvas = canvas;
    this.ctx = ctx;
    this.theme = readTheme();
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    cam.W = w;
    cam.H = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  render(): void {
    const { ctx } = this;
    const W = cam.W;
    const H = cam.H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, W, H);

    this.drawGrid();

    for (const e of model.ents.values()) {
      this.drawEntity(e, state.sel.includes(e.id), state.hoverEnt === e);
    }
    for (const p of model.pts.values()) {
      this.drawPoint(p, p === state.hoverPt, this.isPointSelected(p));
    }

    for (const c of model.cons.values()) this.drawDim(c);

    this.drawPreview();
    this.drawMarquee();
    this.drawSnapMarker();
  }

  private drawGrid(): void {
    const { ctx, theme } = this;
    const g = gridSize();
    const a = s2w({ x: 0, y: 0 });
    const b = s2w({ x: cam.W, y: cam.H });

    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(a.x / g) * g; x <= b.x; x += g) {
      const sx = Math.round(w2s({ x, y: 0 }).x) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, cam.H);
    }
    for (let y = Math.floor(a.y / g) * g; y <= b.y; y += g) {
      const sy = Math.round(w2s({ x: 0, y }).y) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(cam.W, sy);
    }
    ctx.stroke();

    // 原点十字
    const o = w2s({ x: 0, y: 0 });
    ctx.strokeStyle = theme.axis;
    ctx.beginPath();
    ctx.moveTo(0, o.y + 0.5);
    ctx.lineTo(cam.W, o.y + 0.5);
    ctx.moveTo(o.x + 0.5, 0);
    ctx.lineTo(o.x + 0.5, cam.H);
    ctx.stroke();
  }

  private isPointSelected(p: Point): boolean {
    // 直接选中的点，或选中图元的端点，都画成选中态
    if (state.sel.includes(p.id)) return true;
    for (const id of state.sel) {
      const e = E(id);
      if (!e) continue;
      if (e.type === 'line' ? e.a === p.id || e.b === p.id : e.c === p.id) return true;
    }
    return false;
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
    ctx.setLineDash(e.construction ? [5, 5] : []);
    ctx.lineCap = 'round';

    if (e.type === 'line') {
      const [a, b] = ends(e);
      const A = w2s(a);
      const B = w2s(b);
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.lineTo(B.x, B.y);
      ctx.stroke();
    } else {
      const c = P(e.c);
      if (!c) return;
      const C = w2s(c);
      ctx.beginPath();
      if (e.type === 'circle') {
        ctx.arc(C.x, C.y, Math.abs(e.r) * cam.z, 0, Math.PI * 2);
      } else {
        ctx.arc(C.x, C.y, Math.abs(e.r) * cam.z, e.a0, e.a1);
      }
      ctx.stroke();
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
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
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
      ctx.arc(s.x, s.y, r + 2, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = theme.selection;
      ctx.stroke();
    }
  }

  private lineW(a: Vec, b: Vec): void {
    const A = w2s(a);
    const B = w2s(b);
    this.ctx.beginPath();
    this.ctx.moveTo(A.x, A.y);
    this.ctx.lineTo(B.x, B.y);
    this.ctx.stroke();
  }

  /** 从 from 指向 to 画箭头（实心三角） */
  private arrowW(from: Vec, to: Vec): void {
    const { ctx } = this;
    const A = w2s(from);
    const B = w2s(to);
    const d = { x: A.x - B.x, y: A.y - B.y };
    const L = Math.hypot(d.x, d.y) || 1;
    const ux = d.x / L;
    const uy = d.y / L;
    const size = 8;
    const w = 3;
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(A.x - ux * size + uy * w, A.y - uy * size - ux * w);
    ctx.lineTo(A.x - ux * size - uy * w, A.y - uy * size + ux * w);
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }

  private drawDim(c: Constraint): void {
    const { ctx, theme } = this;
    if (c.type === 'distancePP') {
      const a = P(c.a);
      const b = P(c.b);
      if (!a || !b) return;
      const d = vec.sub(b, a);
      const L = vec.len(d) || 1;
      const nrm = { x: -d.y / L, y: d.x / L };
      const off = c.offset ?? 0;
      const A = { x: a.x + nrm.x * off, y: a.y + nrm.y * off };
      const B = { x: b.x + nrm.x * off, y: b.y + nrm.y * off };

      ctx.strokeStyle = theme.dim;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      this.lineW(a, A);
      this.lineW(b, B);
      ctx.setLineDash([]);
      this.lineW(A, B);
      this.arrowW(A, B);
      this.arrowW(B, A);

      const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      const s = w2s(mid);
      ctx.font = theme.dimFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = theme.dim;
      ctx.fillText(fmt(c.d ?? 0), s.x, s.y - 4);
    } else if (c.type === 'radius') {
      const e = E(c.e);
      if (!e || e.type === 'line') return;
      const cc = P(e.c);
      if (!cc) return;
      const s = w2s(cc);
      ctx.font = theme.dimFont;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = theme.dim;
      ctx.fillText('R' + fmt(e.r), s.x + 8, s.y - 8);
    }
  }

  private drawPreview(): void {
    const p = state.pending;
    if (!p) return;
    const cur = state.snap ? state.snap.pos : state.cursorW;
    const { ctx, theme } = this;

    ctx.save();
    ctx.strokeStyle = theme.preview;
    ctx.lineWidth = theme.strokeWidth;
    ctx.setLineDash([5, 4]);

    switch (p.type) {
      case 'line':
        this.lineW(p.start, cur);
        break;
      case 'circle': {
        const c = P(p.center);
        if (c) {
          const s = w2s(c);
          ctx.beginPath();
          ctx.arc(s.x, s.y, vec.dist(c, cur) * cam.z, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
      case 'rect': {
        const A = w2s(p.p0);
        const B = w2s(cur);
        ctx.strokeRect(A.x, A.y, B.x - A.x, B.y - A.y);
        break;
      }
      case 'arc': {
        const c = P(p.c);
        if (!c) break;
        const s = w2s(c);
        if (p.stage === 1) {
          ctx.beginPath();
          ctx.arc(s.x, s.y, vec.dist(c, cur) * cam.z, 0, Math.PI * 2);
          ctx.stroke();
        } else if (p.r !== undefined && p.a0 !== undefined) {
          const a1 = Math.atan2(cur.y - c.y, cur.x - c.x);
          let sw = a1 - p.a0;
          while (sw < 0) sw += Math.PI * 2;
          ctx.beginPath();
          ctx.arc(s.x, s.y, p.r * cam.z, p.a0, p.a0 + sw);
          ctx.stroke();
        }
        break;
      }
      case 'dim': {
        const a = P(p.a);
        if (a) this.lineW(a, cur);
        break;
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** 框选矩形：由下往上拖是交叉选择，由上往下是窗口选择，用颜色区分 */
  private drawMarquee(): void {
    const m = state.marquee;
    if (!m) return;
    const { ctx, theme } = this;
    const A = w2s(m.a);
    const B = w2s(m.b);
    const x = Math.min(A.x, B.x);
    const y = Math.min(A.y, B.y);
    const w = Math.abs(B.x - A.x);
    const h = Math.abs(B.y - A.y);
    const crossing = m.b.y < m.a.y;

    ctx.save();
    ctx.strokeStyle = crossing ? theme.marqueeCross : theme.marqueeWindow;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = theme.strokeWidth;
    ctx.setLineDash([4, 3]);
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
