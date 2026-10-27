/**
 * 出版排版编辑器（map.html）的组合根。
 *
 * 是什么：建三栏外壳（顶部工具条 / 画布 / 右侧属性面板 + 底部状态行）→ `GET /api/doc`
 * → `/api/geo` → `/api/scene` → 没有 scene 时用 `defaultScene` 生成初始排版 → 装配
 * 编辑器、侧栏、通知与工具条，并接上 Ctrl+S / beforeunload。
 * 为什么组合根只有这一份：`core`/`render`/`ui` 都不允许认识彼此的全部依赖，只有 app 层
 * 可以同时装配 HTTP、SVG 预览、miko_ui 面板与交互状态机。
 * 样式导入顺序是契约：先 miko_ui 的 token/控件，再应用的页面 token（styles.css），
 * 最后本页专属的 `.page-*`（styles-page.css）。
 * 元信息：作者 frontend，2026-10-27。
 */

import 'miko_ui/styles.css';
import '../styles.css';
import '../styles-page.css';
import { create_element, create_svg_element } from 'miko_ui';
import { normalizeScene, validateGeo, validateScene, type Geo, type Scene } from '../core/page';
import { defaultScene } from '../core/page-layout';
import { createTextMeasurer } from '../ui/measure-text';
import { PageNotifier } from '../ui/page-notify';
import { PageSidebar } from '../ui/page-sidebar';
import { buildPageToolbar } from '../ui/page-toolbar';
import {
  fetchGeoJson,
  fetchPageDoc,
  fetchSceneJson,
  PageEditor,
  type PageDoc,
} from './page-editor';

/** 页面外壳的节点句柄 */
interface PageShell {
  readonly toolbar: HTMLElement;
  readonly canvasHost: HTMLElement;
  readonly svg: SVGSVGElement;
  readonly sidebar: HTMLElement;
  readonly notices: HTMLElement;
  readonly statusMessage: HTMLElement;
  readonly statusState: HTMLElement;
}

/** 在 `#page-app` 里建立三栏外壳（顶部工具条通高，画布吃满剩余空间） */
function buildShell(root: HTMLElement): PageShell {
  root.classList.add('page-shell');
  const toolbar = create_element(
    { tag: 'header', into: root },
    { class: 'dock page-topbar', role: 'toolbar', 'aria-label': '出版排版工具' },
  );
  const main = create_element({ tag: 'main', into: root }, { class: 'page-main' });
  const canvasHost = create_element({ tag: 'div', into: main }, { class: 'page-canvas-host' });
  const svg = create_svg_element({ tag: 'svg', into: canvasHost }, { class: 'page-canvas' });
  const sidebar = create_element(
    { tag: 'aside', into: main },
    { class: 'page-sidebar', 'aria-label': '属性面板' },
  );
  const statusbar = create_element({ tag: 'footer', into: root }, { class: 'page-statusbar' });
  const statusMessage = create_element({ tag: 'span', into: statusbar }, { class: 'page-status' });
  const statusState = create_element({ tag: 'span', into: statusbar }, { class: 'page-state' });
  const notices = create_element({ tag: 'div', into: root }, { class: 'page-notices' });
  return { toolbar, canvasHost, svg, sidebar, notices, statusMessage, statusState };
}

/** 载入 geo 并校验；失败抛出可直接展示的 Error */
async function loadGeo(): Promise<Geo> {
  const raw = await fetchGeoJson();
  const errors = validateGeo(raw);
  if (errors.length > 0) throw new Error(errors.slice(0, 3).join('；'));
  return raw as Geo;
}

/**
 * 载入 scene：优先用服务器上的；不存在时用 defaultScene 生成初始排版。
 * 返回 `{ scene, dirty, warnings }`；scene 不合法时回退默认排版并提示。
 */
async function loadScene(
  geo: Geo,
  doc: PageDoc,
  measureText: ReturnType<typeof createTextMeasurer>,
): Promise<{ scene: Scene; dirty: boolean; warnings: string[] }> {
  const raw = await fetchSceneJson();
  if (raw === null) {
    return {
      scene: defaultScene(geo, doc.base, { figure: doc.figure.path, measureText }),
      dirty: true,
      warnings: [],
    };
  }
  const result = validateScene(raw, geo);
  if (!result.ok) {
    return {
      scene: defaultScene(geo, doc.base, { figure: doc.figure.path, measureText }),
      dirty: true,
      warnings: [`现有 scene.json 不合法，已改用默认排版：${result.errors[0] ?? '未知错误'}`],
    };
  }
  // 合法 scene 原样使用（不在这里重排数字，避免改动服务器上的真值）
  return { scene: normalizeScene(result.scene), dirty: false, warnings: [...result.warnings] };
}

