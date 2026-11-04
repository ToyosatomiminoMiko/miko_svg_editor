/**
 * 文字元素的属性字段：内容 / 角色 / 字号 / 行高 / 字距 / 旋转 / 颜色 / 对齐 / 斜体 / 光晕 / 字重。
 *
 * 是什么：选中 text 元素时构建的属性面板片段；默认值口径与 `config/text-style.ts` 一致。
 * 为什么单独成模块：文字字段最多（含光晕三条联动字段），单独一块改样式不会牵动图例/色标。
 * 元信息：作者 lead，2026-10-31，从 `ui/page-sidebar.ts` 原样搬出（行为不变）。
 */

import {
  createControlGroup,
  create_element,
  createFieldLabel,
  createRow,
  createSegmented,
  nextWidgetId,
} from 'miko_ui';
import { PAGE_TEXT_STYLES, TEXT_HALO } from '../config/text-style';
import { itemById, type TextAnchor, type TextItem, type TextRole } from '../core/page';
import type { SidebarContext } from './page-sidebar-context';

const ROLE_LABELS: Readonly<Record<TextRole, string>> = {
  title: '标题',
  subtitle: '副标题',
  label: '地名',
  annotation: '标注',
  note: '注记',
  source: '来源',
};

const ANCHOR_LABELS: Readonly<Record<TextAnchor, string>> = {
  start: '左',
  middle: '中',
  end: '右',
};

/**
 * 字重分段选项（四档，4 列）。
 * 为什么存字符串：`createSegmented` 的值域只接受 `string`，写回 `font_weight` 时再转数字；
 * 只暴露规格给出的四档，导入的 page 里其它合法字重（100..900）仍原样保留、不在此被改写。
 */
const FONT_WEIGHT_OPTIONS = [
  { value: '400', label: '常规' },
  { value: '500', label: '中等' },
  { value: '600', label: '半粗' },
  { value: '700', label: '粗' },
] as const;

