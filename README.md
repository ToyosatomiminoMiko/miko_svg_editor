# SVG 草图板

一个约束求解驱动的 SVG 草图 demo：画直线/矩形/圆/圆弧，加几何约束与尺寸标注，导出 SVG。

- 7 个绘图/编辑工具：选择、直线、圆、圆弧、矩形、尺寸、删除
- 8 个约束按钮：水平、竖直、平行、垂直、等长、相切、同心、等半径
- 尺寸标注：两点距离、直线长度、圆/弧半径；输入框全精度回填、显示两位小数
- 视图与文件：吸附开关、固定、构造线、适应视图、导出 SVG、清空

求解器用 LM（Levenberg–Marquardt）+ 数值雅可比，原地求解模型参数；纯逻辑层（model / geometry /
constraints / solver / dimensions 等）不依赖 DOM，可直接在 node 里单测。

## 快速开始

```bash
npm install
npm run dev        # 开发服务器（Vite）
npm run build      # tsc --noEmit && vite build，产物在 dist/
npm run preview    # 预览 dist/
```

## 操作说明

### 工具与快捷键

| 工具 | 快捷键 | 操作                                                           |
| ---- | ------ | -------------------------------------------------------------- |
| 选择 | `V`    | 点图元/点选中；`Shift` 点击加减选；空白拖拽框选                |
| 直线 | `L`    | 两次点击成线；之后继续点击可连续画（上一段终点作为下一段起点） |
| 圆   | `C`    | 先点圆心，再点半径                                             |
| 圆弧 | `A`    | 圆心 → 起点 → 终点；第三击与起点同角（含浮点误差）按整圆处理   |
| 矩形 | `R`    | 两个对角点；四角优先复用已有点，并自动加水平/竖直约束          |
| 尺寸 | `D`    | 点两点标距离、点直线标长度、点圆/弧标半径、点已有尺寸改值      |
| 删除 | `E`    | 点击要删的点或图元（点击点会级联删除引用它的图元）             |

`S` 开关吸附。其他单键（`V/L/C/A/R/D/E`）切换工具，带 `Ctrl`/`Meta`/`Alt` 时忽略。

### 鼠标与视图

- 左键：绘制、拖拽点（拖拽图元时拖它的端点/圆心）、框选。
- 中键或右键拖拽：平移视图。
- 右键单击（没拖动）：取消当前操作（等价于 `Esc`）。
- 滚轮：以指针为锚缩放；缩放范围 0.02–80（`config/limits.ts`）。
- `Delete` / `Backspace`：删除选中对象。删除图元时级联删除「仅被它使用」的端点/圆心及相关约束，
  共享端点与引用共享端点的尺寸保留；删除点会递归删除引用它的图元。
- `Esc` 的优先级阶梯（从高到低）：**尺寸输入框 → 进行中的框选 → 未完成的工具操作 → 当前工具回选择工具 → 清空选择**。

画布世界坐标 y 向下（与 SVG 一致）；网格间距从 10 起按 2 的幂缩放，使屏幕间距保持在 20–60px。

### 选择与框选

- 点优先于图元：点击位置既有已有点又落在图元上时，选点。
- `Shift` 点击在已有选择里切换该对象；空白处按下会清空选择（`Shift` 时保留）。
- 框选方向决定语义（由下往上拖 = 交叉，由上往下拖 = 窗口）：
  - **由下往上**：交叉选择，图元与框有任何重叠就选中；
  - **由上往下**：窗口选择，图元必须完全落在框内。
  - 点只按「是否在框内」判定；`Shift` + 框选为累加。
- 选中图元时，它的端点/圆心同时显示为选中态；固定点始终显示为红色。

### 吸附

工具栏「吸附」按钮或 `S` 键开关。吸附候选按优先级：**已有点 > 中点 > 曲线上点 > 直线上任意点 > 网格**；
网格容差额外打折（`SNAP_GRID_FACTOR`），避免抢走几何吸附。吸附标记画成十字，落点取吸附位置。
关闭后落点就是鼠标的原始世界坐标。

### 约束按钮

水平、竖直、平行、垂直、等长、相切、同心、等半径。规则：

- 适用性由 `config/constraints-meta.ts` 的元数据决定（例：水平只能用于直线，相切需要「1 直线 + 1 圆/弧」或「2 圆/弧」）；
- 不适用时不改模型，用 toast 给出原因；
- 按「种类 + 引用字段」去重：同一组引用重复添加会跳过，并提示「已跳过 N 个重复约束」；
- 求解后若有约束无法满足或引用了已删除对象，会用 toast 提示（不静默失败）。

### 尺寸标注

