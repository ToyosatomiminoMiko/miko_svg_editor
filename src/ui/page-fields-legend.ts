/**
 * 图例元素的属性字段:尺寸/字号/内边距/色块,外框,以及图例条目编辑.
 *
 * 是什么:选中 legend 元素时构建的属性面板片段.条目编辑的「隐藏」不是 layout 字段:
 * 契约 §4.1 的条目没有 visible,隐藏 = 从 layout 移除并记进侧栏会话状态,重新显示时按
 * 原位置插回(不会写进 layout).
 * 为什么单独成模块:图例字段与条目增删/显隐是这里最长的一块逻辑,独立后便于单独阅读与修改.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import {
  createButton,
  createControlGroup,
  create_element,
  createSwitch,
  nextWidgetId,
} from 'miko_ui';
import { PAGE_LEGEND_DEFAULTS, PAGE_NEW_LEGEND_WIDTH_MM } from '../config/page';
import { itemById, type LegendEntry, type LegendItem } from '../core/page';
import type { SidebarContext } from './page-sidebar-context';

/** 新建图例条目的默认形状 */
function defaultLegendEntry(): LegendEntry {
  return {
    label: '新条目',
    shape: 'line',
    stroke: '#4a4a4a',
    width_mm: 1,
    dash: null,
    fill: null,
    opacity: 1,
    marker: null,
  };
}

/** 图例条目的中文形状名(UI 只用) */
const SHAPE_LABELS: Readonly<Record<LegendEntry['shape'], string>> = {
  line: '线',
  rect: '块',
  point: '点',
};

/** 图例属性面板片段(图例尺寸 + 外框 + 条目) */
export function buildLegendFields(ctx: SidebarContext, item: LegendItem): HTMLElement[] {
  const fragments: HTMLElement[] = [];

  const basics = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  ctx.controls.addTextRow(
    basics,
    'prop.legendTitle',
    '标题',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'legend' ? target.title : '';
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'legend') target.title = value;
      }),
  );
  ctx.controls.addNumberRow(
    basics,
    'prop.legendWidth',
    '宽度(mm)',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'legend' ? target.width_mm : PAGE_NEW_LEGEND_WIDTH_MM;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'legend') target.width_mm = value;
      }),
    { min: 1, step: 1 },
  );
  ctx.controls.addNumberRow(
    basics,
    'prop.legendFont',
    '字号(mm)',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'legend' ? target.font_size_mm : PAGE_LEGEND_DEFAULTS.font_size_mm;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'legend') target.font_size_mm = value;
      }),
    { min: 0.5, step: 0.5 },
  );
  ctx.controls.addNumberRow(
    basics,
    'prop.legendTitleSize',
    '标题字号',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'legend' ? target.title_size_mm : PAGE_LEGEND_DEFAULTS.title_size_mm;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'legend') target.title_size_mm = value;
      }),
    { min: 0.5, step: 0.5 },
  );
  ctx.controls.addNumberRow(
    basics,
    'prop.legendRowHeight',
    '行高(mm)',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'legend' ? target.row_height_mm : PAGE_LEGEND_DEFAULTS.row_height_mm;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'legend') target.row_height_mm = value;
      }),
    { min: 1, step: 1 },
  );
  ctx.controls.addNumberRow(
    basics,
    'prop.legendPadding',
    '内边距',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'legend' ? target.padding_mm : PAGE_LEGEND_DEFAULTS.padding_mm;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'legend') target.padding_mm = value;
      }),
    { min: 0, step: 0.5 },
  );
  ctx.controls.addNumberRow(
    basics,
    'prop.legendSwatch',
    '色块宽',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'legend'
        ? target.swatch_width_mm
        : PAGE_LEGEND_DEFAULTS.swatch_width_mm;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'legend') target.swatch_width_mm = value;
      }),
    { min: 1, step: 1 },
  );
  ctx.controls.addNumberRow(
    basics,
    'prop.legendGap',
    '色块间距',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'legend' ? target.swatch_gap_mm : PAGE_LEGEND_DEFAULTS.swatch_gap_mm;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'legend') target.swatch_gap_mm = value;
      }),
    { min: 0, step: 1 },
  );
  fragments.push(createControlGroup('图例', basics));

  const frameRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  ctx.controls.addSwitchRow(
    frameRow,
    'prop.legendFrameShow',
    '显示外框',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'legend' ? target.frame.show : true;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'legend') target.frame.show = value;
      }),
  );
  ctx.controls.addColorRow(
    frameRow,
    'prop.legendFrameStroke',
    '外框颜色',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'legend' ? target.frame.stroke : '#bbbbbb';
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'legend') target.frame.stroke = value;
      }),
  );
  ctx.controls.addColorRow(
    frameRow,
    'prop.legendFrameFill',
    '底色',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'legend' ? target.frame.fill : '#ffffff';
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'legend') target.frame.fill = value;
      }),
  );
  ctx.controls.addNumberRow(
    frameRow,
    'prop.legendFrameWidth',
    '框线宽',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'legend' ? target.frame.width_mm : 0.8;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'legend') target.frame.width_mm = value;
      }),
    { min: 0, step: 0.1 },
  );
  ctx.controls.addNumberRow(
    frameRow,
    'prop.legendFrameOpacity',
    '底色透明度',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'legend' ? target.frame.opacity : 0.94;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'legend') target.frame.opacity = value;
      }),
    { min: 0, max: 1, step: 0.01 },
  );
  fragments.push(createControlGroup('外框', frameRow));

  fragments.push(buildLegendEntries(ctx, item));
  return fragments;
}

