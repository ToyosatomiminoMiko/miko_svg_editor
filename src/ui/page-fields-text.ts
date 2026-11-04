/**
 * 文字元素的属性字段：内容 / 角色（仅页面文字）/ 对齐 / 旋转 + 「打开样式设置」入口。
 *
 * 是什么：选中 text 元素时构建的属性面板片段。字号/颜色/字重/斜体/行高/字距/光晕已全部
 * 迁到「样式设置」窗口（按分类统一覆盖），本面板不再写这些字段，只保留单条 item 自己的
 * 内容、角色、对齐与旋转；地图地名 item 不显示角色切换（role 固定 'label'），改为显示
 * 一条只读说明，指向窗口里的地图分类。
 * 为什么改角色后要调 core 的 applyCategoryStyleToItem：角色变了就等于换了一个分类，
 * 这条 item 必须立刻套用新分类的有效样式（覆盖优先），否则会保留旧角色的样式直到下次
 * 批量应用（`.work/STYLE-SETTINGS-SPEC.md` §7.2）。
 * 为什么单独成模块：文字字段仍是最多的一块（内容文本域 + 角色分段 + 对齐 + 旋转），
 * 单独一块改样式不会牵动图例/色标。
 * 元信息：作者 lead，2026-10-31，从 `ui/page-sidebar.ts` 原样搬出（行为不变）；
 *         作者 ui-dev，2026-11-05，样式字段迁往 `ui/page-style-window.ts`（spec §7.2）。
 */

import {
  createButton,
  createControlGroup,
  create_element,
  createFieldLabel,
  createRow,
  createSegmented,
  nextWidgetId,
} from 'miko_ui';
import { itemById, type TextAnchor, type TextItem, type TextRole } from '../core/page';
import { applyCategoryStyleToItem } from '../core/text-style';
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

/** 文字属性面板片段：内容 / 角色（页面文字）/ 对齐 / 旋转 / 打开样式设置 */
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

  // 页面文字可以换角色；地图地名 item 的 role 是生成端语义（固定 'label'），不提供切换。
  if (item.space === 'page') {
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
      ctx.handlers.onChange((layout, geo) => {
        const target = itemById(layout, item.id);
        if (target?.kind !== 'text') return;
        target.role = role;
        // 角色 = 分类：立即把新分类的有效样式写进这条 item（含字号）
        applyCategoryStyleToItem(layout, geo, target);
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
  } else {
    // 只读说明：样式不在这里改，避免用户在本面板找不到字号/颜色
    fragments.push(
      create_element(
        { tag: 'p' },
        { class: 'page-hint' },
        '字号/颜色等样式在地图分类「城市/行政区…」里统一设置',
      ),
    );
  }

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

  const rotationGrid = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  ctx.controls.addNumberRow(
    rotationGrid,
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
  fragments.push(createControlGroup('旋转', rotationGrid));

  // 面板底部：样式编辑的唯一入口（窗口状态由 app 持有，这里只转发打开动作）
  const styleButton = createButton({
    text: '打开样式设置',
    title: '按分类统一设置字号/颜色/字重/行高/字距/光晕',
    class: 'page-wide-button',
  });
  styleButton.onClick(() => ctx.handlers.openStyleSettings());
  fragments.push(styleButton.element);
  return fragments;
}