/** 文字属性面板片段（内容 / 角色 / 文字 / 对齐 / 字重 / 样式） */
export function buildTextFields(ctx: SidebarContext, item: TextItem): HTMLElement[] {
  const fragments: HTMLElement[] = [];

  const textArea = create_element({ tag: 'textarea' }, { class: 'page-textarea' });
  textArea.value = item.lines.join('\n');
  textArea.rows = 4;
  textArea.id = nextWidgetId('page-text');
  textArea.addEventListener('input', () => {
    const lines = textArea.value.split('\n');
    ctx.handlers.onChange((layout) => {
      const target = itemById(layout, item.id);
      if (target?.kind !== 'text') return;
      target.lines = lines;
    });
  });
  ctx.setTextEditor(textArea);
  ctx.controls.registerText('prop.lines', textArea, () => {
    const target = itemById(ctx.getLayout(), item.id);
    return target?.kind === 'text' ? target.lines.join('\n') : '';
  });
  const textRow = createRow(createFieldLabel('内容', textArea.id), textArea);
  textRow.classList.add('page-text-row');
  fragments.push(textRow);

  const roleSegmented = createSegmented<TextRole>({
    columns: 3,
    ariaLabel: '文字角色',
    value: item.role,
    items: (Object.keys(ROLE_LABELS) as TextRole[]).map((role) => ({
      value: role,
      label: ROLE_LABELS[role],
    })),
  });
  roleSegmented.onChange((role) =>
    ctx.handlers.onChange((layout) => {
      const target = itemById(layout, item.id);
      if (target?.kind === 'text') target.role = role;
    }),
  );
  ctx.controls.registerSegmented(
    'prop.role',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'text' ? target.role : 'annotation';
    },
    (value) => roleSegmented.set(value as TextRole),
  );
  fragments.push(createControlGroup('角色', roleSegmented.element));

  const styleRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  ctx.controls.addNumberRow(
    styleRow,
    'prop.fontSize',
    '字号（pt）',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'text' ? target.font_size_pt : 12;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'text') target.font_size_pt = value;
      }),
    { min: 0.5, step: 0.5 },
  );
  ctx.controls.addNumberRow(
    styleRow,
    'prop.lineHeight',
    '行高（倍数）',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'text' ? target.line_height : PAGE_TEXT_STYLES.annotation.line_height;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'text') target.line_height = value;
      }),
    { min: 0.5, step: 0.05 },
  );
  ctx.controls.addNumberRow(
    styleRow,
    'prop.letterSpacing',
    '字距（em）',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'text'
        ? target.letter_spacing_em
        : PAGE_TEXT_STYLES.annotation.letter_spacing_em;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'text') target.letter_spacing_em = value;
      }),
    { min: -0.5, step: 0.01 },
  );
  ctx.controls.addNumberRow(
    styleRow,
    'prop.rotation',
    '旋转（°）',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'text' ? target.rotation_deg : 0;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'text') target.rotation_deg = value;
      }),
    { step: 1 },
  );
  ctx.controls.addColorRow(
    styleRow,
    'prop.textColor',
    '文字颜色',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'text' ? target.color : PAGE_TEXT_STYLES.annotation.color;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'text') target.color = value;
      }),
  );
  fragments.push(createControlGroup('文字', styleRow));

  const anchorSegmented = createSegmented<TextAnchor>({
    columns: 3,
    ariaLabel: '对齐',
    value: item.anchor,
    items: (Object.keys(ANCHOR_LABELS) as TextAnchor[]).map((anchor) => ({
      value: anchor,
      label: ANCHOR_LABELS[anchor],
    })),
  });
  anchorSegmented.onChange((anchor) =>
    ctx.handlers.onChange((layout) => {
      const target = itemById(layout, item.id);
      if (target?.kind === 'text') target.anchor = anchor;
    }),
  );
  ctx.controls.registerSegmented(
    'prop.anchor',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'text' ? target.anchor : 'middle';
    },
    (value) => anchorSegmented.set(value as TextAnchor),
  );
  fragments.push(createControlGroup('对齐', anchorSegmented.element));

  const styleSwitches = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  ctx.controls.addSwitchRow(
    styleSwitches,
    'prop.italic',
    '斜体',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'text' ? target.italic : false;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind === 'text') target.italic = value;
      }),
  );
  ctx.controls.addSwitchRow(
    styleSwitches,
    'prop.halo',
    '文字光晕',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'text' && target.halo !== null;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind !== 'text') return;
        target.halo = value ? { ...TEXT_HALO } : null;
      }),
  );
  ctx.controls.addColorRow(
    styleSwitches,
    'prop.haloColor',
    '光晕颜色',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'text' && target.halo ? target.halo.color : TEXT_HALO.color;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind !== 'text') return;
        target.halo = { color: value, width_pt: target.halo?.width_pt ?? TEXT_HALO.width_pt };
      }),
  );
  ctx.controls.addNumberRow(
    styleSwitches,
    'prop.haloWidth',
    '光晕宽度',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'text' && target.halo ? target.halo.width_pt : TEXT_HALO.width_pt;
    },
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target?.kind !== 'text') return;
        target.halo = { color: target.halo?.color ?? TEXT_HALO.color, width_pt: value };
      }),
    { min: 0, step: 0.5 },
  );
  const weightSegmented = createSegmented<string>({
    columns: 4,
    ariaLabel: '字重',
    value: String(item.font_weight),
    items: FONT_WEIGHT_OPTIONS,
  });
  weightSegmented.onChange((value) =>
    ctx.handlers.onChange((layout) => {
      const target = itemById(layout, item.id);
      if (target?.kind === 'text') target.font_weight = Number(value);
    }),
  );
  ctx.controls.registerSegmented(
    'prop.fontWeight',
    () => {
      const target = itemById(ctx.getLayout(), item.id);
      return target?.kind === 'text'
        ? String(target.font_weight)
        : String(PAGE_TEXT_STYLES.annotation.font_weight);
    },
    (value) => weightSegmented.set(value),
  );
  fragments.push(createControlGroup('字重', weightSegmented.element));
  fragments.push(createControlGroup('样式', styleSwitches));
  return fragments;
}