/** 图例条目编辑:label / 显隐 / 删除 / 新增(隐藏 = 从 layout 移除,会话内记住) */
function buildLegendEntries(ctx: SidebarContext, item: LegendItem): HTMLElement {
  const container = create_element({ tag: 'div' }, { class: 'page-legend-entries' });
  const list = create_element({ tag: 'div' }, { class: 'page-legend-list' });
  const hidden = ctx.hiddenLegendEntries.get(item.id) ?? [];

  item.entries.forEach((entry, index) => {
    const row = create_element({ tag: 'div' }, { class: 'page-legend-row' });
    const input = create_element(
      { tag: 'input' },
      { class: 'page-legend-label', type: 'text', value: entry.label },
    );
    input.id = nextWidgetId('page-legend');
    input.addEventListener('input', () => {
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind !== 'legend') return;
        const current = target.entries[index];
        if (current) current.label = input.value;
      });
    });
    ctx.controls.registerText(`prop.entryLabel.${index}`, input, () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'legend' ? (target.entries[index]?.label ?? '') : '';
    });
    row.append(
      create_element({ tag: 'span' }, { class: 'page-legend-shape' }, SHAPE_LABELS[entry.shape]),
      input,
    );

    const visible = createSwitch({ value: true });
    visible.input.title = '隐藏该条目(从 layout 移除,可再次显示)';
    visible.onChange(() => hideLegendEntry(ctx, item.id, index));
    row.append(visible.element);

    const remove = createButton({ text: '×', title: '删除条目', class: 'page-icon-button' });
    remove.onClick(() => deleteLegendEntry(ctx, item.id, index));
    row.append(remove.element);
    list.append(row);
  });

  hidden.forEach((stored, hiddenIndex) => {
    const row = create_element({ tag: 'div' }, { class: 'page-legend-row is-hidden' });
    row.append(
      create_element(
        { tag: 'span' },
        { class: 'page-legend-shape' },
        SHAPE_LABELS[stored.entry.shape],
      ),
      create_element({ tag: 'span' }, { class: 'page-legend-label' }, stored.entry.label),
    );
    const visible = createSwitch({ value: false });
    visible.input.title = '重新显示该条目';
    visible.onChange(() => showLegendEntry(ctx, item.id, hiddenIndex));
    row.append(visible.element);

    const remove = createButton({ text: '×', title: '删除隐藏条目', class: 'page-icon-button' });
    remove.onClick(() => {
      const entries = ctx.hiddenLegendEntries.get(item.id);
      if (!entries) return;
      entries.splice(hiddenIndex, 1);
      ctx.requestPropertyRebuild();
    });
    row.append(remove.element);
    list.append(row);
  });

  container.append(
    create_element(
      { tag: 'p' },
      { class: 'page-hint' },
      `条目按数组顺序绘制;契约没有 visible 字段,隐藏条目不会写进 layout.`,
    ),
    list,
  );

  const addButton = createButton({ text: '添加条目', title: '在末尾追加一个线型图例条目' });
  addButton.onClick(() => {
    ctx.markPropertyRebuild();
    ctx.handlers.onChange((layout) => {
      const target = itemById(layout, item.id);
      if (target?.kind === 'legend') target.entries.push(defaultLegendEntry());
    });
  });
  container.append(addButton.element);
  return createControlGroup('条目', container);
}

/** 隐藏一条图例条目:从 layout 移除并记进会话状态(重新显示时按原位置插回) */
function hideLegendEntry(ctx: SidebarContext, legendId: number, index: number): void {
  ctx.markPropertyRebuild();
  ctx.handlers.onChange((layout) => {
    const target = itemById(layout, legendId);
    if (target?.kind !== 'legend') return;
    const removed = target.entries.splice(index, 1)[0];
    if (!removed) return;
    const list = ctx.hiddenLegendEntries.get(legendId) ?? [];
    list.push({ entry: removed, index });
    list.sort((a, b) => a.index - b.index);
    ctx.hiddenLegendEntries.set(legendId, list);
  });
}

/** 重新显示一条隐藏条目:按记住的原位置插回 layout */
function showLegendEntry(ctx: SidebarContext, legendId: number, hiddenIndex: number): void {
  ctx.markPropertyRebuild();
  ctx.handlers.onChange((layout) => {
    const target = itemById(layout, legendId);
    if (target?.kind !== 'legend') return;
    const list = ctx.hiddenLegendEntries.get(legendId);
    const stored = list?.[hiddenIndex];
    if (!list || !stored) return;
    list.splice(hiddenIndex, 1);
    const insertAt = Math.min(stored.index, target.entries.length);
    target.entries.splice(insertAt, 0, stored.entry);
    if (list.length === 0) ctx.hiddenLegendEntries.delete(legendId);
  });
}

/** 删除一条隐藏条目(只从会话状态里删,layout 本来就没有它) */
function deleteLegendEntry(ctx: SidebarContext, legendId: number, index: number): void {
  ctx.markPropertyRebuild();
  ctx.handlers.onChange((layout) => {
    const target = itemById(layout, legendId);
    if (target?.kind === 'legend') target.entries.splice(index, 1);
  });
}
