/**
 * 「已选择」列表区块：把有序选择集渲染成可逐项移除的行列表，
 * 填充左侧状态栏（status-panel.ts）的上半区。
 *
 * 每一行分上下两层：上行是种类徽章 + 名称 + 行末「移除」，下行是该对象已有的约束
 * （没有约束时整行不出现）。约束文案由 selection 层生成，本文件只负责把它们摆成
 * 可换行的胶囊；每颗胶囊里嵌一个「×」，按约束 id 交给宿主删除模型里的那一条约束。
 * 约束只随「已选择」出现，不另设全局约束列表。
 *
 * 职责边界：本文件只做 DOM 装配与内容签名去重，不查模型、不改选择集；
 * 移除动作通过构造时注入的 SelectionListHost 交给宿主（Editor）执行，
 * label 与 constraints 由 selection 层生成，UI 不参与命名或判定。
 *
 * 为什么按内容签名跳过重建：拖动已选图形时宿主每帧都会 update，一次 update
 * 重建整份行列表会反复销毁/创建按钮、丢失悬停与焦点并放大布局抖动。
 * 签名由 kind:id:约束 id/文案 拼成，顺序也参与签名（选择集的顺序就是用户选中顺序，
 * 顺序变化必须重排；加/删约束或改尺寸值也要重建，否则行内标签会停在旧内容）。
 * 区块空时保持可见，只把空态与列表按 is-hidden 互斥切换。
 *
 * 全部 DOM 用 miko_ui 公开原语装配（create_element / createButton / createBadge /
 * createObjectRow / createRowActions），外观只靠 .app-* 类名交给应用样式表；
 * 本文件不写内联样式、不 import CSS。
 */

import {
  create_element,
  createBadge,
  createButton,
  createObjectRow,
  createRowActions,
} from 'miko_ui';
import type { SelectionConstraint, SelectionEntry, SelectionKind } from '../core/types';

/** 宿主回调：按「种类 + id」从选择集中移除一项；约束按约束 id 删除（id 含义见各自容器） */
export interface SelectionListHost {
  remove(kind: SelectionKind, id: number): void;
  removeConstraint(id: number): void;
}

export class SelectionListView {
  private readonly host: SelectionListHost;
  /** 行列表容器；空选择时整块隐藏，空态文案顶替它 */
  private readonly list: HTMLElement;
  /** 空态提示；与 list 互斥显示 */
  private readonly empty: HTMLElement;
  /** 标题栏末尾的计数读数 */
  private readonly count: HTMLElement;
  /** 最近一次渲染的内容签名（kind:id 以 | 连接）；null = 还没渲染过 */
  private lastSignature: string | null = null;

  /**
   * @param root 左侧状态栏上半区的选择区块宿主（`.app-status-selection`）
   * @param host 移除动作的宿主回调，由 Editor 提供
   */
  constructor(root: HTMLElement, host: SelectionListHost) {
    this.host = host;

    // 区块标题 + 计数：左侧「已选择」，右侧贴边的「已选 N 项」
    const head = create_element({ tag: 'div' }, { class: 'app-selection-head' });
    this.count = create_element({ tag: 'span' }, { class: 'app-selection-count' });
    head.append(
      create_element({ tag: 'span' }, { class: 'app-selection-title' }, '已选择'),
      this.count,
    );

    this.list = create_element({ tag: 'div' }, { class: 'app-selection-list', role: 'list' });
    this.empty = create_element({ tag: 'p' }, { class: 'app-selection-empty' }, '未选择对象');
    root.append(head, this.list, this.empty);

    // 先收敛到空态：宿主可能一直不调 update，面板初始也要是完整形态
    this.update([]);
  }

  /**
   * 用最新的有序选择集刷新面板。
   * 内容签名不变就直接返回：拖动期间每帧都会调用，DOM 必须稳定。
   */
  update(entries: readonly SelectionEntry[]): void {
    // 约束 id/文案也进签名：模型里加/删约束、改尺寸值时选择集往往不变，但行内胶囊必须跟着刷新
    const signature = entries
      .map(
        (entry) =>
          `${entry.kind}:${entry.id}:${entry.constraints
            .map((constraint) => `${constraint.id}:${constraint.text}`)
            .join(',')}`,
      )
      .join('|');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    this.count.textContent = `已选 ${entries.length} 项`;
    this.list.replaceChildren(...entries.map((entry) => this.buildRow(entry)));

    const empty = entries.length === 0;
    this.list.classList.toggle('is-hidden', empty);
    this.empty.classList.toggle('is-hidden', !empty);
  }

  /**
   * 装配一行：上行（徽章 + 省略号文本 + 行末移除按钮），下行（已有约束）。
   * 两层都放进 `.row-main` 再竖排：库的 `.row-main` 是横向 flex-wrap，
   * 直接并列会按宽度换行而不是稳定地分成「名称 / 约束」两行。
   */
  private buildRow(entry: SelectionEntry): HTMLElement {
    // 每次重建都新建按钮：监听随旧行一起被丢弃，不需要在视图层另行持有句柄
    const remove = createButton({
      text: '移除',
      class: 'app-selection-remove',
      ariaLabel: `从选择中移除 ${entry.label}`,
    });
    remove.onClick(() => this.host.remove(entry.kind, entry.id));

    const { row, main } = createObjectRow('app-selection-row', createRowActions(remove.element));
    const content = create_element({ tag: 'div' }, { class: 'app-selection-main' });
    const top = create_element({ tag: 'div' }, { class: 'app-selection-top' });
    top.append(
      createBadge(entry.kind === 'ent' ? '图元' : '点', { class: 'app-selection-badge' }),
      create_element({ tag: 'span' }, { class: 'app-selection-label' }, entry.label),
    );
    content.append(top);

    if (entry.constraints.length > 0) {
      const constraints = create_element({ tag: 'div' }, { class: 'app-selection-constraints' });
      constraints.append(
        create_element({ tag: 'span' }, { class: 'app-selection-constraints-label' }, '约束'),
        ...entry.constraints.map((constraint) => this.buildConstraintChip(constraint)),
      );
      content.append(constraints);
    }

    main.append(content);
    return row;
  }

  /**
   * 装配一颗约束胶囊：文案 + 行内「×」，点「×」删除模型里的这一条约束。
   * 胶囊用 createBadge 做壳（库的徽章基线给胶囊外形），再把文案与删除按钮嵌进去；
   * 按钮的 aria-label 带上约束文案，读屏不必靠上下文猜删的是哪一条。
   * 与行内其他按钮一样每次重建都新建，监听随旧行一起丢弃。
   */
  private buildConstraintChip(constraint: SelectionConstraint): HTMLElement {
    const remove = createButton({
      text: '×',
      class: 'app-selection-constraint-remove',
      ariaLabel: `删除约束 ${constraint.text}`,
      title: `删除约束 ${constraint.text}`,
    });
    remove.onClick(() => this.host.removeConstraint(constraint.id));

    const chip = createBadge('', { class: 'app-selection-constraint' });
    chip.append(
      create_element({ tag: 'span' }, { class: 'app-selection-constraint-text' }, constraint.text),
      remove.element,
    );
    return chip;
  }
}
