/**
 * 画布渲染器：只负责 canvas/DPR 尺寸管理与一帧的绘制编排（网格 → 图元/点 → 尺寸 → 交互覆盖物）。
 * 具体画法拆在 draw-* 模块，本类把当前相机、主题与交互状态显式传给它们，自身不持有绘制逻辑；
 * 外观（颜色/线宽/虚线/箭头/像素对齐）全部来自构造时注入的 Theme，
 * 主题单一来源是应用样式 src/styles.css 的 :root（theme.ts 只负责读取一次）。
 */

import { cam } from '../core/camera';
import { model, ownedPointIds } from '../core/model';
import { isCommandPoint, isPointSelected } from '../core/selection';
import { state } from '../core/state';
import { drawDim } from './draw-dimensions';
import { drawEntity, drawPoint, isSelectedForRender } from './draw-entities';
import { drawGrid } from './draw-grid';
import { drawMarquee, drawPreview, drawSnapMarker } from './draw-overlays';
import type { Theme } from './theme';

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

    drawGrid(ctx, theme, cam);

    for (const e of model.ents.values()) {
      drawEntity(ctx, theme, e, isSelectedForRender(e), state.hoverEnt === e, cam);
    }
    // 点图元的点由 drawEntity 画成「外环 + 实心中心」，这里跳过，避免同一位置画两遍
    const owned = ownedPointIds();
    for (const p of model.pts.values()) {
      if (owned.has(p.id)) continue;
      drawPoint(ctx, theme, p, state.hoverPt === p, isPointSelected(p) || isCommandPoint(p), cam);
    }

    for (const c of model.cons.values()) drawDim(ctx, theme, c, cam, state.hoverDim === c);

    const cur = state.snap ? state.snap.pos : state.cursorWorld;
    drawPreview(ctx, theme, state.command, cur, cam);
    drawMarquee(ctx, theme, state.marquee);
    drawSnapMarker(ctx, theme, state.snap, cam);
  }
}
