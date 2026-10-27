/**
 * 出版排版编辑器（map.html）的组合根。
 *
 * 是什么：建三栏外壳（顶部工具条 / 画布 / 右侧属性面板 + 底部状态行）→ 在画布里显示上传面板
 * → 用户在 SVG / JSON 两个选择栏里分别选/拖入 `base.svg` 与 `geo.json`（可选 `scene.json`）→
 * 分类、读取、严格校验 → 生成 `PageDocument` → 为预览建 objectURL → 装配侧栏、编辑器与工具条并启动。
 * 为什么组合根只有这一份：`core`/`render`/`ui` 都不允许认识彼此的全部依赖，只有 app 层
 * 可以同时装配文件读取、SVG 预览、miko_ui 面板与交互状态机。页面是纯静态的，不认识任何 HTTP 接口。
 * 打开口径（详见 `.work/REFACTOR-SPEC.md` §1）：底图 C1–C4、UTF-8、sha256 与 `geo.base.sha256`
 * 一致、geo 的 viewBox/尺寸与底图一致（容差 0.01pt）；scene 可选，不合法只告警并回退默认排版。
 * 样式导入顺序是契约：先 miko_ui 的 token/控件，再应用的页面 token（styles.css），
 * 最后本页专属的 `.page-*`（styles-page.css）。
 * 元信息：作者 frontend，2026-10-27；2026-10-28 改为无后端（上传打开 + 浏览器内合成）。
 */

import 'miko_ui/styles.css';
import '../styles.css';
import '../styles-page.css';
import { create_element, create_svg_element } from 'miko_ui';
import { readBaseSvg, type BaseSvgInfo } from '../core/base-svg';
import {
  baseStemOf,
  classifyJsonFormat,
  classifyUploadFile,
  type PageDocument,
} from '../core/document';
import {
  normalizeGeo,
  normalizeScene,
  sha256OfBytes,
  validateGeo,
  validateScene,
  type Geo,
  type Scene,
} from '../core/page';
import { defaultScene } from '../core/page-layout';
import { PAGE_BASE_SIZE_TOLERANCE_PT } from '../config/page';
import type { MeasureText, TextMeasure } from '../core/types';
import { createTextMeasure } from '../ui/measure-text';
import { createPageOpenPanel } from '../ui/page-open';
import { PageNotifier } from '../ui/page-notify';
import { PageSidebar } from '../ui/page-sidebar';
import { buildPageToolbar } from '../ui/page-toolbar';
import { PageEditor, sceneBaseOf } from './page-editor';

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

/** 一次成功打开得到的全部状态 */
interface OpenedMap {
  readonly document: PageDocument;
  readonly scene: Scene;
  readonly dirty: boolean;
  readonly warnings: readonly string[];
}

/** 按扩展名分桶后的上传文件（JSON 还要按内容里的 format 再分 geo/scene） */
interface UploadBatches {
  readonly svg: readonly File[];
  readonly json: readonly File[];
}

/** 按 format 分好的 JSON 文件 */
interface JsonUploads {
  readonly geos: readonly { readonly fileName: string; readonly value: unknown }[];
  readonly scenes: readonly { readonly fileName: string; readonly value: unknown }[];
}

/** 上传说明：多处错误文案共用同一句提示 */
const UPLOAD_HINT = '需要配套的 base.svg + geo.json（可选 scene.json）';

/** 把异常转成可直接展示的一行中文 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * UTF-8 严格解码：底图/JSON 都必须是 UTF-8 文本，坏字节直接拒绝而不是替换成 U+FFFD。
 * 为什么用 `fatal: true`：sha256 是对原始字节算的，若文本解码有损，后续所有校验都不可信。
 */
function decodeUtf8(bytes: Uint8Array, fileName: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`${fileName} 不是合法的 UTF-8 文本`, { cause });
  }
}

/** 解析 JSON 文本；失败给中文原因（包含文件名） */
function parseJson(text: string, fileName: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`${fileName} 不是合法的 JSON`, { cause });
  }
}

