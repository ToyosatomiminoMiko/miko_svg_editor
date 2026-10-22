# SVG 草图板

一个约束求解驱动的 SVG 草图 demo：画点/直线/矩形/圆/圆弧，加几何约束与尺寸标注，导出 SVG。

- 8 个绘图/编辑工具：选择、点、直线、圆、圆弧、矩形、尺寸、删除
- 9 个约束按钮：重合、水平、竖直、平行、垂直、等长、相切、同心、等半径
- 尺寸标注：两点距离、直线长度、圆/弧半径；输入框全精度回填、显示两位小数
- 已选择列表：右上角按选中顺序列出图元与点，可逐项移除；按住任一已选图元/点即可整体拖动全部已选
- 视图与文件：吸附开关、固定、构造、适应视图、导出 SVG、清空

求解器用 LM（Levenberg–Marquardt）+ 数值雅可比，原地求解模型参数；纯逻辑层（model / geometry /
constraints / solver / dimensions 等）不依赖 DOM，可直接在 node 里单测。

## 快速开始

应用 UI 全部基于 [`miko_ui`](https://www.npmjs.com/package/miko_ui)（DOM 原语、控件、布局行、消息区、
主题 token）。依赖声明只有一条 `"miko_ui": "^0.1.19"`，取用分两条链路：

| 场景                 | 命令                               | 解析到哪                                     |
| -------------------- | ---------------------------------- | -------------------------------------------- |
| 线上 / CI / Pages    | `npm ci`                           | registry 上的 `miko_ui@0.1.19`（发布版）     |
| 本地开发（同时改库） | `npm run dev`（`predev` 自动链接） | 本地工作副本 `node_modules/miko_ui` 符号链接 |

```bash
npm ci               # 线上/CI 形态：按 package-lock 装 npm 版
npm run dev          # 本地形态：predev 自动把 node_modules/miko_ui 链到本地库，再起 Vite
npm run build        # tsc --noEmit && vite build，产物在 dist/
npm run preview      # 预览 dist/
```

本地库默认是 `/mnt/IVSTINIANVS/__projects_web/miko_ui`，用 `MIKO_UI_DIR` 指到别的工作副本即可；
链路本身只有三个命令：

```bash
npm run ui:link      # 换成指向本地库的软链（只动被 gitignore 的 node_modules/）
npm run ui:unlink    # 移除软链；之后 npm ci / npm install 还原成 npm 版
npm run ui:status    # 打印当前解析的是本地库还是 npm 版、版本与路径
```

`npm run dev` 会先跑 `predev` 的 `auto`：本地库存在且有 `dist/index.js` 就链接，否则静默跳过
（所以别的机器 / 没有本地库时行为与普通 npm 依赖完全一致）。想刻意验证 npm 版：
`MIKO_UI_LOCAL=0 npm run dev`。链接后改库的 `styles/` 零构建立即生效；改库的 `src/` 仍要在库目录
`npm run build:dist`（或在库里 `npx tsc -p tsconfig.build.json --watch`）。

> 链接态只有 `node_modules/` 会变，CI 与线上 Pages 的 `npm ci` 取用链路一个字节都不变。
> 本机 HOME 不可写时，`npm ci`/`npm install` 需要带工作区缓存：
> `npm_config_cache="$PWD/.npm-cache" npm ci`。

## UI 怎么搭起来的

UI 代码里没有手写控件 DOM，也没有第二套控件 CSS：

| UI 区块           | miko_ui 组件                                                                                                                                                                       | 应用侧只保留                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 工具栏            | `createPanel`（外框）+ `createSegmented`（8 个工具，单选）+ `createButton`（9 个约束 + 5 个动作）+ `createSwitch` / `createInlineToggle`（吸附开关）+ `createControlGroup`（三组） | `.app-toolbar*` 定位与分组布局类         |
| 状态栏 / 状态文案 | `createPanel` + `createValueDisplay<string>`（`<output>` 由 signal 驱动）                                                                                                          | `.app-status*` 定位；`.is-editing` 态    |
| 已选择列表        | `createPanel` + `createObjectRow` / `createRowActions`（行外壳与行末动作）+ `createBadge`（图元/点）+ `createButton`（逐项移除）                                                   | `.app-selection*` 定位与紧凑行样式       |
| 尺寸输入框        | `createNumberField` + `createNumberRow`（文字 + `<input type="number">`）                                                                                                          | `.app-dim-field`（宽度 / 非法红框）      |
| 错误提示          | `createMessageArea` + `MessageList`（`aria-live` 容器、条目外观、自动消失）                                                                                                        | `.app-notices` / `.app-notice-list` 定位 |
| info 提示         | 复用状态栏的 `ValueDisplay`（`flashInfo` 闪示，不占额外位置）                                                                                                                      | 无                                       |
| 清空确认框        | `createPanel`（`role="dialog"`）+ `createButton`（取消 / 确定主按钮变体）                                                                                                          | `.app-confirm-*` 遮罩与按钮变体          |
| 页面外壳          | `create_element`（canvas / 四个 UI 宿主）                                                                                                                                          | `#app` 与画布铺满                        |

样式加载顺序固定为 `miko_ui/styles.css`（token + 字体 + 控件 + 反馈）→ `src/styles.css`（只写页面布局、
`.app-*` 消费者类与 canvas 绘制 token）。画布不是控件，仍由 `Renderer` 用 canvas 2D 绘制；
它的颜色/线宽/虚线只写在应用样式表的 `:root`，`theme.ts` 读取同一批变量（缺失时回退同值并告警）。
点图元在画布上画成外环 + 实心中心，外环半径单独用 `--point-graphic-ring-radius` token，
与线段端点/圆心的小圆点（`--point-radius`）区分。

## 操作说明

### 工具与快捷键

| 工具 | 快捷键 | 操作                                                                               |
| ---- | ------ | ---------------------------------------------------------------------------------- |
| 选择 | `V`    | 点图元/点选中；`Shift` 点击加减选；按住任一已选对象整体拖动；空白拖拽框选          |
| 点   | `P`    | 点击创建独立点；吸附到已有点时复用该点并把它提升为点图元                           |
| 直线 | `L`    | 两次点击成线；之后继续点击可连续画（上一段终点作为下一段起点）                     |
| 圆   | `C`    | 先点圆心，再点半径                                                                 |
| 圆弧 | `A`    | 圆心 → 起点 → 终点；第三击与起点同角（含浮点误差）按整圆处理                       |
| 矩形 | `R`    | 两个对角点；四角优先复用已有点，并自动加水平/竖直约束                              |
| 尺寸 | `D`    | 点两点标距离、点直线标长度、点圆/弧标半径、点已有尺寸改值                          |
| 删除 | `E`    | 点选要删的点或图元；删点会级联删除引用它的图元，删点图元会删除其点与引用该点的约束 |

`S` 开关吸附。其他单键（`V/P/L/C/A/R/D/E`）切换工具，带 `Ctrl`/`Meta`/`Alt` 时忽略。

### 鼠标与视图

- 左键：绘制、拖拽点（拖拽图元时拖它的端点/圆心，点图元即它引用的点；按住任一已选图元/点则整体
  拖动全部已选）、框选。
- 中键或右键拖拽：平移视图。
- 右键单击（没拖动）：取消当前操作（等价于 `Esc`）。
- 滚轮：以指针为锚缩放；缩放范围 0.02–80（`config/limits.ts`）。
- `Delete` / `Backspace`：删除选中对象。删除图元时级联删除「仅被它使用」的端点/圆心及相关约束，
  共享端点与引用共享端点的尺寸保留；删除点会递归删除引用它的图元；删除点图元会删除它引用的点与
  引用该点的约束（该点同时被其它图元使用时保留点本身）。
- `Esc` 的优先级阶梯（从高到低）：**尺寸输入框 → 进行中的框选 → 未完成的工具操作 → 当前工具回选择工具 → 清空选择**。

画布世界坐标 y 向下（与 SVG 一致）；网格间距从 10 起按 2 的幂缩放，使屏幕间距保持在 20–60px。

### 选择与框选

- 点与图元：点击位置既有已有点又落在图元上时选点；点图元的点按图元（`ent`）拾取，线段端点/圆心
  仍按点（`pt`）拾取，同一个点不会以两种身份出现在选择集里。
- `Shift` 点击在已有选择里切换该对象；空白处按下会清空选择（`Shift` 时保留）。
- 框选方向决定语义（由下往上拖 = 交叉，由上往下拖 = 窗口）：
  - **由下往上**：交叉选择，图元与框有任何重叠就选中；
  - **由上往下**：窗口选择，图元必须完全落在框内。
  - 点只按「是否在框内」判定；点图元虽然按图元入选项，判定同样只看它引用的点是否在框内；
    框选结果固定按「先图元后点」写入列表；`Shift` + 框选为累加。
- 单击未选中的对象只选中它；单击已选中的对象会保留整个选择集，并把它作为整体拖动的抓手（不会塌缩成单项）。
- 已选中图元的端点/圆心也按选中态处理：点它们同样能整体拖动，渲染、点击判定与拖拽点集合同一口径；
  点图元按图元对待，拖动它就是拖它引用的那个点。
- 右上「已选择」面板按选中顺序列出全部图元与点（带种类徽章），每行「移除」可逐项从选择集摘掉。
- 选中图元时，它的端点/圆心同时显示为选中态；固定点始终显示为红色。
- 拖拽点集按 id 去重：共享端点只平移一次，不会在同一帧叠加两倍位移。

### 吸附

工具栏「吸附」开关或 `S` 键开关。吸附候选按优先级：**已有点 > 中点 > 曲线上点 > 直线上任意点 > 网格**；
网格容差额外打折（`SNAP_GRID_FACTOR`），避免抢走几何吸附。吸附标记画成十字，落点取吸附位置。
点图元的点也参与最优先的「已有点」候选：其它工具吸附到它会复用同一个点，点工具则提示这里已经有点。
关闭后落点就是鼠标的原始世界坐标。

### 约束按钮

重合、水平、竖直、平行、垂直、等长、相切、同心、等半径。规则：

- 「重合」按选中对象多态分派：2 个点 → `coincident`（两点重合）；1 个点 + 1 条直线 → `pointOnLine`；
  1 个点 + 1 个圆/弧 → `pointOnCircle`。点图元与线段端点/圆心都算点，一次必须恰好选 2 个对象；
  点已经是目标直线的端点、或目标圆/弧的圆心时拒绝（前者是恒成立的假约束，后者会把半径挤成 0）。
  分派表是 `config/constraints-meta.ts` 的 `COINCIDENT_TARGETS`（与 `dimensions.ts` 的 `DIM_META` 同构）。
- 适用性由 `config/constraints-meta.ts` 的元数据决定（例：水平只能用于直线，相切需要「1 直线 + 1 圆/弧」
  或「2 圆/弧」）；
- 不适用时不改模型，用消息区给出原因；
- 按「种类 + 引用字段」去重：同一组引用重复添加会跳过，并在状态栏提示「已跳过 N 个重复约束」；
  重合这类无序约束会先按引用排序，反序选择也落到同一个去重键上；
- 求解后若有约束无法满足或引用了已删除对象，会用消息区提示（不静默失败）。

### 尺寸标注

- 用尺寸工具点两个点标距离（点图元按它引用的点参与，可作两点距离的任一端），点直线标长度
  （同一条线的两个端点），点圆/弧标半径。
- 创建后底部出现输入框：`Enter` 提交、`Esc` 撤销这次新建、点输入框以外按提交处理；
  非法输入保持编辑态（红框 + 悬停/读屏原因）。
- 输入框现在是 miko_ui 的 `<input type="number">`：小数与指数（如 `1.5e3`）仍可输入；
  浏览器会消毒掉 `0x10` 这类非法 token，应用仍按空串/非法值处理并保持红框。
- 再次点击已有尺寸（标注文字或尺寸线）进入编辑；再点同一个图元也会编辑而不是重复创建。
- 回填用全精度 `String(value)`（打开再确认不会静默改写数值），画布上的标注显示保留两位小数；
  输入必须是有限正数（拒绝空串、`0`、负数、`0x10`、`Infinity` 等）。
- 距离尺寸的 `offset` 是**世界偏移**：创建时按当前缩放把 14 屏幕像素换算一次，之后缩放不再改。

### 固定 / 构造 / 适应 / 导出 / 清空

- **固定**：固定选中点与选中图元的端点/圆心（点图元即它引用的点；部分锁定 → 全锁，全锁 → 解锁）；
  固定点不参与求解。
- **构造**：选中的图元（含点图元）在「普通 ↔ 构造」间切换。构造线/构造点在画布与导出里都用虚线，
  但单位不同：canvas 虚线是屏幕像素（`styles.css` 的 `--dash-construction: 5 5`），SVG 导出是用户单位
  （`config/export.ts` 的 `EXPORT_DASH: '5 5'`）。构造点在画布上只画虚线外环、不填实心中心。
- **适应**：按草图包围盒（含留白，点图元也参与）缩放到视口 90%，空草图回到默认缩放与原点。
- **导出SVG**（工具栏按钮名）：导出图元（直线/圆/圆弧/点），约束与尺寸标注不导出；普通点导出为实心小圆
  （半径 = 线宽 × `EXPORT_POINT_RADIUS_FACTOR`），构造点导出为空心虚线圈；整圆弧导出为 `<circle>`，
  部分弧导出为 `<path>` 的 `A` 命令。线宽 = `max(0.2, 包围盒最长边 / 500)`，坐标保留 4 位小数；
  只有点图元时也能导出；没有任何图元时提示「没有可导出的图元」。下载文件名为 `sketch.svg`。
- **清空**：用 miko_ui 的面板 + 按钮自绘确认框（不使用阻塞的 `alert/confirm`）；草图已经为空时在状态栏提示「草图已经是空的」。

### 当前不支持

- 无撤销/重做，无文件保存/打开、无剪贴板；刷新页面即丢失（demo 定位）。
- 没有单独的放大/缩小、平移按钮：滚轮缩放、中键/右键拖拽平移、「适应」按钮已覆盖视图操作；未专门适配触屏/移动端。
- 尺寸与约束不随 SVG 导出（导出只含几何图元，点图元也算图元）。

## 运行与质量门

| 命令                   | 作用                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| `npm run dev`          | `predev` 自动链接本地库（若可用）+ Vite 开发服务器               |
| `npm run build`        | `tsc --noEmit && vite build`，产物到 `dist/`                     |
| `npm run preview`      | 预览 `dist/`                                                     |
| `npm run typecheck`    | `tsc --noEmit`（strict + `noUncheckedIndexedAccess`）            |
| `npm run lint`         | `eslint .`                                                       |
| `npm run format`       | `prettier --write .`                                             |
| `npm run format:check` | `prettier --check .`                                             |
| `npm run test`         | `vitest run`（node 环境，`tests/**/*.test.ts`）                  |
| `npm run check`        | typecheck → lint → format:check → test → build，一条命令跑全部门 |
| `npm run ui:link`      | 把 `node_modules/miko_ui` 链到本地库工作副本                     |
| `npm run ui:unlink`    | 移除本地库软链（之后 `npm ci` 还原 npm 版）                      |
| `npm run ui:status`    | 打印当前 miko_ui 解析来源（本地库 / npm 版）与版本               |

**TypeScript 7 与 eslint 的由来**：项目用 TypeScript 7（原生 Go 版编译器），它不再导出 JS 编译器 API，
上游 `typescript-eslint`（peer `<6.1.0`）在 import 时会直接拒绝 TS 7。因此 devDependencies 用
[`ts7-eslint`](https://www.npmjs.com/package/ts7-eslint)：它在 `typescript/unstable/*` 上重建编译器适配层，
运行同一套 `@typescript-eslint` 规则，所以规则配置写法与上游一致。它不支持 `parserOptions.projectService`，
本项目是单 tsconfig，直接在 `eslint.config.js` 里显式 `project: './tsconfig.json'`。

CI（`.github/workflows/ci.yml`）：Node 24，`npm ci`（registry 上的 miko_ui 发布版）→ 打印
`npm ls miko_ui` / `npm run ui:status` 备查 → `typecheck` → `lint` → `test` → `build`。
`npm run check` 在本地额外包含 `format:check`。CI 不跑 `predev`，因此永远拿不到本地库软链。

### ESLint 规则要点

- `@typescript-eslint` 的 `recommendedTypeChecked`（类型感知）+ `js.configs.recommended`；
- 显式 error：`switch-exhaustiveness-check`、`no-alert`、`no-restricted-globals: alert/confirm`、
  `no-console`、`naming-convention`（类型/接口/类 PascalCase，变量/函数 camelCase，常量允许 `UPPER_CASE`）；
- 依赖分层：纯逻辑层（`src/{model,geometry,constraints,solver,dimensions,entities,vec,camera}.ts` 与
  `src/config/**`）禁止 import `renderer/editor/toolbar/main/theme/ui`，需要视图数据时改为参数注入；
- `eslint-config-prettier` 收尾，避免格式规则与 Prettier 冲突。

## 目录结构

```text
index.html                   仅一个 #app 挂载点；画布与全部 UI 由 main.ts 用 miko_ui 装配
src/
  main.ts                    入口：用 miko_ui 建外壳（canvas + 四个 UI 宿主）、引样式、组装 Editor 与工具栏
  editor.ts                  控制器：指针/键盘事件接线 + 手势状态机（拖拽/平移/框选）+ Esc 阶梯
  renderer.ts                canvas 渲染：网格、图元（含点图元）、点、尺寸、预览、框选、吸附标记
  theme.ts                   从应用样式 src/styles.css :root 读一次 Theme（带默认值兜底），注入 Renderer
  styles.css                 应用样式：页面布局 + .app-* 消费者类 + canvas 绘制 token；控件外观来自 miko_ui
  types.ts                   数据模型静态类型（Entity/Constraint/Pending/SelectionItem/Selection/EditorState 等）
  state.ts                   交互状态单例（工具/光标/吸附/悬停/pending/选择/框选）+ 有序选择集操作
  model.ts                   点/图元/约束容器与增删查、级联清理、点图元归属/孤立点回收（包围盒在 geometry.sketchBounds）
  entities.ts                图元类型分派（引用点 id、尺寸目标、种类→大类守卫）；assertNever 穷尽兜底
  geometry.ts                拾取/吸附/包围盒/框选相交判定（含点图元；不读全局相机，zoom 作参数）
  constraints.ts             约束引用校验 + 各类残差方程表 RESID（Record 强制穷尽）
  solver.ts                  LM 求解器：自由度组装、数值雅可比、阻尼迭代、invalidConstraints
  dimensions.ts              尺寸单一元数据表 DIM_META：取值/设值/布局/命中/图元匹配
  export-svg.ts              纯 SVG 导出（buildSVG，含点图元）；下载适配器在 ui/download.ts
  camera.ts                  世界 ↔ 屏幕换算、缩放范围、网格间距（纯函数）
  viewport.ts                视图交互写入口：适应视图、滚轮缩放、平移
  vec.ts                     二维向量纯函数（含 safeLen / unitPerp 的零向量约定）
  tools.ts                   8 个工具元数据（顺序/快捷键/提示文案）
  toolbar.ts                 工具栏：miko_ui 的面板 / 分段按钮组 / 按钮 / 开关 / 控制组
  selection.ts               选择语义：单击/Shift/框选方向与结果；多选整体拖动的拖拽点集与已选列表数据（点图元按 ent）
  sketch-actions.ts          草图领域操作 + 点击状态机（画图/约束/删除/固定/构造/尺寸）
  ui/
    editor-controls.ts       工具栏命令实现与唯一同步入口 sync()（render + 已选列表 + 状态栏）
    selection-list.ts        「已选择」列表面板：miko_ui Panel / ObjectRow / Badge / Button
    hint-editor.ts           状态栏 + 尺寸输入：miko_ui Panel / ValueDisplay / NumberField / NumberRow
    parse-dim-input.ts       尺寸输入纯解析（node 可测，无 DOM）
    notify.ts                错误提示进 miko_ui MessageArea；info 走状态栏；确认框用 Panel + Button
    download.ts              Blob/<a download>/objectURL 下载适配器
    measure-text.ts          canvas measureText 适配器（无 canvas 时回退估算）
  config/
    index.ts                 汇总出口，业务统一从 './config' 引入
    angle.ts                 TAU / sweepOf / normalizeAngle / wrapPi / 弧段数
    constraints-meta.ts      18 种约束元数据、9 个按钮动作 resolve、重合多态表、去重键、引用字段推导
    export.ts                导出标定：颜色/线宽/精度/文件名/虚线/点半径/空图文案
    format.ts                formatNumber / formatDimValue（显示格式，与回填全精度分开）
    limits.ts                缩放/网格/留白/退化阈值/初始 id 序列/尺寸默认偏移
    solver.ts                LM 迭代预算、收敛阈值、λ 超参、数值雅可比步长
    tolerances.ts            拾取/吸附/尺寸命中/拖拽阈值（屏幕像素）+ worldTol + SNAP_PRIORITY
    ui.ts                    无法用 CSS 表达的几何/交互常量（滚轮灵敏度、自动轴向比例等）
tests/                       纯逻辑层 node 环境测试（文件/用例数见 `npm run test`，详见「测试约定」）
scripts/dev_ui_link.mjs      本地库 / npm 发布版切换（link / unlink / status / auto）
eslint.config.js             ESLint 扁平配置（含纯逻辑层 import 限制）
vitest.config.ts             Vitest：node 环境、include tests/**/*.test.ts、关闭 globals
tsconfig.json                strict + noUncheckedIndexedAccess；include src/tests/配置
vite.config.ts               base: './'；本地库存在时把它的路径加入 server.fs.allow，并 dedupe signals
.prettierrc.json             单引号 / printWidth 100 / trailingComma all / semi
.prettierignore              dist、node_modules、audit、package-lock、.npm-cache、coverage
.github/workflows/ci.yml      CI：Node 24 → npm ci → typecheck → lint → test → build
```

## 依赖方向与配置分层

- **纯逻辑层不依赖 UI/视图**：model、geometry、constraints、solver、dimensions、entities、vec、camera、config
  （以及 state / selection / sketch-actions / export-svg / viewport）都不 import renderer/editor/toolbar/main/theme/ui，
  可在 node 直接测；其中前一组由 ESLint 的 `no-restricted-imports` 强制（根目录纯模块与 `config/`
  分别按相对路径深度配置），后一组靠约定与 code review。
- **视图数据靠参数注入**：几何拾取/吸附接收 `zoom`；尺寸布局接收 `CameraView` 快照；
  文字宽度接收 `MeasureText` 函数；渲染接收 `Theme`。
- **UI 层只用 miko_ui 搭建**：`main.ts` / `toolbar.ts` / `ui/*` 里不手写控件 DOM、不写第二套控件 CSS；
  节点来自 `miko_ui` 的公开面（`create_element` / `createPanel` / `createButton` / `createSegmented` /
  `createSwitch` / `createNumberField` / `createValueDisplay` / `createMessageArea` 等）。
  应用样式表只写页面布局、`.app-*` 消费者类与 canvas 绘制 token（`create_element` 是库的 DOM 原语，
  不是应用自己 `document.createElement`）。
- **主题只读一次**：`main.ts` 调 `readTheme()`，再把 `Theme` 传给 `Renderer`/`Editor`；
  纯逻辑模块不读 `getComputedStyle`。界面控件的配色不归应用：那是 `miko_ui` 的 token 体系。
- **配置分层**（按「外观 / 手感 / 数值 / 导出 / 元数据」拆分，变更频率不同）：
  - 外观（颜色/线宽/点半径/点图元外环半径/虚线/箭头/字体）→ `src/styles.css :root`，`theme.ts` 读取；
    `theme.ts` 里的默认值必须与 CSS 保持一致（改 token 要同时改两处兜底值）。
  - 交互手感（拾取/吸附/命中/拖拽阈值）→ `config/tolerances.ts`，屏幕像素声明、用时 `worldTol(px, zoom)` 换算。
  - 视图/模型上下限 → `config/limits.ts`。
  - 数值算法（角度、LM 超参、迭代预算、收敛阈值）→ `config/angle.ts`、`config/solver.ts`。
  - 导出标定（颜色/线宽/精度/文件名/虚线/点半径）→ `config/export.ts`，导出不读 canvas 主题。
  - 元数据表 → `config/constraints-meta.ts`（约束与重合多态表 `COINCIDENT_TARGETS`）与
    `dimensions.ts` 的 `DIM_META`（尺寸）。
- **单一来源**：常量与文案只写一处，`config/index.ts` 统一出口；业务代码不深引 config 内部文件。

## 约定与扩展点

### 注释

每个文件的注释只描述本文件内发生的事（依赖其他文件时说明依赖关系），并且只允许三类内容：

1. **是什么**：这段代码/文件的职责；
2. **为什么**：原理、公式、推导、可能的坑、警告（例如为什么整圆弧要按 `TAU` 而不是 `0`）；
3. **元信息**：作者、时间等。

### 新增图元

1. `types.ts`：加入 `Entity` 联合成员；像 `PointEntity { type:'point', p }` 这种「包装已有自由度」的图元，
   要在注释里写清点归属关系；
2. `entities.ts`：`entityPointIds` / `entityDimTarget` 的 switch（`assertNever` 会逼你补分支）；并在
   `ENTITY_CATEGORY` 里把新种类归入 `line` / `curve` / `point`——这张表是 `satisfies Record<EntityKind, …>`，
   漏归类直接编译失败。曲线类判断统一用推导出的 `isCurveEntity` 守卫（`CurveEntity` 也由该表推导），
   不要在调用点写 `type !== 'circle' && type !== 'arc'`；
3. `model.ts`：`addXxx()`，级联删除复用 `entityPointIds`；若图元独占已有对象，还要补类似
   `addPointEntity` / `pointEntityOf` / `ownedPointIds` 的归属查询；
4. `geometry.ts`：`entitySamples` / `entityBounds` 的 switch（拾取/吸附/包围盒/框选）；
   点图元这类零尺寸图元要在 `pickPoint` 里跳过、由 `pickEntity` 用点拾取容差命中，否则同一对象会有
   `pt` / `ent` 两种选择身份；
5. `renderer.ts`：`drawEntity` 的 switch；若该图元包装的是普通点，渲染循环里要跳过它的点（`ownedPointIds`）；
6. `export-svg.ts`：`buildSVG` 的 switch（不导出就显式跳过）；
7. `tools.ts` / `sketch-actions.ts`：工具入口与创建/点击状态机（点图元即 `createPoint` + `toolClick('point')`）；
8. `selection.ts`：框选/拾取遍历 `model.pts` 时跳过 `ownedPointIds()`，避免同一个点在已选列表出现两行；
9. `tests/`：补创建、拾取、包围盒、导出用例。

### 新增约束种类

1. `types.ts`：`ConstraintKind` 联合 + `Constraint` 的引用字段；
2. `config/constraints-meta.ts`：`CONSTRAINT_META` 加记录（label/ui/refs，refs 决定去重键与 model 的
   `ENTITY_REF_KEYS`/`POINT_REF_KEYS` 推导）；有按钮入口再往 `CONSTRAINT_ACTIONS` 加 `resolve`，
   它接收 `ConstraintSelection { entities, points }`（点图元会被展开成它引用的点 id）。一个按钮要按
   选中类型生成不同 kind 时（相切、重合都是），照 `COINCIDENT_TARGETS` 写一张多态表，不要散写 if/else；
3. `constraints.ts`：`RESID` 是 `Record<ConstraintKind, …>`，漏写会编译失败；
4. `solver.ts` 无需改（自由度与残差表解耦）；`sketch-actions.ts` 的 `applyConstraint` 查表即用；
5. `tests/constraints-meta.test.ts` / `solver.test.ts` 补合法/非法/收敛用例。

### 新增尺寸种类

1. `dimensions.ts`：`DimKind` 联合 + `DIM_META` 一条记录（label/value/setValue/layout/matchesEntity/
   `matchesPoints?`）；`DimKind` 的 `Record` 会强制穷尽；
2. 在 `sketch-actions.ts` 里接上创建入口（如 `dimForEntity`/`dimForPoints`）与命中查找；点图元没有
   独立尺寸目标（`entityDimTarget` 返回 null），它只作为两点距离的一端，入口在点击状态机的
   `dimStep` / `finishPointDim` 里把 `e.p` 展开成点 id；
3. `tests/dimensions.test.ts` 补布局/命中/编辑用例。

### 约束现状与构造线

- **9 个约束按钮**：重合、水平、竖直、平行、垂直、等长、相切、同心、等半径。「相切」按选中类型映射到
  `tangentLineCircle` 或 `tangentCircleCircle`；「重合」按选中对象多态分派到 `coincident` / `pointOnLine` /
  `pointOnCircle`（多态表见 `config/constraints-meta.ts` 的 `COINCIDENT_TARGETS`）。另有
  `distancePointPoint`（距离）与 `radius`（半径）两种尺寸类约束，入口在尺寸工具，不在约束按钮区。
- **暂无 UI 入口但有残差/求解支持的 4 种**：`distancePointLine`（点到线距离）、`angle`（角度）、
  `midpoint`（中点）、`symmetric`（对称）。它们可经 `model.addCon()` 在代码/测试里使用，接 UI 时在
  `CONSTRAINT_ACTIONS` 加动作即可。
- 构造线是图元属性而不是约束：由工具栏「构造」切换，只影响虚线与导出样式，不参与求解；点图元同样有
  构造属性，构造点在画布上只画虚线外环、导出为空心的虚线小圆。

### 测试约定

- node 环境、无 DOM；测试显式 `import { describe, it, expect } from 'vitest'`（不开 globals）；
- 直接测纯逻辑模块（model/geometry/dimensions/solver/export-svg/selection/sketch-actions/parse-dim-input 等），
  用 `model.clearModel()` 隔离单例 fixture；
- 需要视图数据时传假 `CameraView` / 假 `MeasureText`，不 mock 全局 camera 的渲染；
- 测试文件与用例数不在这里写死：见 `npm run test`，当前全部通过。

## 许可

GNU AGPL-3.0，见 `LICENSE`。
