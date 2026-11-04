/**
 * 所有元素共有的属性字段：坐标空间（page/map）与 x/y。
 *
 * 是什么：属性面板顶部的通用字段，按元素 kind 无关的 `PageItem` 基础字段构建。
 * 为什么单独成模块：text/legend/colorbar 三类字段都依赖它，拆开避免三类字段模块互相 import。
 * 元信息：作者 lead，2026-10-31，从 `ui/page-sidebar.ts` 原样搬出（行为不变）。
 */

import { createControlGroup, create_element, createSegmented } from 'miko_ui';
import { itemById, type ItemSpace, type PageItem } from '../core/page';
import type { SidebarContext } from './page-sidebar-context';

/** 通用字段：坐标空间 + x/y（map 空间写回底图坐标） */
export function buildCommonItemFields(ctx: SidebarContext, item: PageItem): HTMLElement {
  const container = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  const spaceSegmented = createSegmented<ItemSpace>({
    columns: 2,
    ariaLabel: '坐标空间',
    value: item.space,
    items: [
      { value: 'page', label: '纸张坐标' },
      { value: 'map', label: '底图坐标' },
    ],
  });
  spaceSegmented.onChange((space) =>
    ctx.handlers.onChange((layout) => {
      const target = itemById(layout, item.id);
      if (target) target.space = space;
    }),
  );
  ctx.controls.registerSegmented(
    'prop.space',
    () => itemById(ctx.getLayout(), item.id)?.space ?? 'page',
    (value) => spaceSegmented.set(value as ItemSpace),
  );
  container.append(createControlGroup('坐标空间', spaceSegmented.element));

  const positionRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  ctx.controls.addNumberRow(
    positionRow,
    'prop.x',
    item.space === 'map' ? 'x（底图）' : 'x（pt）',
    () => itemById(ctx.getLayout(), item.id)?.x ?? 0,
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target) target.x = value;
      }),
    { step: 1 },
  );
  ctx.controls.addNumberRow(
    positionRow,
    'prop.y',
    item.space === 'map' ? 'y（底图）' : 'y（pt）',
    () => itemById(ctx.getLayout(), item.id)?.y ?? 0,
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target) target.y = value;
      }),
    { step: 1 },
  );
  container.append(positionRow);
  return container;
}