/** 按扩展名分桶；没有底图/geo 或出现不识别文件时直接报错（错误显示在面板上） */
function bucketUploads(files: readonly File[]): UploadBatches {
  if (files.length === 0) throw new Error(`没有收到文件：请选择或拖入 base.svg 与 geo.json`);
  const svg: File[] = [];
  const json: File[] = [];
  const unknown: string[] = [];
  for (const file of files) {
    switch (classifyUploadFile(file.name)) {
      case 'base':
        svg.push(file);
        break;
      case 'geo':
      case 'scene':
      case 'json':
        json.push(file);
        break;
      case 'unknown':
        unknown.push(file.name);
        break;
    }
  }
  if (unknown.length > 0) {
    throw new Error(`不识别的文件：${unknown.join('、')}。${UPLOAD_HINT}`);
  }
  if (svg.length === 0) throw new Error(`缺少底图 .svg：请把 Cartopy 生成的 base.svg 一起上传`);
  if (svg.length > 1) throw new Error(`只能上传一个底图 .svg（收到了 ${svg.length} 个）`);
  if (json.length === 0) throw new Error(`缺少 geo.json：请把与底图配套的 geo.json 一起上传`);
  return { svg, json };
}

/** 读取所有 JSON 文件，按内容里的 `format` 字段分成 geo / scene（扩展名不作为真值） */
async function readJsonUploads(files: readonly File[]): Promise<JsonUploads> {
  const geos: { fileName: string; value: unknown }[] = [];
  const scenes: { fileName: string; value: unknown }[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const value = parseJson(decodeUtf8(bytes, file.name), file.name);
    const format = classifyJsonFormat(value);
    if (format === 'geo') geos.push({ fileName: file.name, value });
    else if (format === 'scene') scenes.push({ fileName: file.name, value });
    else {
      throw new Error(
        `${file.name} 的 format 既不是 mapdoc-geo 也不是 mapdoc-page。${UPLOAD_HINT}`,
      );
    }
  }
  if (geos.length === 0) throw new Error(`缺少 geo.json（没有找到 format=mapdoc-geo 的文件）`);
  if (geos.length > 1) {
    throw new Error(
      `只能上传一个 geo.json（收到了 ${geos.length} 个：${geos.map((item) => item.fileName).join('、')}）`,
    );
  }
  if (scenes.length > 1) {
    throw new Error(
      `只能上传一个 scene.json（收到了 ${scenes.length} 个：${scenes.map((item) => item.fileName).join('、')}）`,
    );
  }
  return { geos, scenes };
}

/** 浮点容差比较（底图与 geo 的尺寸声明） */
function nearPt(left: number, right: number): boolean {
  return Math.abs(left - right) <= PAGE_BASE_SIZE_TOLERANCE_PT;
}

/**
 * 把底图与 geo 固化成 `PageDocument`，并做一致性校验：
 * 底图字节 sha256 == geo.base.sha256；viewBox / width_pt / height_pt 在 0.01pt 容差内一致。
 * 不一致时提示用户用 Cartopy 重新生成**配套**的两份文件（这是最常见的「拿错文件名」错误）。
 */
function buildDocument(
  baseFile: File,
  baseBytes: Uint8Array,
  base: BaseSvgInfo,
  geo: Geo,
): PageDocument {
  const baseSha256 = sha256OfBytes(baseBytes);
  if (geo.base.sha256.toLowerCase() !== baseSha256) {
    throw new Error(
      '底图与 geo.json 不配套（sha256 不一致）：请用 Cartopy 重新生成同名的 base.svg + geo.json',
    );
  }
  const baseBox = base.view_box;
  if (baseBox === null) throw new Error('底图根标签缺少合法的 viewBox，无法确定地图尺寸');
  const geoBox = geo.base.view_box;
  if (!geoBox.every((value, index) => nearPt(value, baseBox[index] ?? Number.NaN))) {
    throw new Error(
      `geo.json 与底图的 viewBox 不一致（底图 ${baseBox.join(' ')}，geo ${geoBox.join(' ')}）：请重新生成配套文件`,
    );
  }
  if (!nearPt(geo.base.width_pt, base.width_pt) || !nearPt(geo.base.height_pt, base.height_pt)) {
    throw new Error(
      `geo.json 与底图的尺寸不一致（底图 ${base.width_pt}×${base.height_pt}pt，geo ${geo.base.width_pt}×${geo.base.height_pt}pt）：请重新生成配套文件`,
    );
  }
  return {
    baseFileName: baseFile.name,
    baseStem: baseStemOf(baseFile.name),
    baseBytes,
    baseSha256,
    base,
    geo,
  };
}

/**
 * 生成初始 scene：上传了 scene.json 且通过校验就用它，否则回退默认排版（脏）。
 * scene 的底图声明与本次底图不一致时只告警并改成真实底图（用户可能只是想接着改旧排版）。
 */
