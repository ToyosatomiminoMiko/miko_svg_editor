/**
 * 入口：读取主题与文本测量适配器，读取 index.html 里的节点，组装 Editor 与工具栏。
 * 样式从 styles.css 引入，HTML 里不出现任何内联 CSS/JS。
 */

import './styles.css';
import { Editor } from './editor';
import type { HintHandle } from './ui/hint-editor';
import { readTheme } from './theme';
import { buildToolbar } from './toolbar';
import { createTextMeasurer } from './ui/measure-text';

const canvas = document.getElementById('canvas');
const toolbarRoot = document.getElementById('toolbar');
const hintRoot = document.getElementById('hint');
const hintText = document.getElementById('hint-text');
const hintEditor = document.getElementById('hint-editor');
const hintLabel = document.getElementById('hint-label');
const hintInput = document.getElementById('hint-input');

if (
  !(canvas instanceof HTMLCanvasElement) ||
  !toolbarRoot ||
  !hintRoot ||
  !hintText ||
  !hintEditor ||
  !hintLabel ||
  !(hintInput instanceof HTMLInputElement)
) {
  throw new Error('index.html 缺少 #canvas / #toolbar / #hint 相关节点');
}

const hint: HintHandle = {
  root: hintRoot,
  text: hintText,
  editor: hintEditor,
  label: hintLabel,
  input: hintInput,
};

// 主题只在这里读一次，之后由 Renderer/Editor 通过构造参数使用（§5.1 依赖注入）
const theme = readTheme();
const measureText = createTextMeasurer();

const editor = new Editor(canvas, hint, theme, measureText);
const toolbar = buildToolbar(toolbarRoot, editor.handlers);
editor.bindToolbar(toolbar);
