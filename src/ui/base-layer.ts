/**
 * 冻结底图层：把 Python 渲染出来的 base.svg 当**普通图片**挂进画布格，并跟随相机做 CSS 变换。
 *
 * 是什么：在宿主里建一个 `<img class="app-map-base">`，`setBase()` 写入 src 与 CSS 宽高，
 * `sync(view)` 每帧写 `translate(w2s(0,0)) scale(cam.z)`。
 * 为什么用 `<img>` 而不是内联 SVG：SVG 作为图片是独立渲染树，页面 CSS/字体不影响它，
 * 更关键的是页面 DOM 里根本不存在地理节点——编辑器在物理上改不到底图（设计 D3 硬边界）。
 * 本文件因此只碰 img 的 src/style，**不解析、不取 SVG DOM、不改它的任何节点**。
 * 为什么 transform-origin 必须 0 0：底图用户单位与 canvas 屏幕坐标共用同一原点（左上），
 * 若绕图片中心缩放，`translate + scale` 的组合会整体漂移（变换顺序：先 scale 再 translate，
 * 元素内点 p 映射到 translate + p×z；原点不在 0 0 时还多一项中心偏移）。
 * 为什么 1 用户单位 = 1 CSS px：z=1 时底图按文档尺寸 pt 值铺开，与 `w2s` 的
 * `(u - cam.x) * z + viewport/2` 精确对齐；DPR 由 canvas 内部的 setTransform 消化。
 *
 * 元信息：作者 fe-render-ui，2026-10-27 随地图模式竖切片加入（impl-contract.md §6）。
 */

import { create_element } from 'miko_ui';
import { w2s } from '../core/camera';
import type { CameraView } from '../core/camera';

/** 底图声明：URL 与文档尺寸（用户单位，契约约定 1u = 1pt = 1 CSS px @z=1） */
export interface BaseInfo {
  readonly url: string;
  readonly width_pt: number;
  readonly height_pt: number;
}

export class BaseLayer {
  private readonly img: HTMLImageElement;
  /**
   * 最近一次同步的相机：`setBase()` 可能晚于首帧（先建层再拉 /api/doc），
   * 记住它可以让图片一设好就落在正确位置，而不是先闪到左上角等下一次渲染。
   */
  private lastView: CameraView | null = null;

  /** @param host 底图宿主（`.app-map-host`，网格里与 canvas 同一格、垫在 canvas 下面） */
  constructor(host: HTMLElement) {
    // 纯装饰性背景图：alt 留空 + aria-hidden，读屏只读 canvas 的语义
    this.img = create_element(
      { tag: 'img', into: host },
      { class: 'app-map-base', alt: '', 'aria-hidden': 'true', draggable: 'false' },
    );
  }

  /** 设底图与它的 CSS 尺寸（px 数值直接取 pt 值，见文件头「1 用户单位 = 1 CSS px」） */
  setBase(info: BaseInfo): void {
    this.img.src = info.url;
    this.img.style.width = `${info.width_pt}px`;
    this.img.style.height = `${info.height_pt}px`;
    if (this.lastView) this.apply(this.lastView);
  }

  /** 相机同步：由 Renderer 的 onFrame 每帧调用，保证底图与 canvas 同帧、同一相机 */
  sync(view: CameraView): void {
    this.lastView = view;
    this.apply(view);
  }

  /**
   * 把世界原点映射到屏幕并整体缩放。
   * CSS transform 函数从右往左作用：元素内点 p → scale(p) → translate，
   * 所以屏幕坐标 = w2s(0,0) + p × z，与 canvas 的 w2s 完全同型。
   */
  private apply(view: CameraView): void {
    const origin = w2s({ x: 0, y: 0 }, view);
    this.img.style.transform = `translate(${origin.x}px, ${origin.y}px) scale(${view.z})`;
  }
}