- 用尺寸工具点两个点标距离，点直线标长度（同一条线的两个端点），点圆/弧标半径。
- 创建后底部出现输入框：`Enter` 提交、`Esc` 撤销这次新建、点输入框以外按提交处理；
  非法输入保持编辑态（红框 + 悬停原因）。
- 再次点击已有尺寸（标注文字或尺寸线）进入编辑；再点同一个图元也会编辑而不是重复创建。
- 回填用全精度 `String(value)`（打开再确认不会静默改写数值），画布上的标注显示保留两位小数；
  输入必须是有限正数（拒绝空串、`0`、负数、`0x10`、`Infinity` 等）。
- 距离尺寸的 `offset` 是**世界偏移**：创建时按当前缩放把 14 屏幕像素换算一次，之后缩放不再改。

### 固定 / 构造 / 适应 / 导出 / 清空

- **固定**：固定选中点与选中图元的端点/圆心（部分锁定 → 全锁，全锁 → 解锁）；固定点不参与求解。
- **构造**：选中的图元在「普通 ↔ 构造线」间切换。构造线在画布与导出里都用虚线，但单位不同：
  canvas 虚线是屏幕像素（`styles.css` 的 `--dash-construction: 5 5`），SVG 导出是用户单位（`config/export.ts` 的 `EXPORT_DASH: '5 5'`）。
- **适应**：按草图包围盒（含留白）缩放到视口 90%，空草图回到默认缩放与原点。
- **导出SVG**（工具栏按钮名）：只导出图元（直线/圆/圆弧），点、约束、尺寸标注不导出；整圆弧导出为 `<circle>`，
  部分弧导出为 `<path>` 的 `A` 命令。线宽 = `max(0.2, 包围盒最长边 / 500)`，坐标保留 4 位小数；
  空草图提示「没有可导出的图元」。下载文件名为 `sketch.svg`。
- **清空**：自绘确认框（不使用阻塞的 `alert/confirm`）；草图已经为空时提示「草图已经是空的」。

### 当前不支持

- 无撤销/重做，无文件保存/打开、无剪贴板；刷新页面即丢失（demo 定位）。
- 没有单独的放大/缩小、平移按钮：滚轮缩放、中键/右键拖拽平移、「适应」按钮已覆盖视图操作；未专门适配触屏/移动端。
- 尺寸与约束不随 SVG 导出（导出只含几何图元）。

## 运行与质量门

| 命令                   | 作用                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| `npm run dev`          | Vite 开发服务器                                                  |
| `npm run build`        | `tsc --noEmit && vite build`，产物到 `dist/`                     |
| `npm run preview`      | 预览 `dist/`                                                     |
| `npm run typecheck`    | `tsc --noEmit`（strict + `noUncheckedIndexedAccess`）            |
| `npm run lint`         | `eslint .`                                                       |
| `npm run format`       | `prettier --write .`                                             |
| `npm run format:check` | `prettier --check .`                                             |
| `npm run test`         | `vitest run`（node 环境，`tests/**/*.test.ts`）                  |
| `npm run check`        | typecheck → lint → format:check → test → build，一条命令跑全部门 |

