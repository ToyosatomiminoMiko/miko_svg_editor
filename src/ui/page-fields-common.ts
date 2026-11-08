/**
 * 所有元素共有的属性字段:x/y(纸张坐标,单位 mm);页面文字额外带「左右居中」开关.
 *
 * 是什么:属性面板顶部的通用字段,按元素 kind 无关的 `PageItem` 基础字段构建.
 * 为什么单独成模块:text/legend/colorbar 三类字段都依赖它,拆开避免三类字段模块互相 import.
 * 为什么没有「坐标空间」:全项目只有一个坐标系--纸张坐标(mm,原点 = 纸张左上角);
 * 地图地名在打开时已换算成纸张坐标,编辑时和普通文字一样直接改 x/y(移动地图会整批搬移).
 * 为什么「左右居中」开关放在 x/y 正下方:它约束的正是 x(水平位置恒为纸张中心),紧挨着被约束
 * 的字段用户才看得懂;打开时 x 数字框禁用,整行变灰,并显示一行说明.开关会写 `center_h` 并
 * 立即把 x/anchor 贴合到纸张中心(编辑器随后还会统一 enforce,这里先写一次让读数与画面立刻一致).
 * 地图地名(geo_label_id 非 null)的位置来自底图数据,不显示该开关(契约规定地图地名 center_h 恒 false).
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import { create_element, createSwitch, createSwitchRow, type NumberFieldHandle } from 'miko_ui';
import { itemById, roundToPageDecimals, type PageItem } from '../core/page';
import type { SidebarContext } from './page-sidebar-context';

/** 通用字段:x/y(mm)+ 页面文字的左右居中开关 */
export function buildCommonItemFields(ctx: SidebarContext, item: PageItem): HTMLElement {
  const container = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  const positionRow = create_element({ tag: 'div' }, { class: 'page-field-grid' });
  const xField = ctx.controls.addNumberRow(
    positionRow,
    'prop.x',
    'x(mm)',
    () => itemById(ctx.getLayout(), item.id)?.x ?? 0,
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target) target.x = value;
      }),
    { step: 0.5 },
  );
  ctx.controls.addNumberRow(
    positionRow,
    'prop.y',
    'y(mm)',
    () => itemById(ctx.getLayout(), item.id)?.y ?? 0,
    (value) =>
      ctx.handlers.onChange((layout) => {
        const target = itemById(layout, item.id);
        if (target) target.y = value;
      }),
    { step: 0.5 },
  );
  // 左右居中只约束手动页面文字;图例/色标与地图地名(geo_label_id 非 null)都没有这个约束.
  if (item.kind === 'text' && item.geo_label_id === null) {
    appendCenterToggle(ctx, item, positionRow, xField);
  }
  container.append(positionRow);
  return container;
}

/**
 * 在 x/y 下方追加「左右居中」开关与说明,并登记联动刷新(开关状态,x 可用态,行变灰,提示显隐).
 * 为什么不用分段控件的刷新钩子:这段联动跨开关/x 行/提示三个节点,用 registerRefresh 更直接,
 * 也不会因为分段控件的存在与否而失效.
 */
function appendCenterToggle(
  ctx: SidebarContext,
  item: PageItem,
  parent: HTMLElement,
  x: { readonly row: HTMLDivElement; readonly field: NumberFieldHandle },
): void {
  const readCenterH = (): boolean => {
    const target = itemById(ctx.getLayout(), item.id);
    return target?.kind === 'text' && target.geo_label_id === null ? target.center_h : false;
  };
  const hint = create_element(
    { tag: 'p' },
    { class: 'page-hint' },
    '水平位置由纸张宽度决定(拖拽只改垂直位置).',
  );
  hint.hidden = true;
  const centerSwitch = createSwitch({ value: readCenterH() });
  centerSwitch.onChange((enabled) =>
    ctx.handlers.onChange((layout) => {
      const target = itemById(layout, item.id);
      if (target?.kind !== 'text' || target.geo_label_id !== null) return;
      target.center_h = enabled;
      // 开启即贴合中心:编辑器之后还会统一 enforce,这里先写一次让侧栏读数立刻一致;
      // 关闭时按契约保持当前 x/anchor 不变.
      if (enabled) {
        target.anchor = 'middle';
        target.x = roundToPageDecimals(layout.paper.width_mm / 2);
      }
    }),
  );
  parent.append(createSwitchRow('左右居中', centerSwitch), hint);

  /** 按最新 layout 同步开关值,x 禁用态,整行变灰与提示显隐(侧栏每次 sync 都会调用) */
  const syncCenterState = (): void => {
    const centered = readCenterH();
    if (centerSwitch.get() !== centered) centerSwitch.set(centered);
    // 聚焦中的输入框不动:用户正在改 x 时先让他把这次输入写完,不在光标下切换禁用态
    if (x.field.input.ownerDocument.activeElement !== x.field.input) {
      x.field.input.disabled = centered;
    }
    x.row.classList.toggle('is-disabled', centered);
    hint.hidden = !centered;
  };
  ctx.controls.registerRefresh('prop.center_h', syncCenterState);
  syncCenterState();
}
