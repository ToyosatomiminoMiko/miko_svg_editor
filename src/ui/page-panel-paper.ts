/**
 * 出版排版编辑器侧栏的「页面」面板(纸张预设/方向/宽高/尺寸锁 + 页边距).
 *
 * 是什么:构建「页面」面板的控件并接上写回回调;面板自身不持有状态--layout 经
 * `SidebarContext` 读最新值.纸张只决定画布/纸面尺寸,已放置元素的位置只由各自 x/y 决定;
 * 改纸张不会自动重排元素,也没有「默认版式」可重新生成(初始排版只在打开时生成一次).
 * 页边距是四个可编辑的版心参考值(mm):只画内容框高亮,不移动已放置元素;
 * 编辑边距时通过 `onMarginGuideChange` 让画布显示内容框与外侧边距带.
 * 纸张锁(paper.locked)冻结预设/方向/宽高三项;锁状态落盘,重新打开仍锁定.
 * 为什么单独成模块:原 `page-sidebar.ts` 把四块面板与三类元素字段塞在同一个 1466 行文件里;
 * 拆开后页面尺寸相关的常量与规则只出现在本文件,改纸张行为不会牵动其它面板.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import {
  createControlGroup,
  create_element,
  createSegmented,
  createSwitch,
  createSwitchRow,
} from 'miko_ui';
import {
  PAGE_PAPER_PRESETS,
  findPaperPreset,
  presetSize,
  type PaperOrientation,
  type PaperPresetId,
} from '../config/page';
import type { SidebarContext } from './page-sidebar-context';

/** 构建「页面」面板:纸张锁 + 预设/方向/宽高 + 页边距(位置全部由各元素 x/y 决定,改纸张不重排) */
export function buildPaperPanel(body: HTMLElement, ctx: SidebarContext): void {
  /* ---------------- 纸张尺寸锁 ---------------- */
  const lockRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  const lockSwitch = createSwitch({ value: ctx.getLayout().paper.locked });
  lockSwitch.onChange((locked) =>
    ctx.handlers.onChange((layout) => {
      layout.paper.locked = locked;
    }),
  );
  ctx.controls.registerRefresh('page.locked', () => {
    const locked = ctx.getLayout().paper.locked;
    if (lockSwitch.get() !== locked) lockSwitch.set(locked);
  });
  lockRow.append(createSwitchRow('锁定纸张尺寸', lockSwitch));
  body.append(lockRow);
  const lockHint = create_element(
    { tag: 'p' },
    { class: 'page-hint' },
    '锁定后预设/方向/宽高冻结,避免排版过程中误改纸张.',
  );
  body.append(lockHint);

  /* ---------------- 预设与方向 ---------------- */
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
  const orientationGroup = createControlGroup('方向', orientationSegmented.element);
  body.append(orientationGroup);

  const sizeRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  const widthRow = ctx.controls.addNumberRow(
    sizeRow,
    'page.width',
    '宽(mm)',
    () => ctx.getLayout().paper.width_mm,
    (value) => setPaperSize(ctx, 'width_mm', value),
    { min: 20, max: 2000, step: 0.5, onCommit: () => notifyPaperChanged(ctx) },
  );
  const heightRow = ctx.controls.addNumberRow(
    sizeRow,
    'page.height',
    '高(mm)',
    () => ctx.getLayout().paper.height_mm,
    (value) => setPaperSize(ctx, 'height_mm', value),
    { min: 20, max: 2000, step: 0.5, onCommit: () => notifyPaperChanged(ctx) },
  );
  body.append(sizeRow);

  // 尺寸锁联动:锁上时预设/方向/宽高控件全部禁用并灰显(边距不受影响).
  ctx.controls.registerRefresh('page.lockState', () => {
    const locked = ctx.getLayout().paper.locked;
    setSegmentedDisabled(presetSegmented.element, locked);
    setSegmentedDisabled(orientationSegmented.element, locked);
    presetRow.classList.toggle('is-disabled', locked);
    orientationGroup.classList.toggle('is-disabled', locked);
    for (const row of [widthRow.row, heightRow.row]) {
      row.classList.toggle('is-disabled', locked);
      row.querySelectorAll('input').forEach((input) => {
        input.disabled = locked;
      });
    }
    lockHint.textContent = locked
      ? '纸张尺寸已锁定:解锁后才能改预设/方向/宽高.'
      : '锁定后预设/方向/宽高冻结,避免排版过程中误改纸张.';
  });

  /* ---------------- 页边距 ---------------- */
  const marginRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  const marginFields = [
    ['top', '上'],
    ['right', '右'],
    ['bottom', '下'],
    ['left', '左'],
  ] as const;
  for (const [key, label] of marginFields) {
    ctx.controls.addNumberRow(
      marginRow,
      `page.margin.${key}`,
      label,
      () => ctx.getLayout().margin[key],
      (value) =>
        ctx.handlers.onChange((layout) => {
          layout.margin[key] = value;
        }),
      { min: 0, step: 0.5 },
    );
  }
  const marginGroup = createControlGroup('页边距(mm)', marginRow);
  body.append(marginGroup);
  // 编辑边距时高亮内容框:焦点进入这一组就显示,焦点离开(或点到组外)才隐藏.
  marginGroup.addEventListener('focusin', () => ctx.handlers.onMarginGuideChange(true));
  marginGroup.addEventListener('focusout', (event) => {
    const next = event.relatedTarget;
    if (next instanceof Node && marginGroup.contains(next)) return;
    ctx.handlers.onMarginGuideChange(false);
  });

  body.append(
    create_element(
      { tag: 'p' },
      { class: 'page-hint' },
      '纸张尺寸与元素位置都以 mm 落盘;页边距只是版心参考(编辑时高亮内容框),不会移动已放置元素.',
    ),
  );
}

