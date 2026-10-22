/**
 * 入口：读取 index.html 里的节点，组装 Editor 与工具栏。
 * 样式从 styles.css 引入，HTML 里不出现任何内联 CSS/JS。
 */

import './styles.css';
import { Editor, type HintHandle } from './editor';
import { buildToolbar } from './toolbar';

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

const editor = new Editor(canvas, hint);
const toolbar = buildToolbar(toolbarRoot, editor);
editor.bindToolbar(toolbar);
