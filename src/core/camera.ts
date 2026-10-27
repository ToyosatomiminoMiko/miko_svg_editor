/**
 * 视图/相机。
 * 世界坐标 y 向下（与 SVG 一致）；cam.x / cam.y 是画布中心对应的世界坐标。
 * 纯逻辑模块不直接读全局 cam：几何用 zoom 参数、尺寸布局用 CameraView 快照。
 */

import {
  DEFAULT_ZOOM,
  GRID_BASE,
  GRID_MAX_PX,
  GRID_MIN_PX,
  GRID_STEP_FACTOR,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../config';
import type { Vec } from './types';

/** 相机快照：世界 ↔ 屏幕换算只需要这些字段 */
export interface CameraView {
  x: number;
  y: number;
  z: number;
  viewportW: number;
  viewportH: number;
}

/** 当前视图的状态；只经 viewport 的 fitView/zoomAt/applyPan 与 renderer.resize 修改 */
type Camera = CameraView;

export const cam: Camera = {
  x: 0,
  y: 0,
  z: DEFAULT_ZOOM,
  viewportW: 0,
  viewportH: 0,
};

/**
 * 当前生效的缩放上下限。
 * 为什么是可改的单例而不是参数：`zoomAt`/`fitView`/`fitBounds` 都会经由 `clampZoom`
 * 收口，多传一个参数会扩散到所有调用点；地图模式与草图模式是两种「同时只存在一个」的
 * 编辑会话（单图单文档），在组合根里切换一次范围即可，无需逐调用传参。
 */
let zoomMin = ZOOM_MIN;
let zoomMax = ZOOM_MAX;

/** 设置缩放上下限（地图模式用 MAPDOC_ZOOM_MIN/MAX；参数非法时忽略） */
export const setZoomRange = (min: number, max: number): void => {
  if (!(min > 0) || !(max >= min)) return;
  zoomMin = min;
  zoomMax = max;
};

/** 恢复草图模式的默认缩放上下限 */
export const resetZoomRange = (): void => {
  zoomMin = ZOOM_MIN;
  zoomMax = ZOOM_MAX;
};

export const clampZoom = (zoom: number): number => Math.min(zoomMax, Math.max(zoomMin, zoom));

/** 世界坐标 → 屏幕坐标 */
export const w2s = (p: Vec, view: CameraView = cam): Vec => ({
  x: (p.x - view.x) * view.z + view.viewportW / 2,
  y: (p.y - view.y) * view.z + view.viewportH / 2,
});

/** 屏幕坐标 → 世界坐标 */
export const s2w = (p: Vec, view: CameraView = cam): Vec => ({
  x: (p.x - view.viewportW / 2) / view.z + view.x,
  y: (p.y - view.viewportH / 2) / view.z + view.y,
});

/** 以屏幕点 sp 为锚点缩放，保证锚点下的世界坐标不动 */
export function zoomAt(sp: Vec, factor: number): void {
  const before = s2w(sp);
  cam.z = clampZoom(cam.z * factor);
  const after = s2w(sp);
  cam.x += before.x - after.x;
  cam.y += before.y - after.y;
}

/** 网格间距取 10 的 2 倍幂，使屏幕间距保持在 [GRID_MIN_PX, GRID_MAX_PX] */
export function gridSize(zoom: number = cam.z): number {
  let g = GRID_BASE;
  while (g * zoom < GRID_MIN_PX) g *= GRID_STEP_FACTOR;
  while (g * zoom > GRID_MAX_PX) g /= GRID_STEP_FACTOR;
  return g;
}
