/**
 * 画布渲染器：只负责 canvas/DPR 尺寸管理与一帧的绘制编排（网格 → 图元/点 → 尺寸 → 交互覆盖物）。
 * 具体画法拆在 draw-* 模块，本类把当前相机、主题与交互状态显式传给它们，自身不持有绘制逻辑；
 * 外观（颜色/线宽/虚线/箭头/像素对齐/线帽）全部来自构造时注入的 Theme，
 * 主题单一来源是应用样式 src/styles.css 的 :root（theme.ts 只负责读取一次）。
 *
 * 地图模式的差异全部收在可选的 RendererOptions 里（透明底、不画网格、帧尾回调），
 * 缺省值就是草图模式现状，草图模式零回归。
 */

import { cam } from '../core/camera';
import type { CameraView } from '../core/camera';
import { model, ownedPointIds } from '../core/model';
import { isCommandPoint, isPointSelected } from '../core/selection';
import { state } from '../core/state';
import { drawDim } from './draw-dimensions';
import { drawEntity, drawPoint, isSelectedForRender } from './draw-entities';
import { drawGrid } from './draw-grid';
import { drawMarquee, drawPreview, drawSnapMarker } from './draw-overlays';
import type { Theme } from './theme';

/**
 * 一帧绘制的开关与帧尾钩子。
 * 三项都可省略：省略即草图模式现状（填底色、画网格、不回调）。
 */
export interface RendererOptions {
  /** 是否铺主题底色。地图模式为 false：底图 `<img>` 在 canvas 下面，canvas 必须保持透明 */
  readonly paintBackground?: boolean;
  /** 是否画世界网格。地图模式为 false：底图自己就是背景，网格会盖住地图内容 */
  readonly paintGrid?: boolean;
  /**
   * 一帧绘制结束后的回调（传入当前相机）。
   * 为什么必须有它：底图 `<img>` 的 transform 与 canvas 必须在同一帧内由同一处更新，
   * 否则拖拽/缩放时两张图层会错位；调用方（app/map-mode.ts）把 BaseLayer.sync 注进来。
   */
  readonly onFrame?: (view: CameraView) => void;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly theme: Theme;
  private readonly paintBackground: boolean;
  private readonly paintGrid: boolean;
  private readonly onFrame: ((view: CameraView) => void) | null;

  constructor(canvas: HTMLCanvasElement, theme: Theme, options: RendererOptions = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持 canvas 2d');
    this.canvas = canvas;
    this.ctx = ctx;
    this.theme = theme;
    this.paintBackground = options.paintBackground ?? true;
    this.paintGrid = options.paintGrid ?? true;
    this.onFrame = options.onFrame ?? null;
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
    // resize 也走 render：视口尺寸一落定就触发 onFrame，底图第一帧就被摆到正确位置
    this.render();
  }

  render(): void {
    const { ctx, theme } = this;
    const W = cam.viewportW;
    const H = cam.viewportH;
    // 先清成透明：地图模式不铺底色，只清不填（底图 <img> 从 canvas 下面透出来）
    ctx.clearRect(0, 0, W, H);
    if (this.paintBackground) {
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, W, H);
    }

    if (this.paintGrid) drawGrid(ctx, theme, cam);

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

    // 帧尾：底图与叠加层同帧同步（回调里读到的是本帧绘制用的同一个 cam）
    this.onFrame?.(cam);
  }
}
