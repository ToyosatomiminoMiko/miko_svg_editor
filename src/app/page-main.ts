/**
 * 出版排版编辑器（map.html）的组合根。
 *
 * 是什么：建三栏外壳（顶部工具条 / 画布 / 右侧属性面板 + 底部状态行）→ 在画布里显示上传面板
 * → 用户在 SVG / JSON 两个选择栏里选/拖入文件 → 读取原始字节交给 `core/open-map.ts`
 * （UTF-8 解码/分栏/校验都在 core）得到 `PageDocument` 与初始排版 → 为预览建 objectURL
 * → 装配侧栏、编辑器与工具条并启动。
 * 为什么组合根只有这一份：`core`/`render`/`ui` 都不允许认识彼此的全部依赖，只有 app 层
 * 可以同时装配文件读取、SVG 预览、miko_ui 面板与交互状态机。页面是纯静态的，不认识任何 HTTP 接口。
 * 打开支持的三条路径（校验细节全在 core，见 `docs/PAGE-EDITOR.md` §8）：
 * 1. Cartopy 的 `base.svg + geo.json`；
 * 2. 只选一份本编辑器导出的成品 SVG（内嵌整份 geo.json 与底图前后缀，单文件即可再编辑）；
 * 3. 成品 SVG + 配套 `geo.json`（旧版成品没有内嵌源时的迁移路径）。
 * 本文件只做两件 core 不该做的事：把 `File` 读成字节、把面板/侧栏/工具条装配起来。
 * 样式导入顺序是契约：先 miko_ui 的 token/控件，再应用的页面 token（styles.css），
 * 最后本页专属的 `.page-*`（styles-page.css）。
 * 元信息：作者 frontend，2026-10-27；2026-10-28 改为无后端（上传打开 + 浏览器内合成）；
 *         2026-10-29 打开逻辑移入 core/open-map.ts 并支持成品 SVG 再编辑。
 */

import 'miko_ui/styles.css';
import '../styles.css';
import '../styles-page.css';
import { create_element, create_svg_element } from 'miko_ui';
import { openMapFromUploads, type MapUploadFile } from '../core/open-map';
import type { TextMeasure } from '../core/types';
import { createTextMeasure } from '../ui/measure-text';
import { createPageOpenPanel } from '../ui/page-open';
import { PageNotifier } from '../ui/page-notify';
import { PageSidebar } from '../ui/page-sidebar';
import { buildPageToolbar } from '../ui/page-toolbar';
import { PageEditor } from './page-editor';

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
  // 同一个适配器同时提供 width，传给只关心宽度的 defaultPageLayout。
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
    notifier.setState('等待选择底图 SVG 与 geo.json（或成品 SVG）');
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

  /** 一次打开：读原始字节交给 core 打开流程，成功后装配编辑器；失败只显示错误 */
  async function openFiles(files: readonly File[]): Promise<void> {
    if (opening) return;
    opening = true;
    panel.setBusy(true);
    panel.setError(null);
    try {
      const uploads: MapUploadFile[] = [];
      for (const file of files) {
        uploads.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      }
      const opened = openMapFromUploads(uploads, { measureText: measureText.width });
      const pageDocument = opened.document;
      closeSession();
      // 预览用 objectURL：Blob 接收 ArrayBuffer 支持的视图，这里复制一份到普通 ArrayBuffer
      const baseBlob = new Blob([new Uint8Array(pageDocument.baseBytes)], {
        type: 'image/svg+xml',
      });
      baseUrl = URL.createObjectURL(baseBlob);

      // 侧栏在构造时就会读一次 layout，而编辑器需要侧栏句柄：用 ref 解开这个先后顺序
      let editorRef: PageEditor | null = null;
      const sidebar = new PageSidebar(shell.sidebar, {
        getLayout: () => editorRef?.currentLayout ?? opened.layout,
        getGeo: () => pageDocument.geo,
        onChange: (mutate) => {
          editorRef?.applyPageChange(mutate);
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
        layout: opened.layout,
        dirty: opened.dirty,
      });
      editorRef = created;
      editor = created;

      buildPageToolbar(shell.toolbar, {
        open: requestOpen,
        exportGeo: () => {
          created.exportGeo();
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
        opened.dirty
          ? '已生成初始排版；Ctrl+S 导出 geo.json'
          : opened.source === 'base'
            ? '已载入 geo.json 中的排版；Ctrl+S 导出 geo.json'
            : '已从成品 SVG 恢复排版；Ctrl+S 导出 geo.json',
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
