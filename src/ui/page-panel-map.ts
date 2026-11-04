/**
 * 出版排版编辑器侧栏的「地图」面板（摆放 x/y/宽、派生高度、图框与刻度样式）。
 *
 * 是什么：构建「地图」面板控件；宽高与图框样式直接写回 layout.map / layout.frame，
 * 派生高度（按底图宽高比算出）写在面板的一行提示里，每次 sync 刷新。
 * 为什么单独成模块：地图摆放与图框/刻度是同一块视觉配置，常量与读写回调集中在这里。
 * 元信息：作者 lead，2026-10-31，从 `ui/page-sidebar.ts` 原样搬出（行为不变）。
 */

import { createControlGroup, create_element } from 'miko_ui';
import type { SidebarContext } from './page-sidebar-context';

/** 构建「地图」面板：摆放 / 图框 / 样式三组控件 */
export function buildMapPanel(body: HTMLElement, ctx: SidebarContext): void {
  const positionRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  ctx.controls.addNumberRow(
    positionRow,
    'map.x',
    'x（pt）',
    () => ctx.getLayout().map.x,
    (value) => ctx.handlers.onChange((layout) => (layout.map.x = value)),
    { step: 1 },
  );
  ctx.controls.addNumberRow(
    positionRow,
    'map.y',
    'y（pt）',
    () => ctx.getLayout().map.y,
    (value) => ctx.handlers.onChange((layout) => (layout.map.y = value)),
    { step: 1 },
  );
  ctx.controls.addNumberRow(
    positionRow,
    'map.width',
    '宽（pt）',
    () => ctx.getLayout().map.width_pt,
    (value) => ctx.handlers.onChange((layout) => (layout.map.width_pt = value)),
    { min: 2, step: 1 },
  );
  body.append(positionRow);
  const mapHeightEl = create_element({ tag: 'p' }, { class: 'page-hint' });
  ctx.setMapHeightEl(mapHeightEl);
  body.append(mapHeightEl);

  const frameRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  ctx.controls.addSwitchRow(
    frameRow,
    'map.frameShow',
    '显示图框',
    () => ctx.getLayout().frame.show,
    (value) => ctx.handlers.onChange((layout) => (layout.frame.show = value)),
  );
  ctx.controls.addSwitchRow(
    frameRow,
    'map.frameTicks',
    '显示刻度',
    () => ctx.getLayout().frame.ticks,
    (value) => ctx.handlers.onChange((layout) => (layout.frame.ticks = value)),
  );
  body.append(createControlGroup('图框', frameRow));

  const frameStyleRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  ctx.controls.addColorRow(
    frameStyleRow,
    'map.stroke',
    '图框颜色',
    () => ctx.getLayout().frame.stroke,
    (value) => ctx.handlers.onChange((layout) => (layout.frame.stroke = value)),
  );
  ctx.controls.addNumberRow(
    frameStyleRow,
    'map.strokeWidth',
    '图框线宽',
    () => ctx.getLayout().frame.width_pt,
    (value) => ctx.handlers.onChange((layout) => (layout.frame.width_pt = value)),
    { min: 0, step: 0.1 },
  );
  ctx.controls.addNumberRow(
    frameStyleRow,
    'map.tickLength',
    '刻度长',
    () => ctx.getLayout().frame.tick_length_pt,
    (value) => ctx.handlers.onChange((layout) => (layout.frame.tick_length_pt = value)),
    { min: 0, step: 0.5 },
  );
  ctx.controls.addNumberRow(
    frameStyleRow,
    'map.tickFont',
    '刻度字号',
    () => ctx.getLayout().frame.tick_font_size_pt,
    (value) => ctx.handlers.onChange((layout) => (layout.frame.tick_font_size_pt = value)),
    { min: 1, step: 0.5 },
  );
  ctx.controls.addNumberRow(
    frameStyleRow,
    'map.tickGap',
    '刻度间距',
    () => ctx.getLayout().frame.tick_gap_pt,
    (value) => ctx.handlers.onChange((layout) => (layout.frame.tick_gap_pt = value)),
    { min: 0, step: 0.5 },
  );
  ctx.controls.addColorRow(
    frameStyleRow,
    'map.tickColor',
    '刻度颜色',
    () => ctx.getLayout().frame.tick_color,
    (value) => ctx.handlers.onChange((layout) => (layout.frame.tick_color = value)),
  );
  body.append(createControlGroup('样式', frameStyleRow));
}
