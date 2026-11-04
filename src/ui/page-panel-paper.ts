/**
 * 出版排版编辑器侧栏的「页面」面板（纸张预设/方向/宽高/页边距/重新排默认版式）。
 *
 * 是什么：构建「页面」面板的控件并接上写回回调；面板自身不持有状态——layout 经
 * `SidebarContext` 读最新值，页边距是侧栏本地状态（同样经 ctx 读写）。
 * 为什么单独成模块：原 `page-sidebar.ts` 把四块面板与三类元素字段塞在同一个 1466 行文件里；
 * 拆开后页面尺寸相关的常量与规则只出现在本文件，改纸张行为不会牵动其它面板。
 * 元信息：作者 lead，2026-10-31，从 `ui/page-sidebar.ts` 原样搬出（行为不变）。
 */

import { createButton, createControlGroup, create_element, createSegmented } from 'miko_ui';
import {
  PAGE_PAPER_PRESETS,
  findPaperPreset,
  presetSize,
  type PaperOrientation,
  type PaperPresetId,
} from '../config/page';
import type { SidebarContext } from './page-sidebar-context';

/** 构建「页面」面板：预设/方向/宽高/页边距 + 「重新排默认版式」按钮 */
export function buildPaperPanel(body: HTMLElement, ctx: SidebarContext): void {
  const presetRow = create_element({ tag: 'div' }, { class: 'page-segmented-row' });
  const presetSegmented = createSegmented<PaperPresetId>({
    columns: 5,
    ariaLabel: '纸张预设',
    value: ctx.getLayout().paper.preset,
    items: [
      ...PAGE_PAPER_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
      { value: 'Custom', label: '自定义' },
    ],
  });
  presetSegmented.onChange((id) => applyPaperPreset(ctx, id));
  ctx.controls.registerSegmented(
    'page.preset',
    () => ctx.getLayout().paper.preset,
    (value) => presetSegmented.set(value as PaperPresetId),
  );
  presetRow.append(presetSegmented.element);
  body.append(presetRow);

  const orientationSegmented = createSegmented<PaperOrientation>({
    columns: 2,
    ariaLabel: '纸张方向',
    value: ctx.getLayout().paper.orientation,
    items: [
      { value: 'portrait', label: '纵向' },
      { value: 'landscape', label: '横向' },
    ],
  });
  orientationSegmented.onChange((orientation) => applyOrientation(ctx, orientation));
  ctx.controls.registerSegmented(
    'page.orientation',
    () => ctx.getLayout().paper.orientation,
    (value) => orientationSegmented.set(value as PaperOrientation),
  );
  body.append(createControlGroup('方向', orientationSegmented.element));

  const sizeRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  ctx.controls.addNumberRow(
    sizeRow,
    'page.width',
    '宽（pt）',
    () => ctx.getLayout().paper.width_pt,
    (value) => setPaperSize(ctx, 'width_pt', value),
    { min: 50, max: 5000, step: 0.5, onCommit: () => notifyPaperChanged(ctx) },
  );
  ctx.controls.addNumberRow(
    sizeRow,
    'page.height',
    '高（pt）',
    () => ctx.getLayout().paper.height_pt,
    (value) => setPaperSize(ctx, 'height_pt', value),
    { min: 50, max: 5000, step: 0.5, onCommit: () => notifyPaperChanged(ctx) },
  );
  body.append(sizeRow);

  const marginRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  ctx.controls.addNumberRow(
    marginRow,
    'page.margin',
    '页边距（pt）',
    () => ctx.getMarginPt(),
    (value) => {
      ctx.setMarginPt(Math.max(0, value));
    },
    { min: 0, max: 400, step: 1 },
  );
  body.append(marginRow);

  const relayout = createButton({
    text: '重新排默认版式',
    title: '用当前页边距重新生成初始排版（会覆盖当前排版）',
    class: 'page-wide-button',
  });
  relayout.onClick(() => ctx.handlers.onRelayout(ctx.getMarginPt()));
  body.append(relayout.element);
  body.append(
    create_element(
      { tag: 'p' },
      { class: 'page-hint' },
      '纸张尺寸与元素位置都以 pt 落盘；预览与导出的 final.svg 共用同一套排版公式。',
    ),
  );
}

/** 切换纸张预设：非自定义时按方向取预设宽高 */
function applyPaperPreset(ctx: SidebarContext, id: PaperPresetId): void {
  ctx.handlers.onChange((layout) => {
    layout.paper.preset = id;
    if (id === 'Custom') return;
    const preset = findPaperPreset(id);
    if (!preset) return;
    const size = presetSize(preset, layout.paper.orientation);
    layout.paper.width_pt = size.width_pt;
    layout.paper.height_pt = size.height_pt;
  });
  notifyPaperChanged(ctx);
}

/** 纸张尺寸/方向改变后的统一提示：默认排版不会自动重排 */
function notifyPaperChanged(ctx: SidebarContext): void {
  ctx.handlers.notify('纸张已改变：请点「重新排默认版式」或手动调整元素位置');
}

/** 切换方向：有预设时取预设尺寸，自定义尺寸则交换宽高 */
function applyOrientation(ctx: SidebarContext, orientation: PaperOrientation): void {
  ctx.handlers.onChange((layout) => {
    const before = layout.paper.orientation;
    layout.paper.orientation = orientation;
    const preset = findPaperPreset(layout.paper.preset);
    if (preset) {
      const size = presetSize(preset, orientation);
      layout.paper.width_pt = size.width_pt;
      layout.paper.height_pt = size.height_pt;
    } else if (before !== orientation) {
      // 自定义尺寸没有「纵向原值」可查：按当前宽高交换，直观且可逆
      const width = layout.paper.width_pt;
      layout.paper.width_pt = layout.paper.height_pt;
      layout.paper.height_pt = width;
    }
  });
  notifyPaperChanged(ctx);
}

/** 手改宽/高：预设不再成立，统一记成 Custom */
function setPaperSize(ctx: SidebarContext, key: 'width_pt' | 'height_pt', value: number): void {
  ctx.handlers.onChange((layout) => {
    layout.paper[key] = value;
    // 手改尺寸后预设不再成立，统一记成 Custom（避免预设标签与数字不一致）
    layout.paper.preset = 'Custom';
  });
}