function buildScene(
  geo: Geo,
  document: PageDocument,
  sceneValue: unknown,
  measureText: MeasureText,
): { scene: Scene; dirty: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const makeDefault = (): Scene =>
    defaultScene(geo, sceneBaseOf(document), {
      figure: document.baseFileName,
      measureText,
    });
  if (sceneValue === null) {
    return { scene: makeDefault(), dirty: true, warnings };
  }
  const result = validateScene(sceneValue, geo);
  if (!result.ok) {
    warnings.push(
      `上传的 scene.json 不合法，已改用默认排版：${result.errors.slice(0, 3).join('；')}`,
    );
    return { scene: makeDefault(), dirty: true, warnings };
  }
  const scene = normalizeScene(result.scene);
  warnings.push(...result.warnings);

  let dirty = false;
  const base = sceneBaseOf(document);
  if (
    scene.base.sha256.toLowerCase() !== base.sha256 ||
    !nearPt(scene.base.width_pt, base.width_pt) ||
    !nearPt(scene.base.height_pt, base.height_pt)
  ) {
    warnings.push(
      'scene.json 记录的底图与本次上传的底图不一致，已按新底图更新（排版若错位请重新排默认版式）',
    );
    scene.base = { ...base };
    dirty = true;
  }
  const figureName = document.baseFileName;
  if (scene.figure !== figureName) {
    // 旧 demo scene 的 figure 可能是任意历史路径；无后端后统一记成上传的底图文件名
    scene.figure = figureName;
    dirty = true;
  }

  // geo 没有 relief（Cartopy 不画色标）时，导入排版里的 colorbar 无法合成：
  // 预览会静默跳过、导出 SVG 会抛「色标需要 geo.relief」。与其让用户到导出时才看到失败，
  // 不如在导入时移除并明确告警；保持其他元素位置不变（不触发重排）。
  if (document.geo.relief === null) {
    const colorbars = scene.items.filter((item) => item.kind === 'colorbar');
    if (colorbars.length > 0) {
      scene.items = scene.items.filter((item) => item.kind !== 'colorbar');
      warnings.push(
        `该底图没有 relief 色标数据，已移除导入排版中的 ${colorbars.length} 个色标元素`,
      );
      dirty = true;
    }
  }
  return { scene, dirty, warnings };
}

/** 读取并校验一次上传：任何失败都抛出可直接展示的中文 Error */
async function readOpenedMap(files: readonly File[], measureText: MeasureText): Promise<OpenedMap> {
  const batches = bucketUploads(files);
  const baseFile = batches.svg[0];
  if (!baseFile) throw new Error(`缺少底图 .svg：请把 Cartopy 生成的 base.svg 一起上传`);
  const baseBytes = new Uint8Array(await baseFile.arrayBuffer());
  const baseText = decodeUtf8(baseBytes, baseFile.name);
  const base = readBaseSvg(baseText);
  if (base.errors.length > 0) {
    throw new Error(`底图不符合契约：${base.errors.slice(0, 3).join('；')}`);
  }

  const jsonUploads = await readJsonUploads(batches.json);
  const geoUpload = jsonUploads.geos[0];
  if (!geoUpload) throw new Error(`缺少 geo.json（没有找到 format=mapdoc-geo 的文件）`);
  const geoErrors = validateGeo(geoUpload.value);
  if (geoErrors.length > 0) {
    throw new Error(`geo.json 校验失败：${geoErrors.slice(0, 3).join('；')}`);
  }
  const geo = normalizeGeo(geoUpload.value as Geo);
  const document = buildDocument(baseFile, baseBytes, base, geo);

  const sceneUpload = jsonUploads.scenes[0] ?? null;
  const built = buildScene(
    geo,
    document,
    sceneUpload === null ? null : sceneUpload.value,
    measureText,
  );
  return {
    document,
    scene: built.scene,
    dirty: built.dirty,
    warnings: [...base.warnings, ...built.warnings],
  };
}

