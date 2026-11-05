/**
 * 出版排版编辑器属性面板的共享类型:宿主回调 `PageSidebarHandlers` 与面板构建上下文 `SidebarContext`.
 *
 * 是什么:`PageSidebar`(编排)与各面板模块(页面/地图/元素字段)之间的唯一契约.
 * 为什么单独一个文件:面板模块只 import 类型即可,不反向依赖 `page-sidebar.ts`,
 * 既不形成运行期环(`npm run arch` 只统计值依赖),也让「谁能改哪个状态」在类型里写清楚.
 * 状态归属:layout/geo 由 `app/page-editor.ts` 持有;隐藏图例条目,当前文字编辑框
 * 是侧栏本地状态,仍然只在 `page-sidebar.ts` 里存,这里只暴露读写方法.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import type { Geo, LegendEntry, PageLayout } from '../core/page';
import type { TextStyleCategoryId } from '../config/text-style';
import type { SidebarControlRegistry } from './page-sidebar-controls';

/** 侧栏回调:编辑器负责把 mutator 应用到自己的 layout 并重绘/记脏 */
export interface PageSidebarHandlers {
  getLayout(): PageLayout;
  getGeo(): Geo;
  /** 应用一次修改:mutator 直接改入参 layout(编辑器随后重绘并同步侧栏) */
  onChange(mutate: (layout: PageLayout, geo: Geo) => void): void;
  onSelect(id: number | null): void;
  onDelete(id: number): void;
  /** 轻提示(状态行):纸张改变时说明元素不会被自动重排 */
  notify(message: string): void;
  /**
   * 拉起「样式设置」窗口(单条 item 不再有样式字段,统一按分类改).
   * 带分类时窗口直接定位到该分类(侧栏选中文字时传它的 role 分类);不带则沿用上次分类.
   */
  openStyleSettings(category?: TextStyleCategoryId): void;
}

/** 面板构建上下文:只暴露「读最新状态 + 写回入口」,面板模块不持有任何状态 */
export interface SidebarContext {
  readonly handlers: PageSidebarHandlers;
  readonly controls: SidebarControlRegistry;
  /** 当前 layout(每次 sync 更新;read 闭包必须每次调用它取最新值) */
  getLayout(): PageLayout;
  getGeo(): Geo;
  getSelectedId(): number | null;
  /** 当前选中文字的编辑框(双击画布后聚焦它) */
  setTextEditor(input: HTMLTextAreaElement | null): void;
  /** 地图派生高度读数节点 */
  setMapHeightEl(el: HTMLElement | null): void;
  /** 标记属性面板需要重建(下一次 sync 生效,本调用不立刻同步) */
  markPropertyRebuild(): void;
  /** 标记并立刻同步(改完会话状态后必须马上重建场景) */
  requestPropertyRebuild(): void;
  /** 会话内隐藏的图例条目:legend id -> 被移除的条目与原位置 */
  readonly hiddenLegendEntries: Map<number, { entry: LegendEntry; index: number }[]>;
}
