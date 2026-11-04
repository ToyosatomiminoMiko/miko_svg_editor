/**
 * 色标元素的属性字段：标题/单位/宽高/字号与「显示标题/显示刻度」开关。
 *
 * 是什么：选中 colorbar 元素时构建的属性面板片段；配色与刻度来自 geo.relief，不落 layout。
 * 为什么单独成模块：色标字段是一组固定尺寸 + 两个显隐开关，独立后与图例/文字互不影响。
 * 元信息：作者 lead，2026-10-31，从 `ui/page-sidebar.ts` 原样搬出（行为不变）。
 */

import { createControlGroup, create_element } from 'miko_ui';
import { PAGE_COLORBAR_HEIGHT_PT, PAGE_COLORBAR_WIDTH_PT } from '../config/page';
import { itemById, type ColorbarItem } from '../core/page';
import type { SidebarContext } from './page-sidebar-context';

/** 色标属性面板片段（标题/单位/尺寸/字号 + 显示开关） */
export function buildColorbarFields(ctx: SidebarContext, item: ColorbarItem): HTMLElement[] {
  const fragments: HTMLElement[] = [];
  const basics = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  ctx.controls.addTextRow(
    basics,
    'prop.cbarTitle',
    '标题',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'colorbar' ? target.title : '';
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'colorbar') target.title = value;
      }),
  );
  ctx.controls.addTextRow(
    basics,
    'prop.cbarUnit',
    '单位',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'colorbar' ? target.unit : '';
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'colorbar') target.unit = value;
      }),
  );
  ctx.controls.addNumberRow(
    basics,
    'prop.cbarWidth',
    '宽（pt）',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'colorbar' ? target.width_pt : PAGE_COLORBAR_WIDTH_PT;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'colorbar') target.width_pt = value;
      }),
    { min: 1, step: 1 },
  );
  ctx.controls.addNumberRow(
    basics,
    'prop.cbarHeight',
    '高（pt）',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'colorbar' ? target.height_pt : PAGE_COLORBAR_HEIGHT_PT;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'colorbar') target.height_pt = value;
      }),
    { min: 1, step: 1 },
  );
  ctx.controls.addNumberRow(
    basics,
    'prop.cbarTitleSize',
    '标题字号',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'colorbar' ? target.title_size_pt : 8;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'colorbar') target.title_size_pt = value;
      }),
    { min: 0.5, step: 0.5 },
  );
  ctx.controls.addNumberRow(
    basics,
    'prop.cbarLabelSize',
    '刻度字号',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'colorbar' ? target.label_size_pt : 7;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'colorbar') target.label_size_pt = value;
      }),
    { min: 0.5, step: 0.5 },
  );
  fragments.push(createControlGroup('色标', basics));

  const switches = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  ctx.controls.addSwitchRow(
    switches,
    'prop.cbarShowTitle',
    '显示标题',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'colorbar' ? target.show_title : true;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'colorbar') target.show_title = value;
      }),
  );
  ctx.controls.addSwitchRow(
    switches,
    'prop.cbarShowTicks',
    '显示刻度',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'colorbar' ? target.show_ticks : true;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'colorbar') target.show_ticks = value;
      }),
  );
  fragments.push(createControlGroup('显示', switches));
  fragments.push(
    create_element(
      { tag: 'p' },
      { class: 'page-hint' },
      '配色与刻度来自 geo.relief，不落 layout。',
    ),
  );
  return fragments;
}
