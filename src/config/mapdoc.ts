/**
 * 地图模式（mapdoc）的常量与默认值。
 *
 * 是什么：地图模式专用的缩放上下限、scene 默认样式、请求 URL、上限与相机适配系数。
 * 为什么集中在这里：地图模式的数值语义是「SVG 用户单位」（约定 1u = 1pt，y 向下），
 * 与草图模式的世界单位不同；把这些量放在 config 层，core/render/ui/app 都只读它，
 * 不各自写字面量，也避免「预览与成品标定不一致」这类漂移。
 * 本轮不做文字注记（P3），style 里的 font_* 字段保留是为了 scene 契约向前兼容。
 */

import type { SceneStyle } from '../core/scene';

/** 地图模式缩放下限：底图 1 用户单位 = 1 CSS px @z=1，再小就只是缩小预览 */
export const MAPDOC_ZOOM_MIN = 0.1;

/**
 * 地图模式缩放上限：只做 CSS transform、不做重排。
 * z=8 时 1265.85pt 宽的底图要 284 Mpx 光栅（DPR2），浏览器无法重栅格化；
 * 底图本身含内嵌栅格，>1× 已经在放大位图，已知限制见 docs/merge/DESIGN.md §4.2。
 */
export const MAPDOC_ZOOM_MAX = 8;

/** scene 文档格式标识与版本：版本必须精确匹配，新增可选字段也升版本 */
export const MAPDOC_SCENE_FORMAT = 'mapdoc-scene';
export const MAPDOC_SCENE_VERSION = 1;

/** 单个容器的数量上限（与 Python 侧 scene.py 的校验保持一致） */
export const MAPDOC_MAX_ITEMS = 2000;

/** 规范化数值的小数位（服务器写盘口径；浏览器只提交语义值） */
export const MAPDOC_DECIMALS = 3;

/** 残差告警阈值（pt 量级）：必须大于 3 位小数精度造成的抖动，避免「打开即告警」 */
export const MAPDOC_RESIDUAL_WARN = 0.02;

/** studio 端点（开发期由 vite 代理到 studio） */
export const MAPDOC_DOC_URL = '/api/doc';
export const MAPDOC_SCENE_URL = '/api/scene';
export const MAPDOC_COMPOSE_URL = '/api/compose';
export const MAPDOC_HEALTH_URL = '/api/health';
export const MAPDOC_BASE_URL = '/base.svg';
export const MAPDOC_FINAL_URL = '/final.svg';

/** 一次 API 请求的超时（毫秒）：合成是秒级，重渲染不在本进程内做 */
export const MAPDOC_REQUEST_TIMEOUT_MS = 15000;

/** 场景级默认样式（与 Python 侧 style 校验的取值范围一致） */
export const MAPDOC_STYLE_DEFAULTS: SceneStyle = {
  stroke: '#c62828',
  stroke_width_pt: 1,
  construction_dash_pt: [4, 4],
  point_radius_pt: 1.6,
  font_family: 'Noto Sans Mono CJK SC',
  font_size_pt: 9,
  text_color: '#111111',
};
