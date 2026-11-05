/**
 * 属性面板的控件登记表:把「读最新 layout -> 刷新控件显示」的样板收在一处.
 *
 * 是什么:`SidebarControlRegistry` 保存数字/颜色/文本/开关/分段五类登记项,另有一组无控件的
 * `registerRefresh` 回调(用于「某字段变化后别的控件要跟着禁用/显隐」这类联动);提供建行
 * (add*Row)与刷新(refreshControls),按 key 前缀清理(clearRegistry)三个入口.
 * 为什么这样组织:`sync()` 每次都要把 layout 的新值写回未聚焦的控件,五类控件的刷新规则
 * 各不相同;集中到一个类里,面板模块只负责「声明字段」,不重复写登记/刷新逻辑.
 * 为什么需要 registerRefresh:有些联动不写值(例如「左右居中」打开时要禁用它上方的 x 数字框
 * 并让整行变灰),只改可用态/显隐;这类逻辑没有对应的控件登记项,单独登记一个回调最直接.
 * 刷新口径:聚焦中的控件跳过(保住用户正在输入的文字),其余按 `read()` 读到的值覆盖;
 * 刷新回调最后统一执行.
 * 元信息:作者 ToyosatomiminoMiko,2026-11-05.
 */

import {
  create_element,
  createFieldLabel,
  createNumberField,
  createNumberRow,
  createRow,
  createSwitch,
  createSwitchRow,
  nextWidgetId,
  type NumberFieldHandle,
  type SwitchHandle,
} from 'miko_ui';

interface NumberEntry {
  readonly field: NumberFieldHandle;
  readonly read: () => number;
}

/** 颜色输入登记项(原生 `<input type="color">`) */
interface ColorEntry {
  readonly input: HTMLInputElement;
  readonly read: () => string;
}

/** 文本输入/文本域登记项 */
interface TextEntry {
  readonly input: HTMLInputElement | HTMLTextAreaElement;
  readonly read: () => string;
}

/** 开关登记项 */
interface SwitchEntry {
  readonly handle: SwitchHandle;
  readonly read: () => boolean;
}

/** 分段控件登记项(用闭包隐藏泛型,sync 只关心「读值 -> set」) */
interface SegmentedEntry {
  readonly read: () => string;
  readonly sync: (value: string) => void;
}

