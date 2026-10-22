/**
 * 视图控制：适应视图、滚轮缩放、平移。
 * viewport.ts 是 cam 的交互写入口（resize 只写视口尺寸由 renderer 负责）；
 * camera.ts 保留纯坐标变换与 clampZoom。
 */

import { cam, clampZoom, s2w, zoomAt } from './camera';
import { DEFAULT_ZOOM, DRAG_THRESHOLD_PX, FIT_VIEW_FILL, WHEEL_ZOOM_SENSITIVITY } from './config';
import { sketchBounds } from './geometry';
import { state } from './state';
import type { Vec } from './types';

/** 适应视图：图形包围盒（含留白）按 FIT_VIEW_FILL 铺满视口；空草图回到默认缩放与原点 */
export function fitView(): void {
  const bb = sketchBounds();
  if (!bb || cam.viewportW <= 0 || cam.viewportH <= 0) {
    cam.x = 0;
    cam.y = 0;
    cam.z = DEFAULT_ZOOM;
    return;
  }
  cam.z = clampZoom(Math.min(cam.viewportW / bb.bw, cam.viewportH / bb.bh) * FIT_VIEW_FILL);
  cam.x = (bb.minx + bb.maxx) / 2;
  cam.y = (bb.miny + bb.maxy) / 2;
}

/**
 * 滚轮缩放：以指针所在屏幕点为锚点。
 * 缩放会改变指针下的世界坐标，必须同步 state.cursorWorld，
 * 否则预览会停在旧世界点直到下次 pointermove（P3）。
 */
export function wheelZoom(sp: Vec, deltaY: number): void {
  zoomAt(sp, Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY));
  state.cursorWorld = s2w(sp);
}

/** 平移手势的锚点：按下时的屏幕点与相机快照 */
export interface PanAnchor {
  sx: number;
  sy: number;
  cx: number;
  cy: number;
  /** 位移超过拖拽阈值后为 true，用于区分「平移」与「右键点击取消」 */
  moved: boolean;
}

export function beginPan(sp: Vec): PanAnchor {
  return { sx: sp.x, sy: sp.y, cx: cam.x, cy: cam.y, moved: false };
}

/** 应用平移：相机按屏幕位移反向移动（除以缩放换算成世界单位） */
export function applyPan(pan: PanAnchor, sp: Vec): void {
  const dx = sp.x - pan.sx;
  const dy = sp.y - pan.sy;
  if (!pan.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) pan.moved = true;
  cam.x = pan.cx - dx / cam.z;
  cam.y = pan.cy - dy / cam.z;
}
