/**
 * SVG 文件读取适配器:弹出系统文件选择框,并把用户选中的 `File` 解析成 DOM 无关的
 * `SvgNode` 树(契约见 `core/svg-import.ts`).
 *
 * 为什么 XML 解析放在 ui 层:解析必须用浏览器标准的 `DOMParser`(它负责命名空间,字符实体,
 * 以及把路径数据这类属性原样保留),而 core 是可在 node 里直接单测的纯逻辑层,没有 DOM.
 * 把「文本 -> 元素树」这段 DOM 适配留在 ui,core 只消费 `SvgNode`,测试便能手工拼树.
 *
 * 安全:导入的 SVG 不会被渲染,也不会插进页面,只从属性里提取几何数据;`image/svg+xml` 是
 * 惰性 XML 文档,其中的脚本/事件属性不会执行,因此不需要额外净化,但也不要主动把导入节点挂到 DOM 上.
 */

import {
  IMPORT_ACCEPT,
  IMPORT_INVALID_MESSAGE,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_BYTES_LABEL,
  IMPORT_MAX_NODES,
} from '../config';
import type { SvgNode } from '../core/svg-import';

/** 复用的隐藏文件输入框:第一次打开选择框时创建,之后一直复用,避免每次点击留下一个 DOM 节点 */
let pickerInput: HTMLInputElement | null = null;

/**
 * 弹出系统文件选择框;用户选中后回调(取消不回调).
 * 文件选择框只能由用户手势唤起(点击或键按都算),所以本函数必须从事件处理里同步调用.
 */
export function openSvgFilePicker(onFile: (file: File) => void): void {
  if (pickerInput === null) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = IMPORT_ACCEPT;
    input.hidden = true;
    document.body.append(input);
    pickerInput = input;
  }
  const input = pickerInput;
  // 每次点击都重装 onchange:它捕获的是本次调用的 onFile,不能沿用第一个调用者的
  input.onchange = () => {
    const file = input.files?.[0];
    // 先清值再回调:否则用户再次选同一个文件时不会派发 change 事件
    input.value = '';
    if (file !== undefined) onFile(file);
  };
  input.click();
}

/** 读取并解析一个 SVG 文件;过大/不是有效 SVG/节点超限都抛中文 Error(调用方转成 notify) */
export async function readSvgFile(file: File): Promise<SvgNode> {
  // 先查大小再读文本:把一份 100 MB 的文本读进内存才拒绝没有意义
  if (file.size > IMPORT_MAX_BYTES) {
    throw new Error(`SVG 文件过大(上限 ${IMPORT_MAX_BYTES_LABEL})`);
  }
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root: Element | null = doc.documentElement;
  // parsererror 的落点因浏览器而异:Chrome 把整棵文档换成根 <parsererror>,Firefox 则把它
  // 作为子元素塞进文档,所以「根不是 svg」与「文档里存在 parsererror」两处都要查.
  if (
    root === null ||
    root.localName.toLowerCase() !== 'svg' ||
    doc.getElementsByTagName('parsererror').length > 0
  ) {
    throw new Error(IMPORT_INVALID_MESSAGE);
  }
  return toSvgNode(root, { nodes: 0 });
}

/** 节点计数器:用可变对象穿过递归,统计整棵树的元素节点数 */
interface ParseBudget {
  nodes: number;
}

/**
 * 递归把 DOM 元素转成 `SvgNode`.只取元素子节点(文本节点不携带几何数据,模型也没有文本图元);
 * 节点数超过 IMPORT_MAX_NODES 抛错,把「结构攻击/超大文件」变成一条中文提示.
 */
function toSvgNode(el: Element, budget: ParseBudget): SvgNode {
  budget.nodes += 1;
  if (budget.nodes > IMPORT_MAX_NODES) {
    throw new Error(`SVG 结构超过 ${IMPORT_MAX_NODES} 个节点,无法导入`);
  }
  const attrs: Record<string, string> = {};
  for (const attr of el.attributes) attrs[attr.name] = attr.value;
  flattenStyle(attrs);
  const children: SvgNode[] = [];
  for (const child of el.children) children.push(toSvgNode(child, budget));
  return { tag: el.localName.toLowerCase(), attrs, children };
}

/**
 * 把 `style` 属性里的声明摊平进 attrs,并让它们覆盖同名呈现属性(行内 style 本来就优先).
 *
 * 为什么必须摊平:core 不解析 CSS,只读属性原文;不摊平会丢掉
 * `<line style="stroke-dasharray: 4 4">` 这类只能写在 style 里的信息.
 * 按第一个 ':' 拆 key/value 是为了容纳值里带冒号的写法(如 `url(http://...)`);
 * key 统一小写与 SVG 呈现属性同名;`!important` 对静态导入没有意义,去掉.
 */
function flattenStyle(attrs: Record<string, string>): void {
  const style = attrs.style;
  if (style === undefined) return;
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const key = declaration.slice(0, colon).trim().toLowerCase();
    if (key === '') continue;
    const value = declaration
      .slice(colon + 1)
      .replace(/!\s*important\s*$/i, '')
      .trim();
    if (value === '') continue;
    attrs[key] = value;
  }
}