function boot(): void {
  const appRoot = document.getElementById('page-app');
  if (!appRoot) throw new Error('map.html 缺少 #page-app');
  const shell = buildShell(appRoot);
  const notifier = new PageNotifier({
    noticesHost: shell.notices,
    messageEl: shell.statusMessage,
    stateEl: shell.statusState,
  });
  // 地图排版要两种口径：宽度（默认版式折行/图例宽度）+ 字体行盒（选中框/命中盒的高度依据）。
  // 同一个适配器同时提供 width，传给只关心宽度的 defaultScene。
  const measureText: TextMeasure = createTextMeasure();

  /** 当前打开的编辑器与预览 objectURL（同一时刻最多一份） */
  let editor: PageEditor | null = null;
  let baseUrl: string | null = null;
  let opening = false;

  const panel = createPageOpenPanel(shell.canvasHost, {
    onFiles: (files) => {
      void openFiles(files);
    },
  });

  /** 关掉当前地图：先停编辑器，再 revoke 预览地址，最后清空侧栏/工具条 */
  function closeSession(): void {
    editor?.destroy();
    editor = null;
    if (baseUrl !== null) {
      URL.revokeObjectURL(baseUrl);
      baseUrl = null;
    }
    shell.sidebar.replaceChildren();
    shell.toolbar.replaceChildren();
  }

  /** 回到上传面板（「打开…」确认后 / 首次进入） */
  function showPanel(): void {
    closeSession();
    panel.reset();
    panel.show();
    notifier.setState('等待选择底图 SVG 与 JSON');
    document.title = '出版排版编辑器';
  }

  /** 「打开…」：有未导出的修改时先确认，确认后才丢弃当前文档 */
  function requestOpen(): void {
    if (editor === null) {
      showPanel();
      return;
    }
    if (!editor.isDirty) {
      showPanel();
      return;
    }
    void notifier
      .ask('当前排版有未导出的修改，打开另一份地图会丢弃它们。继续？')
      .then((accepted) => {
        if (accepted) showPanel();
      });
  }

  /** 一次打开：分类/读取/校验在 `readOpenedMap`，成功后装配编辑器；失败只显示错误 */
  async function openFiles(files: readonly File[]): Promise<void> {
    if (opening) return;
    opening = true;
    panel.setBusy(true);
    panel.setError(null);
    try {
      const opened = await readOpenedMap(files, measureText.width);
      const pageDocument = opened.document;
      closeSession();
      // 预览用 objectURL：Blob 接收 ArrayBuffer 支持的视图，这里复制一份到普通 ArrayBuffer
      const baseBlob = new Blob([new Uint8Array(pageDocument.baseBytes)], {
        type: 'image/svg+xml',
      });
      baseUrl = URL.createObjectURL(baseBlob);

      // 侧栏在构造时就会读一次 scene，而编辑器需要侧栏句柄：用 ref 解开这个先后顺序
      let editorRef: PageEditor | null = null;
      const sidebar = new PageSidebar(shell.sidebar, {
        getScene: () => editorRef?.currentScene ?? opened.scene,
        getGeo: () => pageDocument.geo,
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

      const created = new PageEditor({
        svg: shell.svg,
        sidebar,
        notifier,
        measureText,
        document: pageDocument,
        baseUrl,
        scene: opened.scene,
        dirty: opened.dirty,
      });
      editorRef = created;
      editor = created;

      buildPageToolbar(shell.toolbar, {
        open: requestOpen,
        exportJson: () => {
          created.exportScene();
        },
        exportSvg: () => {
          created.exportFinal();
        },
        fitPage: () => created.fitPage(),
        actualSize: () => created.actualSize(),
        addText: () => created.addText('annotation'),
        addTitle: () => created.addTitle(),
        addLegend: () => created.addLegend(),
        addColorbar: () => created.addColorbar(),
      });
      created.start();
      panel.hide();

      for (const warning of opened.warnings) notifier.error(`排版提示：${warning}`);
      notifier.info(
        opened.dirty ? '已生成初始排版；Ctrl+S 导出 JSON' : '已载入 scene.json；Ctrl+S 导出 JSON',
      );
    } catch (error) {
      // 打开失败不 fatal：面板与消息区给出原因，用户可以修好文件再试
      const message = errorMessage(error);
      panel.setError(message);
      notifier.error(message);
    } finally {
      opening = false;
      panel.setBusy(false);
    }
  }

  // 拖到画布/工具条以外的文件不要让浏览器直接打开（否则会离开编辑器页面）
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    if (!event.defaultPrevented) {
      // 面板可见时它的 drop 监听已经处理过（并 preventDefault），这里只剩「编辑器态误拖」
      notifier.info('要打开另一份底图，请点工具条的「打开…」');
    }
    event.preventDefault();
  });

  showPanel();
}

boot();