**TypeScript 7 与 eslint 的由来**：项目用 TypeScript 7（原生 Go 版编译器），它不再导出 JS 编译器 API，
上游 `typescript-eslint`（peer `<6.1.0`）在 import 时会直接拒绝 TS 7。因此 devDependencies 用
[`ts7-eslint`](https://www.npmjs.com/package/ts7-eslint)：它在 `typescript/unstable/*` 上重建编译器适配层，
运行同一套 `@typescript-eslint` 规则，所以规则配置写法与上游一致。它不支持 `parserOptions.projectService`，
本项目是单 tsconfig，直接在 `eslint.config.js` 里显式 `project: './tsconfig.json'`。

CI（`.github/workflows/ci.yml`）：Node 24，`npm ci` → `typecheck` → `lint` → `test` → `build`。
`npm run check` 在本地额外包含 `format:check`。

### ESLint 规则要点

- `@typescript-eslint` 的 `recommendedTypeChecked`（类型感知）+ `js.configs.recommended`；
- 显式 error：`switch-exhaustiveness-check`、`no-alert`、`no-restricted-globals: alert/confirm`、
  `no-console`、`naming-convention`（类型/接口/类 PascalCase，变量/函数 camelCase，常量允许 `UPPER_CASE`）；
- 依赖分层：纯逻辑层（`src/{model,geometry,constraints,solver,dimensions,entities,vec,camera}.ts` 与
  `src/config/**`）禁止 import `renderer/editor/toolbar/main/theme/ui`，需要视图数据时改为参数注入；
- `eslint-config-prettier` 收尾，避免格式规则与 Prettier 冲突。

## 目录结构

```text
index.html                   仅结构（canvas / 工具栏 / 底部提示与尺寸输入框），无内联 CSS/JS
src/
  main.ts                    入口：读主题、创建文本测量器、取 DOM 节点、组装 Editor 与工具栏
  editor.ts                  控制器：指针/键盘事件接线 + 手势状态机（拖拽/平移/框选）+ Esc 阶梯
  renderer.ts                canvas 渲染：网格、图元、点、尺寸、预览、框选、吸附标记
  theme.ts                   从 styles.css :root 读一次 Theme（带默认值兜底），注入 Renderer
  styles.css                 全部画布与 UI 样式；设计 token 集中在 :root
  types.ts                   数据模型静态类型（Entity/Constraint/Pending/Selection/EditorState 等）
  state.ts                   交互状态单例（工具/光标/吸附/悬停/pending/选择/框选）+ 选择集操作
  model.ts                   点/图元/约束的单例容器与增删查、级联清理（包围盒在 geometry.sketchBounds）
  entities.ts                图元类型分派（端点 id、尺寸目标）；assertNever 穷尽兜底
  geometry.ts                拾取、吸附、包围盒、框选相交判定（不读全局相机，zoom 作参数）
  constraints.ts             约束引用校验 + 各类残差方程表 RESID（Record 强制穷尽）
  solver.ts                  LM 求解器：自由度组装、数值雅可比、阻尼迭代、invalidConstraints
  dimensions.ts              尺寸单一元数据表 DIM_META：取值/设值/布局/命中/图元匹配
  export-svg.ts              纯 SVG 导出（buildSVG）；下载适配器在 ui/download.ts
  camera.ts                  世界 ↔ 屏幕换算、缩放范围、网格间距（纯函数）
  viewport.ts                视图交互写入口：适应视图、滚轮缩放、平移
  vec.ts                     二维向量纯函数（含 safeLen / unitPerp 的零向量约定）
  tools.ts                   7 个工具元数据（顺序/快捷键/提示文案）
  toolbar.ts                 工具栏 DOM 构建（工具 + 约束 + 开关/视图/导出按钮）
  selection.ts               选择语义：单击/Shift/框选方向与结果，写 state.selection
  sketch-actions.ts          草图领域操作 + 点击状态机（画图/约束/删除/固定/构造/尺寸）
  ui/
    editor-controls.ts       工具栏命令实现与唯一同步入口 sync()（render + 提示栏）
    hint-editor.ts           尺寸输入框 DOM 生命周期、提交/取消、非法态（解析在 parse-dim-input）
    parse-dim-input.ts       尺寸输入纯解析（node 可测，无 DOM）
    notify.ts                toast 与自绘确认框（overlays.css 定义外观）
    download.ts              Blob/<a download>/objectURL 下载适配器
    measure-text.ts          canvas measureText 适配器（无 canvas 时回退估算）
    overlays.css             toast / 确认框样式
  config/
    index.ts                 汇总出口，业务统一从 './config' 引入
    angle.ts                 TAU / sweepOf / normalizeAngle / wrapPi / 弧段数
    constraints-meta.ts      18 种约束元数据、8 个按钮动作 resolve、去重键、引用字段推导
    export.ts                导出标定：颜色/线宽/精度/文件名/虚线/空图文案
    format.ts                formatNumber / formatDimValue（显示格式，与回填全精度分开）
    limits.ts                缩放/网格/留白/退化阈值/初始 id 序列/尺寸默认偏移
    solver.ts                LM 迭代预算、收敛阈值、λ 超参、数值雅可比步长
    tolerances.ts            拾取/吸附/尺寸命中/拖拽阈值（屏幕像素）+ worldTol + SNAP_PRIORITY
    ui.ts                    无法用 CSS 表达的几何/交互常量（滚轮灵敏度、自动轴向比例等）
tests/                       12 个测试文件、220 个 node 环境测试（见「测试约定」）
eslint.config.js             ESLint 扁平配置（含纯逻辑层 import 限制）
vitest.config.ts             Vitest：node 环境、include tests/**/*.test.ts、关闭 globals
tsconfig.json                strict + noUncheckedIndexedAccess；include src/tests/配置
vite.config.ts               base: './'（产物可直接放静态目录）
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
- **主题只读一次**：`main.ts` 调 `readTheme()`，再把 `Theme` 传给 `Renderer`/`Editor`；
  纯逻辑模块不读 `getComputedStyle`。
- **配置分层**（按「外观 / 手感 / 数值 / 导出 / 元数据」拆分，变更频率不同）：
  - 外观（颜色/线宽/点半径/虚线/箭头/字体）→ `src/styles.css :root`，`theme.ts` 读取；
    `theme.ts` 里的默认值必须与 CSS 保持一致（改 token 要同时改两处兜底值）。
  - 交互手感（拾取/吸附/命中/拖拽阈值）→ `config/tolerances.ts`，屏幕像素声明、用时 `worldTol(px, zoom)` 换算。
  - 视图/模型上下限 → `config/limits.ts`。
  - 数值算法（角度、LM 超参、迭代预算、收敛阈值）→ `config/angle.ts`、`config/solver.ts`。
  - 导出标定（颜色/线宽/精度/文件名/虚线）→ `config/export.ts`，导出不读 canvas 主题。
  - 元数据表 → `config/constraints-meta.ts`（约束）与 `dimensions.ts` 的 `DIM_META`（尺寸）。
- **单一来源**：常量与文案只写一处，`config/index.ts` 统一出口；业务代码不深引 config 内部文件。

## 约定与扩展点

### 注释

每个文件的注释只描述本文件内发生的事（依赖其他文件时说明依赖关系），并且只允许三类内容：

1. **是什么**：这段代码/文件的职责；
2. **为什么**：原理、公式、推导、可能的坑、警告（例如为什么整圆弧要按 `TAU` 而不是 `0`）；
3. **元信息**：作者、时间等。

### 新增图元

1. `types.ts`：加入 `Entity` 联合成员；
2. `entities.ts`：`entityPointIds` / `entityDimTarget` 的 switch（`assertNever` 会逼你补分支）；
3. `model.ts`：`addXxx()`，级联删除复用 `entityPointIds`，一般不需要改；
4. `geometry.ts`：`entitySamples` / `entityBounds` 的 switch（拾取/吸附/包围盒/框选）；
5. `renderer.ts`：`drawEntity` 的 switch；
6. `export-svg.ts`：`buildSVG` 的 switch（不导出就显式跳过）；
7. `tools.ts` / `sketch-actions.ts`：工具入口与创建/点击状态机；
8. `tests/`：补创建、拾取、包围盒、导出用例。

### 新增约束种类

1. `types.ts`：`ConstraintKind` 联合 + `Constraint` 的引用字段；
2. `config/constraints-meta.ts`：`CONSTRAINT_META` 加记录（label/ui/refs，refs 决定去重键与 model 的
   `ENTITY_REF_KEYS`/`POINT_REF_KEYS` 推导）；有按钮入口再往 `CONSTRAINT_ACTIONS` 加 `resolve`；
3. `constraints.ts`：`RESID` 是 `Record<ConstraintKind, …>`，漏写会编译失败；
4. `solver.ts` 无需改（自由度与残差表解耦）；`sketch-actions.ts` 的 `applyConstraint` 查表即用；
5. `tests/constraints-meta.test.ts` / `solver.test.ts` 补合法/非法/收敛用例。

### 新增尺寸种类

1. `dimensions.ts`：`DimKind` 联合 + `DIM_META` 一条记录（label/value/setValue/layout/matchesEntity/
   `matchesPoints?`）；`DimKind` 的 `Record` 会强制穷尽；
2. 在 `sketch-actions.ts` 里接上创建入口（如 `dimForEntity`/`dimForPoints`）与命中查找；
3. `tests/dimensions.test.ts` 补布局/命中/编辑用例。

### 约束现状与构造线

- **8 个约束按钮**：水平、竖直、平行、垂直、等长、相切、同心、等半径（「相切」按选中类型映射到
  `tangentLineCircle` 或 `tangentCircleCircle`）。另有 `distancePointPoint`（距离）与 `radius`（半径）两种
  尺寸类约束，入口在尺寸工具，不在约束按钮区。
- **暂无 UI 入口但有残差/求解支持的 7 种**：`coincident`（重合）、`pointOnLine`（点在线上）、
  `pointOnCircle`（点在圆上）、`distancePointLine`（点到线距离）、`angle`（角度）、`midpoint`（中点）、
  `symmetric`（对称）。它们可经 `model.addCon()` 在代码/测试里使用，接 UI 时在 `CONSTRAINT_ACTIONS` 加动作即可。
- 构造线是图元属性而不是约束：由工具栏「构造」切换，只影响虚线与导出样式，不参与求解。

### 测试约定

- node 环境、无 DOM；测试显式 `import { describe, it, expect } from 'vitest'`（不开 globals）；
- 直接测纯逻辑模块（model/geometry/dimensions/solver/export-svg/selection/sketch-actions/parse-dim-input 等），
  用 `model.clearModel()` 隔离单例 fixture；
- 需要视图数据时传假 `CameraView` / 假 `MeasureText`，不 mock 全局 camera 的渲染；
- 当前 12 个文件 / 220 个测试，`npm run test` 全部通过。

## 许可

GNU AGPL-3.0，见 `LICENSE`。
