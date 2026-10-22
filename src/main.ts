/**
 * 入口：读取 index.html 里的节点，组装 Editor 与工具栏。
 * 样式从 styles.css 引入，HTML 里不出现任何内联 CSS/JS。
 */

import './styles.css';
import { Editor } from './editor';
import { buildToolbar } from './toolbar';

const canvas = document.getElementById('canvas');
const toolbarRoot = document.getElementById('toolbar');
const hint = document.getElementById('hint');

if (!(canvas instanceof HTMLCanvasElement) || !toolbarRoot || !hint) {
  throw new Error('index.html 缺少 #canvas / #toolbar / #hint 节点');
}

const editor = new Editor(canvas, hint);
const toolbar = buildToolbar(toolbarRoot, editor);
editor.bindToolbar(toolbar);
