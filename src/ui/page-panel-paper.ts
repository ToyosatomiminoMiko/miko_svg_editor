/**
 * 出版排版编辑器侧栏的「页面」面板（纸张预设/方向/宽高）。
 *
 * 是什么：构建「页面」面板的控件并接上写回回调；面板自身不持有状态——layout 经
 * `SidebarContext` 读最新值。纸张只决定画布/纸面尺寸，已放置元素的位置只由各自 x/y 决定；
 * 改纸张不会自动重排元素，也没有「默认版式」可重新生成（初始排版只在打开时生成一次）。
 * 为什么单独成模块：原 `page-sidebar.ts` 把四块面板与三类元素字段塞在同一个 1466 行文件里；
 * 拆开后页面尺寸相关的常量与规则只出现在本文件，改纸张行为不会牵动其它面板。
 * 元信息：作者 ToyosatomiminoMiko，2026-11-05。
 */

import { createControlGroup, create_element, createSegmented } from 'miko_ui';
import {
  PAGE_PAPER_PRESETS,
  findPaperPreset,
  presetSize,
  type PaperOrientation,
  type PaperPresetId,
} from '../config/page';
import type { SidebarContext } from './page-sidebar-context';

/** 构建「页面」面板：纸张预设/方向/宽高（位置全部由各元素 x/y 决定，改纸张不重排） */
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

/** 纸张尺寸/方向改变后的统一提示：不会自动重排，元素位置只由各自 x/y 决定 */
function notifyPaperChanged(ctx: SidebarContext): void {
  ctx.handlers.notify('纸张已改变：已放置元素位置不变，可拖拽或改 x/y 调整');
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