/** 把致命错误展示在状态行与消息区，并给画布一个可见的提示 */
function showFatal(shell: PageShell, notifier: PageNotifier, message: string): void {
  notifier.error(message);
  notifier.setState('无法载入');
  const hint = create_element(
    { tag: 'p' },
    { class: 'page-fatal' },
    '地图排版编辑器需要本地 studio 服务（默认 127.0.0.1:8791）。',
  );
  shell.canvasHost.append(hint);
}

async function boot(): Promise<void> {
  const appRoot = document.getElementById('page-app');
  if (!appRoot) throw new Error('map.html 缺少 #page-app');
  const shell = buildShell(appRoot);
  const notifier = new PageNotifier({
    noticesHost: shell.notices,
    messageEl: shell.statusMessage,
    stateEl: shell.statusState,
  });
  notifier.info('正在连接 studio…');

  let doc: PageDoc;
  try {
    doc = await fetchPageDoc();
  } catch (error) {
    showFatal(
      shell,
      notifier,
      `载入 /api/doc 失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (doc.needs.base) {
    showFatal(shell, notifier, '底图缺失：请先在 Python 侧运行 python3 tools/prepare_demo.py');
    return;
  }

  let geo: Geo;
  try {
    geo = await loadGeo();
  } catch (error) {
    showFatal(
      shell,
      notifier,
      `载入 geo.json 失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const measureText = createTextMeasurer();
  let loaded: { scene: Scene; dirty: boolean; warnings: string[] };
  try {
    loaded = await loadScene(geo, doc, measureText);
  } catch (error) {
    notifier.error(
      `载入 scene 失败，改用默认排版：${error instanceof Error ? error.message : String(error)}`,
    );
    loaded = {
      scene: defaultScene(geo, doc.base, { figure: doc.figure.path, measureText }),
      dirty: true,
      warnings: [],
    };
  }

  // 侧栏在构造时就会读一次 scene，而编辑器需要侧栏句柄：用 ref 解开这个先后顺序
  let editorRef: PageEditor | null = null;
  const sidebar = new PageSidebar(shell.sidebar, {
    getScene: () => editorRef?.currentScene ?? loaded.scene,
    getGeo: () => geo,
    onChange: (mutate) => {
      editorRef?.applySceneChange(mutate);
    },
    onSelect: (id) => {
      editorRef?.select(id);
    },
    onDelete: (id) => {
      editorRef?.deleteItem(id);
    },
    onRelayout: (marginPt) => {
      void editorRef?.relayoutDefault(marginPt);
    },
    notify: (message) => notifier.info(message),
  });

  const editor = new PageEditor({
    svg: shell.svg,
    sidebar,
    notifier,
    measureText,
    doc,
    geo,
    scene: loaded.scene,
    dirty: loaded.dirty,
  });
  editorRef = editor;

  const toolbar = buildPageToolbar(shell.toolbar, {
    save: () => {
      void editor.save();
    },
    compose: () => {
      void editor.composeAgain();
    },
    openFinal: () => editor.openFinal(),
    fitPage: () => editor.fitPage(),
    actualSize: () => editor.actualSize(),
    addText: () => editor.addText('annotation'),
    addTitle: () => editor.addTitle(),
    addLegend: () => editor.addLegend(),
    addColorbar: () => editor.addColorbar(),
  });
  editor.bindToolbar(toolbar);
  editor.start();

  // 初始提示：needs 告警 + scene 校验告警；不打断装配
  if (doc.needs.geo) notifier.error('geo 尚未生成：部分初始排版可能不完整');
  for (const warning of loaded.warnings) notifier.error(`排版提示：${warning}`);
  if (loaded.dirty) {
    notifier.info('已生成默认排版，Ctrl+S 保存并合成');
  } else {
    notifier.info('已载入 scene.json，Ctrl+S 保存并合成');
  }
}

void boot();