/** 整组禁用分段控件:分段组的按钮是 `<button>`,逐个置 disabled 并灰显 */
function setSegmentedDisabled(element: HTMLElement, disabled: boolean): void {
  element.querySelectorAll('button').forEach((button) => {
    button.disabled = disabled;
  });
}

/** 切换纸张预设:非自定义时按方向取预设宽高;锁定状态下不生效 */
function applyPaperPreset(ctx: SidebarContext, id: PaperPresetId): void {
  if (ctx.getLayout().paper.locked) return;
  ctx.handlers.onChange((layout) => {
    if (layout.paper.locked) return;
    layout.paper.preset = id;
    if (id === 'Custom') return;
    const preset = findPaperPreset(id);
    if (!preset) return;
    const size = presetSize(preset, layout.paper.orientation);
    layout.paper.width_mm = size.width_mm;
    layout.paper.height_mm = size.height_mm;
  });
  notifyPaperChanged(ctx);
}

/** 纸张尺寸/方向改变后的统一提示:不会自动重排,元素位置只由各自 x/y 决定 */
function notifyPaperChanged(ctx: SidebarContext): void {
  ctx.handlers.notify('纸张已改变:已放置元素位置不变,可拖拽或改 x/y 调整');
}

/** 切换方向:有预设时取预设尺寸,自定义尺寸则交换宽高;锁定状态下不生效 */
function applyOrientation(ctx: SidebarContext, orientation: PaperOrientation): void {
  if (ctx.getLayout().paper.locked) return;
  ctx.handlers.onChange((layout) => {
    if (layout.paper.locked) return;
    const before = layout.paper.orientation;
    layout.paper.orientation = orientation;
    const preset = findPaperPreset(layout.paper.preset);
    if (preset) {
      const size = presetSize(preset, orientation);
      layout.paper.width_mm = size.width_mm;
      layout.paper.height_mm = size.height_mm;
    } else if (before !== orientation) {
      // 自定义尺寸没有「纵向原值」可查:按当前宽高交换,直观且可逆
      const width = layout.paper.width_mm;
      layout.paper.width_mm = layout.paper.height_mm;
      layout.paper.height_mm = width;
    }
  });
  notifyPaperChanged(ctx);
}

/** 手改宽/高:预设不再成立,统一记成 Custom;锁定状态下不生效 */
function setPaperSize(ctx: SidebarContext, key: 'width_mm' | 'height_mm', value: number): void {
  if (ctx.getLayout().paper.locked) return;
  ctx.handlers.onChange((layout) => {
    if (layout.paper.locked) return;
    layout.paper[key] = value;
    // 手改尺寸后预设不再成立,统一记成 Custom(避免预设标签与数字不一致)
    layout.paper.preset = 'Custom';
  });
}
