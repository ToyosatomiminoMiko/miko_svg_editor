/**
 * 地图模式主题：在草图主题上覆盖「必须与冻结底图成品一致」的差异项。
 *
 * 是什么：`mapTheme(base, style)` 返回一份新的 Theme：
 * - 线帽改成 butt（底图全局 `stroke-linecap:butt`，A6；canvas 默认圆头会让端点比成品
 *   多出半个线宽的半圆，预览与成品对不齐）；
 * - 几何颜色/线宽/点半径取自场景级样式（`core/scene.ts` 的 `mapStyle`，来自 scene.json，
 *   Python 合成 final.svg 时用的是同一份）——预览与成品同源，避免「画布蓝线、成品红线」。
 *
 * 已知偏离（本轮"先试试"的显式取舍）：线宽与点半径按用户单位 1:1 当屏幕像素用，
 * 没有乘 cam.z；高倍放大时成品的线会比预览更粗。设计 §4.1 要求「用户单位长度量 × cam.z」
 * 的统一换算入口，那是 P3 的活（draw-* 全量改造），本轮只保证颜色/线帽一致。
 *
 * 元信息：作者 fe-render-ui / lead，2026-10-27 随地图模式竖切片加入（impl-contract.md §6）。
 */

import type { SceneStyle } from '../core/scene';
import type { Theme } from './theme';

/** 地图模式主题：线帽 butt；几何配色/线宽/点半径来自场景样式；其余沿用 base */
export function mapTheme(base: Theme, style: SceneStyle): Theme {
  return {
    ...base,
    lineCap: 'butt',
    geom: style.stroke,
    // 构造线只靠虚线区分（虚线值见 theme.dashConstruction）；不给颜色叠 alpha，
    // 否则预览的构造线与成品（纯色 + dasharray）仍然不一致
    construction: style.stroke,
    strokeWidth: style.stroke_width_pt,
    pointRadius: style.point_radius_pt,
    pointGraphicRingRadius: Math.max(3, style.point_radius_pt * 2.4),
  };
}