/** 颜色值兜底:`<input type=color>` 只接受 #rrggbb */
const safeColor = (value: string): string => (/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000');

/** 属性面板控件登记表;key 用 `page.` / `map.` / `prop.` 前缀区分面板 */
export class SidebarControlRegistry {
  private readonly numbers = new Map<string, NumberEntry>();
  private readonly colors = new Map<string, ColorEntry>();
  private readonly texts = new Map<string, TextEntry>();
  private readonly switches = new Map<string, SwitchEntry>();
  private readonly segmenteds = new Map<string, SegmentedEntry>();
  /** 无控件的联动刷新回调(key 与其它登记项同一命名空间,按前缀统一清理) */
  private readonly refreshes = new Map<string, () => void>();

  /**
   * 建一行「文字 + 数字」并登记.
   * 返回行与控件句柄:调用方要联动别的控件时(如按开关禁用某个字段)需要它们.
   */
  addNumberRow(
    parent: HTMLElement,
    key: string,
    label: string,
    read: () => number,
    write: (value: number) => void,
    options: { min?: number; max?: number; step?: number; onCommit?: () => void } = {},
  ): { readonly row: HTMLDivElement; readonly field: NumberFieldHandle } {
    const field = createNumberField({
      value: read(),
      min: options.min,
      max: options.max,
      step: options.step,
    });
    field.onInput((value) => {
      if (value === null) return;
      write(value);
    });
    field.onCommit((value) => {
      if (value === null) field.write(read());
      else write(value);
      options.onCommit?.();
    });
    const { row } = createNumberRow(label, field);
    parent.append(row);
    this.numbers.set(key, { field, read });
    return { row, field };
  }

  addColorRow(
    parent: HTMLElement,
    key: string,
    label: string,
    read: () => string,
    write: (value: string) => void,
  ): void {
    const input = create_element(
      { tag: 'input' },
      { class: 'page-color-input', type: 'color', value: safeColor(read()) },
    );
    input.id = nextWidgetId('page-color');
    input.addEventListener('input', () => write(safeColor(input.value)));
    parent.append(createRow(createFieldLabel(label, input.id), input));
    this.colors.set(key, { input, read });
  }

  addTextRow(
    parent: HTMLElement,
    key: string,
    label: string,
    read: () => string,
    write: (value: string) => void,
  ): void {
    const input = create_element({ tag: 'input' }, { class: 'page-text-input', type: 'text' });
    input.id = nextWidgetId('page-text');
    input.value = read();
    input.addEventListener('input', () => write(input.value));
    parent.append(createRow(createFieldLabel(label, input.id), input));
    this.texts.set(key, { input, read });
  }

  addSwitchRow(
    parent: HTMLElement,
    key: string,
    label: string,
    read: () => boolean,
    write: (value: boolean) => void,
  ): void {
    const handle = createSwitch({ value: read() });
    handle.onChange((value) => write(value));
    parent.append(createSwitchRow(label, handle));
    this.switches.set(key, { handle, read });
  }

  registerSegmented(key: string, read: () => string, sync: (value: string) => void): void {
    this.segmenteds.set(key, { read, sync });
  }

  registerText(
    key: string,
    input: HTMLInputElement | HTMLTextAreaElement,
    read: () => string,
  ): void {
    this.texts.set(key, { input, read });
  }

  /**
   * 登记一个「联动刷新」回调:不绑定具体控件,只按最新 layout 同步可用态/显隐等派生状态.
   * 为什么不用 registerSegmented 之类的钩子:联动可能跨多个字段(开关 -> 数字框 -> 行样式 -> 提示),
   * 单独一个回调比在某类控件的 sync 里塞副作用更清楚,也不会因控件类型变化而失效.
   */
  registerRefresh(key: string, refresh: () => void): void {
    this.refreshes.set(key, refresh);
  }

  refreshControls(): void {
    const active = document.activeElement;
    for (const entry of this.numbers.values()) {
      if (active === entry.field.input) continue;
      const value = entry.read();
      if (Number.isFinite(value)) entry.field.write(value);
    }
    for (const entry of this.colors.values()) {
      if (active === entry.input) continue;
      entry.input.value = safeColor(entry.read());
    }
    for (const entry of this.texts.values()) {
      if (active === entry.input) continue;
      const value = entry.read();
      if (entry.input.value !== value) entry.input.value = value;
    }
    for (const entry of this.switches.values()) {
      if (active === entry.handle.input) continue;
      const value = entry.read();
      if (entry.handle.get() !== value) entry.handle.set(value);
    }
    for (const entry of this.segmenteds.values()) {
      entry.sync(entry.read());
    }
    // 联动刷新放在最后:此时值已经写回控件,可用态/显隐按同一份 layout 快照推导
    for (const refresh of this.refreshes.values()) refresh();
  }

  clearRegistry(prefix: string): void {
    for (const key of [...this.numbers.keys()])
      if (key.startsWith(prefix)) this.numbers.delete(key);
    for (const key of [...this.colors.keys()]) if (key.startsWith(prefix)) this.colors.delete(key);
    for (const key of [...this.texts.keys()]) if (key.startsWith(prefix)) this.texts.delete(key);
    for (const key of [...this.switches.keys()])
      if (key.startsWith(prefix)) this.switches.delete(key);
    for (const key of [...this.segmenteds.keys()])
      if (key.startsWith(prefix)) this.segmenteds.delete(key);
    for (const key of [...this.refreshes.keys()])
      if (key.startsWith(prefix)) this.refreshes.delete(key);
  }
}
