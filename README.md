# SVG 草图板

一个约束求解驱动的 SVG 草图 demo：画点/直线/矩形/圆/圆弧，加几何约束与尺寸标注，导出 SVG。

- 8 个绘图/编辑工具：选择、点、直线、圆、圆弧、矩形、尺寸、删除
- 圆弧的两端是真实点：和线段端点一样可拾取/拖拽/固定/约束、可被点图元提升，也能直接复用已有点
  （共享同一个点即完成连接）；半径与起终角由「圆心 + 起点 + 终点」三个点推出
- 10 个约束按钮：重合、水平、竖直、平行、垂直、等长、共线、相切、同心、等半径
- 统一命令模型：每个操作 = 若干**参数槽位** + 一个执行函数。先选对象再点操作，缺的参数在画布上
  点选补齐，**填满立即执行**（左侧状态栏显示当前命令与每个参数的进度）
- 尺寸标注（CAD 风格）：两点距离、直线长度、圆/弧半径（圆心引线 + 弧上箭头）、两直线夹角（角度弧 + 箭头）；
  目标选好后标注实时跟随指针预览、按下即创建；标注可拖动改摆放、再点打开改值；输入框全精度回填、显示两位小数
- 已选择列表：与状态文案合并到左侧通高状态栏（上半区列表、下半区「当前操作 / 操作提示」两行 + 尺寸输入），
  按选中顺序列出图元与点，并在每个对象的行内显示它已有的约束（尺寸类带显示值，无约束时不多占一行），
  每颗约束胶囊末尾的「×」可逐条删除该约束；行末「移除」把对象移出选择集；状态栏宽度可拖拽并在刷新后保持；
  按住任一已选图元/点即可整体拖动全部已选
- 视图与文件：吸附开关、固定、构造、适应视图、导出 SVG、清空
- 图元是多态类（`EntityBase` 子类），几何归一到线段/圆弧/点三种基元；拾取、吸附、包围盒、
  渲染与导出只认基元，新增复用已有基元的图元时这些层不需要改

求解器用 LM（Levenberg–Marquardt）+ 数值雅可比，原地求解模型参数；纯逻辑层（model / geometry /
constraints / solver / dimensions / entities 等）不依赖 DOM，可直接在 node 里单测。

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

| UI 区块                     | miko_ui 组件                                                                                                                                                                                                                                                                                                                             | 应用侧只保留                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 顶部 dock（工具栏）         | `.dock.app-dock` 宿主（`create_element` 建，外观复用库的 `.dock`）+ `createSegmented`（8 个工具，单选）+ `createButton`（10 个约束 + 固定/构造 + 3 个即时命令）+ `createSwitch` / `createInlineToggle`（吸附开关）+ `createControlGroup`（工具 / 约束 / 视图与文件三组）；两个分区是 `.dock-group` / `.dock-actions`，不建面板、无标题栏 | `.app-dock*` 定位、窄视口换行与分节线                                                                          |
| 左侧状态栏（已选择 + 状态） | `createPanel`（通高面板，标题「草图状态」）+ `createObjectRow` / `createRowActions` / `createBadge` / `createButton`（已选择行；约束胶囊用 `createBadge` 做壳，内嵌一颗 `createButton` 的「×」）+ `createValueDisplay<string>` ×2（「当前操作」与「操作提示」各一行 `<output>`，各自由 signal 驱动）                                     | `.app-status*` / `.app-selection*` 布局与紧凑行样式                                                            |
| 尺寸输入框                  | `createNumberField` + `createNumberRow`（文字 + `<input type="number">`）                                                                                                                                                                                                                                                                | `.app-dim-field`（宽度 / 非法红框）                                                                            |
| 左侧栏宽度拖拽条            | `bindWindowResize`（与桌面窗口边缘缩放手柄同一条手势接线，方向 `'e'`：报告指针绝对位置）                                                                                                                                                                                                                                                 | `.app-sidebar-resizer` 定位与拖动中高亮；起手锚 + 总位移夹取、键盘与 localStorage 记忆在 ui/sidebar-resizer.ts |
| 错误提示                    | `createMessageArea` + `MessageList`（`aria-live` 容器、条目外观、自动消失）                                                                                                                                                                                                                                                              | `.app-notices` / `.app-notice-list` 定位                                                                       |
| info 提示                   | 复用左侧状态栏的 `ValueDisplay`（`flashInfo` 闪示，不占额外位置）                                                                                                                                                                                                                                                                        | 无                                                                                                             |
| 清空确认框                  | `createPanel`（`role="dialog"`）+ `createButton`（取消 / 确定主按钮变体）                                                                                                                                                                                                                                                                | `.app-confirm-*` 遮罩与按钮变体                                                                                |
| 页面外壳                    | `create_element`（canvas + 左侧状态栏 / dock / 通知区三个宿主 + 分隔条）+ CSS 网格                                                                                                                                                                                                                                                       | `#app` 网格、`--status-sidebar-width`、`.app-sidebar-resizer`                                                  |

样式加载顺序固定为 `miko_ui/styles.css`（token + 字体 + 控件 + 反馈）→ `src/styles.css`（只写页面布局、
`.app-*` 消费者类与 canvas 绘制 token）。页面布局是 `#app` 上的 CSS 网格：左列是通高的左侧状态栏、
中间是可聚焦的 `.app-sidebar-resizer` 拖拽条、右列上行是 dock、下行是画布；dock 的底色、下沿分隔线与
横向排布继续来自库的 `.dock`，应用样式只把它的定位与高度交还给网格。画布不是控件，仍由 `Renderer`
用 canvas 2D 绘制；它的颜色/线宽/虚线只写在应用样式表的 `:root`，`theme.ts` 读取同一批变量
（缺失时回退同值并告警）。
点图元在画布上画成外环 + 实心中心，外环半径单独用 `--point-graphic-ring-radius` token，
与线段端点、圆弧端点/圆心的小圆点（`--point-radius`）区分。

## 操作说明

### 工具与快捷键

| 工具 | 快捷键 | 操作                                                                                                                                                                      |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 选择 | `V`    | 点图元/点选中；`Shift` 点击加减选；按住任一已选对象整体拖动；空白拖拽框选（不启动命令）                                                                                   |
| 点   | `P`    | 点一个位置立即放独立点；吸附到已有点（含直线/圆弧端点、圆心）时复用该点并把它提升为点图元                                                                                 |
| 直线 | `L`    | 点起点、终点立即画线；连续画自动以上一段终点作为下一段起点，`Esc`/右键结束                                                                                                |
| 圆   | `C`    | 点圆心、半径位置立即创建                                                                                                                                                  |
| 圆弧 | `A`    | 圆心 → 起点 → 终点立即创建，三个点都进入模型并可直接复用已有点；半径由圆心→起点决定，终点只决定终止角；终点吸到不共圆的已有点时会报错；起终点同角（含浮点误差）按整圆处理 |
| 矩形 | `R`    | 点两个对角点立即创建；四角优先复用已有点，并自动加水平/竖直约束                                                                                                           |
| 尺寸 | `D`    | Smart Dimension：点目标 → 点放置；两点距离 / 线长 / 半径（引线 + 箭头）/ 两线夹角（角度弧 + 箭头）/ 改已有尺寸；标注可直接拖动                                            |
| 删除 | `E`    | 点对象立即删除，可继续点，`Esc`/右键结束；删点会级联删除引用它的图元，删点图元会删除其点与引用该点的约束                                                                  |

单键（`V/P/L/C/A/R/D/E`）切换工具/启动对应操作，`S` 开关吸附，带 `Ctrl`/`Meta`/`Alt` 时忽略。

### 统一命令：参数槽位 + 填满即执行

所有需要参数的操作（绘图、约束、尺寸、删除、固定、构造）都走同一条命令管线
（`src/operations.ts`），不再有按工具分叉的 `pending` 状态机：

- **操作定义** = 槽位列表 + 一个 `execute` 函数。槽位声明自己接受什么（点 / 位置 / 直线 / 圆或弧 /
  任意图元 / 已有尺寸），适用性判断因此只有一份来源；圆弧的起点/终点是「点」槽位（不是纯位置），
  空白点击建点、吸附到已有点则复用同一个点；槽位可标记 `optional`（尺寸的「第二条直线」：留空就标长度），
  也可以只接受「位置」用于放置（尺寸的摆放点击、圆的半径位置、矩形对角点）；
- 点击工具或约束按钮时，先把**当前选择集**按槽位类型装进去。例：先选一个点再点「重合」，锚点槽位
  立即填好，只差目标槽位；先选直线再点「重合」，则目标槽位先填好、锚点槽位等画布点击补；
- 槽位没填满时进入**收集态**：画布点击只消费「能填进空槽位」的候选，悬停也只高亮这些对象；
  点不到/不适用会给原因，不会先写模型再报错；
- 左侧状态栏分两行显示：第一行是当前操作（命令与参数进度），第二行是操作提示（键位说明、已选数量、
  吸附状态）——两者不写在同一行：
  `命令 重合 ▸ 点：点 #5 ▸ 目标：待选（点另一个点、直线或圆/弧）` /
  `点击画布补参数 · Backspace 回退 · Esc 取消`；
- 槽位填满后**立即执行**（不需要按 `Enter`）；**`Backspace`** 回退最后一个参数（这次点击新建、
  还没并入图元的点会一起删掉）；**`Esc`** 放弃整个命令。点击触发的执行失败会退回最后一击，
  直接再点一次即可重试；`Enter` 只作为兜底（参数已齐时重试执行）；
- 选择顺序不敏感：同类型槽位按选择顺序填，不同类型槽位按类型匹配；多余/不适用的选中对象会被忽略
  并在状态栏提示；
- 执行成功后，工具类操作自动续接同一操作（直线以终点为下一段起点，圆/圆弧/矩形/点/尺寸可连续
  操作）；repeat 操作（删除/固定/构造/水平/竖直）每点一个对象立即生效、命令保持可继续点，
  `Esc`/右键结束；其余约束/编辑操作回到选择工具。

### 鼠标与视图

- 左键：绘制、拖拽点（拖拽图元时拖它的端点/圆心，圆弧是圆心 + 起终两个端点；点图元即它引用的点；
  按住任一已选图元/点则整体拖动全部已选）、框选；选择工具下按住**尺寸标注**（尺寸线/文字/角度弧/引线）
  可拖动它的摆放，单击标注打开改值输入框。
- 中键或右键拖拽：平移视图。
- 右键单击（没拖动）：取消当前操作（等价于 `Esc`）。
- 滚轮：以指针为锚缩放；缩放范围 0.02–80（`config/limits.ts`）。
- `Enter`：兜底执行当前命令（参数填满后已自动执行，正常不需要按）。
- `Backspace`：有命令时回退最后一个参数；没有命令时删除选中对象。
- `Delete`：有命令时先取消命令；没有命令时删除选中对象。删除图元时级联删除「仅被它使用」的
  端点/圆心及相关约束，共享端点与引用共享端点的尺寸保留（圆弧的圆心/起点/终点同样适用）；删除点会
  递归删除引用它的图元；删除点图元会删除它引用的点与引用该点的约束（该点同时被其它图元使用时保留点本身）。
- `Esc` 的优先级阶梯（从高到低）：**尺寸输入框 → 进行中的框选 → 当前命令 → 清空选择**。
  取消命令会同时回到选择工具并删掉还没并入图元的临时点。
- 左侧状态栏宽度：拖动侧栏与 dock 之间的分隔条调整；分隔条聚焦后 `←` / `→` 每次 16px
  （`Shift` 64px，`Home` / `End` 到上下限），宽度限制在 240–560px 且给画布至少留 420px；
  拖到的宽度记在 localStorage，刷新后保持。

画布世界坐标 y 向下（与 SVG 一致）；网格间距从 10 起按 2 的幂缩放，使屏幕间距保持在 20–60px。

### 选择与框选

- 点与图元：点击位置既有已有点又落在图元上时选点；点图元的点按图元（`ent`）拾取，线段端点、
  圆/弧圆心、圆弧起点/终点仍按点（`pt`）拾取，同一个点不会以两种身份出现在选择集里。
- `Shift` 点击在已有选择里切换该对象；空白处按下会清空选择（`Shift` 时保留）。
- 框选方向决定语义（由下往上拖 = 交叉，由上往下拖 = 窗口）：
  - **由下往上**：交叉选择，图元与框有任何重叠就选中；
  - **由上往下**：窗口选择，图元必须完全落在框内。
  - 点只按「是否在框内」判定；点图元虽然按图元入选项，判定同样只看它引用的点是否在框内；
    框选结果固定按「先图元后点」写入列表；`Shift` + 框选为累加。
- 单击未选中的对象只选中它；单击已选中的对象会保留整个选择集，并把它作为整体拖动的抓手（不会塌缩成单项）。
- 已选中图元的端点/圆心（圆弧含圆心与两个端点）也按选中态处理：点它们同样能整体拖动，
  渲染、点击判定与拖拽点集合同一口径；点图元按图元对待，拖动它就是拖它引用的那个点。
- 左侧状态栏上半区的「已选择」列表按选中顺序列出全部图元与点（带种类徽章），每行「移除」可逐项从选择集摘掉。
- 每个已选对象的行内还会列出它**已有的约束**（按模型添加顺序，尺寸类带显示值）：图元取其直接引用的约束
  （水平/平行/等长/同心…）以及端点/圆心上的约束（重合、距离等），点取引用该点的约束；同一条约束只列一次，
  没有约束时这一行不出现。约束只随「已选择」显示，不另设全局约束列表，新增/删除约束后行内即时刷新。
- 每颗约束胶囊末尾有「×」：点它删除这一条约束（只删关系，不动点/图元，删完重新求解），
  删除后选择集不变、行内胶囊即时消失。每条约束带模型 id，同文案（如两条「半径」）也各自删除互不影响。
- 选中图元时，它的端点/圆心（圆弧含两个端点）同时显示为选中态；固定点始终显示为红色。
- 拖拽点集按 id 去重：共享端点只平移一次，不会在同一帧叠加两倍位移。

### 吸附

工具栏「吸附」开关或 `S` 键开关。吸附候选按优先级：**已有点 > 中点 > 曲线上点 > 直线上任意点 > 网格**；
网格容差额外打折（`SNAP_GRID_FACTOR`），避免抢走几何吸附。吸附标记画成十字，落点取吸附位置。
点图元的点、直线端点、圆弧端点/圆心都参与最优先的「已有点」候选：其它工具吸附到它会复用同一个点
（圆弧/直线因此可以直接接上既有几何），点工具则把这个点提升为独立点。
关闭后落点就是鼠标的原始世界坐标。

### 约束按钮

重合、水平、竖直、平行、垂直、等长、共线、相切、同心、等半径。按钮只负责**启动一个操作**，参数由
选择集预填 + 画布点选补齐，填满立即执行。槽位表在 `src/operations.ts`：

| 按钮      | 槽位                         | 执行结果                                                   |
| --------- | ---------------------------- | ---------------------------------------------------------- |
| 重合      | 点 +（点 \| 直线 \| 圆/弧）  | 按目标多态：`coincident` / `pointOnLine` / `pointOnCircle` |
| 水平/竖直 | 直线（repeat，逐条立即生效） | 每条直线一条 `horizontal` / `vertical`                     |
| 平行      | 直线 + 直线                  | `parallel`                                                 |
| 垂直      | 直线 + 直线                  | `perpendicular`                                            |
| 等长      | 直线 + 直线                  | `equalLength`                                              |
| 共线      | 直线 + 直线                  | `collinear`（两条直线落在同一条无限长直线上）              |
| 相切      | 直线或圆/弧 +（直线或圆/弧） | `tangentLineCircle` 或 `tangentCircleCircle`               |
| 同心      | 圆/弧 + 圆/弧                | `concentric`                                               |
| 等半径    | 圆/弧 + 圆/弧                | `equalRadius`                                              |

- 点图元、线段端点、圆/弧圆心、圆弧起点/终点都按「点」参与；点图元的图元身份只在固定/构造这类槽位里使用。
- 「重合」的上下文排除在**填槽位阶段**完成：同一个点不能和自己重合；点已经是目标直线端点/圆弧端点
  （假约束）或目标圆/弧圆心（会把半径挤成 0）时，该对象点不进去并给出原因。
- 「相切」用动态槽位：第一条是直线时，第二条只接受圆/弧，「两条直线相切」从拾取阶段就不可能。
- 「共线」是两条直线落在同一条无限长直线上（不是三点共线）：残差同时要求方向叉积为 0（平行）与
  第二条线起点到第一条线的有符号距离为 0。它按引用去重，反序选择同一组直线也只加一条；
  但同一条直线不能填进两个槽位。
- 不适用/多选的对象不会被静默写模型：装不进槽位的对象被忽略并在状态栏提示；参数不齐时点击/执行
  会说明缺哪个槽位。
- 按「种类 + 引用字段」去重：同一组引用重复添加会跳过并提示「已跳过 N 个重复约束」；重合这类无序
  约束会先按引用排序，反序选择也落到同一个去重键上。
- 求解后若有约束无法满足或引用了已删除对象，会用消息区提示（不静默失败）。
- 选中对象后，「已选择」列表的对应行内会列出它已有的约束（口径见「选择与框选」）；这是约束的唯一回显入口，
  也是**删除约束的唯一入口**：点胶囊末尾的「×」即按约束 id 删除，没有单独的「删约束」工具或按钮。

### 尺寸标注

尺寸工具按 CAD 的 **Smart Dimension** 方式工作：先点目标几何，标注会随即以正式画法**跟随指针预览**，
再点一下决定它摆在哪并创建；标注创建后还能直接拖动改摆放，单击标注改数值。支持四种目标：

| 目标                                         | 流程                                            | 画法                                            |
| -------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| 两个点（含点图元、直线端点、圆弧端点、圆心） | 点第一个点 → 点第二个点（空白处会新建点）→ 放置 | 两道界线 + 尺寸线 + 两端箭头 + 距离文字         |
| 一条直线                                     | 点直线 → 点空白处放置                           | 长度尺寸（两点距离的特殊情况）                  |
| 两条直线                                     | 点第一条直线 → 点第二条直线 → 放置              | 以两线交点为顶点的角度弧 + 切向箭头 + 度数文字  |
| 圆 / 圆弧                                    | 点圆/弧 → 放置（决定引线方向）                  | 圆心十字 + 圆心到弧的引线 + 弧上箭头 + `R` 文字 |
| 已有尺寸                                     | 直接点标注文字/线（尺寸工具或选择工具单击）     | 打开改值输入框                                  |

- **落位预览**：目标选齐后，预览用的就是正式尺寸的布局原语（界线、尺寸线、箭头、文字），
  因此看到的就是「按下后会得到的那条尺寸」；预览不写模型，`Esc` 取消不会有残留。
- **放置点击决定摆放参数**（都存世界单位，缩放时跟图形走）：
  - 距离：放置点相对两点连线的法向投影 = 尺寸线的世界偏移（拖到另一侧值为负）；
  - 半径：圆心 → 放置点的方向 = 引线方向；圆弧上的引线会被夹到弧段范围内（贴住最近端点），
    圆的缺省方向是右上 45°、圆弧的缺省方向是弧中点；
  - 角度：取两直线分出的四个扇形中放置点所在的那个，目标角 = 该扇形当前夹角（弧半径 = 放置点到顶点的距离，
    并有一个屏幕像素下限）。两条直线平行/夹角过小时拒绝标注并给出原因。
- **拖动标注改摆放**（选择工具，按住标注的线/文字/弧都可以）：距离改法向偏移；半径绕圆心旋转引线；
  角度改弧半径，拖过直线进入另一个扇形时切换象限——此时目标角自动取补角（60° ↔ 120°），
  约束方程等价、几何不跳。拖动只改展示参数，不改目标值、不求解。
- **单击标注**打开数值输入框（选择工具下无需先按 `D`）。创建后左侧状态栏下半区出现输入框：
  `Enter` 提交、`Esc` 撤销这次新建、点输入框以外按提交处理；非法输入保持编辑态（红框 + 悬停/读屏原因）。
- 输入框是 miko_ui 的 `<input type="number">`：小数与指数（如 `1.5e3`）仍可输入；
  浏览器会消毒掉 `0x10` 这类非法 token，应用仍按空串/非法值处理并保持红框。
- 回填用全精度 `String(value)`（打开再确认不会静默改写数值），画布上的标注显示保留两位小数；
  输入必须是有限正数（拒绝空串、`0`、负数、`0x10`、`Infinity` 等）；**角度以度存/显示，必须小于 180°**。
- 再次点同一个图元/同一对点/同一对直线会进入已有尺寸的编辑，而不是重复堆积；点已有尺寸则直接改值。
- 角度约束存的是用户单位（度），残差在 `constraints.ts` 里换算成弧度：用
  `cos(带符号夹角) - cos(目标角)`，并用象限符号位选择四组夹角中的一组，避免 0°/180° 附近的角度回绕。

### 固定 / 构造 / 适应 / 导出 / 清空

- **固定**：启动操作时从选择集预填点/图元（点图元即它引用的点），也可先点按钮再在画布上点对象，
  点一个立即生效、可继续点，`Esc`/右键结束。部分锁定 → 全锁，全锁 → 解锁；固定点不参与求解。
- **构造**：同上，选中图元（含点图元）在「普通 ↔ 构造」间切换，点一个立即切换、可继续点，
  `Esc`/右键结束。构造线/构造点在画布与导出里都用虚线，
  但单位不同：canvas 虚线是屏幕像素（`styles.css` 的 `--dash-construction: 5 5`），SVG 导出是用户单位
  （`config/export.ts` 的 `EXPORT_DASH: '5 5'`）。构造点在画布上只画虚线外环、不填实心中心。
- **适应 / 导出SVG / 清空**是即时命令（没有参数槽位，点击即执行），不需要 `Enter`。
- **适应**：按草图包围盒（含留白，点图元也参与）缩放到视口 90%，空草图回到默认缩放与原点。
- **导出SVG**（工具栏按钮名）：导出图元（直线/圆/圆弧/点），约束与尺寸标注不导出；普通点导出为实心小圆
  （半径 = 线宽 × `EXPORT_POINT_RADIUS_FACTOR`），构造点导出为空心虚线圈；整圆弧导出为 `<circle>`，
  部分弧导出为 `<path>` 的 `A` 命令（起终点直接用圆弧的两个端点坐标）。线宽 =
  `max(0.2, 包围盒最长边 / 500)`，坐标保留 4 位小数；
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
  `no-unused-vars` 允许 `_` 前缀的占位参数，与 tsconfig 的 `noUnusedParameters` 口径一致
  （多态基类默认实现保留签名但不使用参数）；
- 依赖分层：纯逻辑层（`src/{model,geometry,constraints,solver,dimensions,entities,vec,camera}.ts` 与
  `src/config/**`）禁止 import `renderer/editor/toolbar/main/theme/ui`，需要视图数据时改为参数注入；
- `eslint-config-prettier` 收尾，避免格式规则与 Prettier 冲突。

## 目录结构

```text
index.html                   仅一个 #app 挂载点；画布与全部 UI 由 main.ts 用 miko_ui 装配
src/
  main.ts                    入口：mountAppShell 建网格外壳（左侧状态栏 / dock / 画布 / 通知区）、引样式、组装 Editor 与工具栏
  editor.ts                  控制器：指针/键盘事件接线 + 手势状态机（拖拽/平移/框选）+ Enter/Backspace/Esc 路由；
                             ResizeObserver 跟随布局重设画布
  renderer.ts                canvas 渲染：网格、图元（按几何基元绘制，含点图元）、点、尺寸（按 DIM_META
                             布局画线段/圆弧/箭头/文字，悬停高亮）、命令预览、框选、吸附标记
  theme.ts                   从应用样式 src/styles.css :root 读一次 Theme（带默认值兜底），注入 Renderer
  styles.css                 应用样式：页面网格与宿主定位 + dock 消费者类 + .app-* 消费者类 + canvas 绘制 token；
                             控件与 dock 外观来自 miko_ui
  types.ts                   非图元的数据类型：Point/Constraint/ToolId/SelectionItem/Selection/Marquee 等
                             （图元是多态类，在 entities.ts）
  state.ts                   交互状态单例（工具/光标/吸附/悬停点/悬停图元/悬停尺寸/命令会话/选择/框选）
                             + 有序选择集操作
  operations.ts              统一命令引擎：Operand/SlotSpec/OperationMeta、选择集预填、点击补槽位、
                             上下文排除、命令状态栏文案、预览形状，以及工具元数据 TOOLS
                             （顺序/快捷键/提示；全部操作的单一来源）
  model.ts                   点/图元/约束容器与增删查、级联清理、点图元归属/孤立点回收；
                             注入点表后的图元门面：arcGeometry / curveRadius / primitiveOf
  entities.ts                图元多态模型：EntityBase 子类各自实现 pointIds / 尺寸目标 / 几何基元 /
                             重合与相切约束映射 / 求解自由度 / 结构残差；EntityPrimitive 把几何归一到
                             线段 / 圆弧 / 点三种基元
  geometry.ts                拾取/吸附/包围盒/框选相交判定；只对几何基元写一次数学
                             （含点图元；不读全局相机，zoom 作参数）
  constraints.ts             约束引用校验 + 各类残差方程表 RESID（Record 强制穷尽）
  solver.ts                  LM 求解器：自由度组装（Point 坐标 + 图元 freeParams）、数值雅可比、
                             阻尼迭代、invalidConstraints；图元结构残差由 structuralResiduals 多态提供
  dimensions.ts              尺寸单一元数据表 DIM_META：取值/设值/文案/校验/布局/命中/拖拽/图元匹配；
                             布局输出屏幕绘制原语（线段/圆弧/箭头/文字），renderer、pickDim、尺寸拖拽共用
  export-svg.ts              纯 SVG 导出（buildSVG，按几何基元生成标签，含点图元）；下载适配器在 ui/download.ts
  camera.ts                  世界 ↔ 屏幕换算、缩放范围、网格间距（纯函数）
  viewport.ts                视图交互写入口：适应视图、滚轮缩放、平移
  vec.ts                     二维向量纯函数（含 safeLen / unitPerp 的零向量约定）
  toolbar.ts                 顶部 dock 工具栏：miko_ui 的分段按钮组 / 按钮 / 开关 / 控制组 + 操作按钮高亮
                             （两个分区 .dock-group / .dock-actions，不建面板；工具表来自 operations.TOOLS）
  selection.ts               选择语义：单击/Shift/框选方向与结果；拖拽点集、已选列表数据（含行内约束 id/文案）、
                             命令收集态的悬停候选（点图元按 ent；尺寸标注悬停优先于几何）
  sketch-actions.ts          原子领域操作与求解（画图/批量加约束/按 id 删约束/删除/固定/构造/尺寸/拖拽），不读交互状态
  ui/
    app-shell.ts             应用外壳：在 #app 网格里建侧栏宿主 / 分隔条 / dock 宿主 / 画布 / 通知区，并接上拖拽条
    sidebar-resizer.ts       侧栏宽度：miko_ui bindWindowResize（与窗口边缘缩放同一套）+ 总位移 clamp（240–560px、画布 ≥420px）、←/→/Home/End、localStorage 记忆
    editor-controls.ts       工具栏命令实现与唯一同步入口 sync()（render + 已选列表 + 左侧状态栏）
    status-panel.ts          左侧通高状态栏外壳：标题「草图状态」+ 已选择插槽 + 状态/尺寸输入插槽
    selection-list.ts        「已选择」列表区块（填充左侧栏上半区）：ObjectRow / Badge / Button，
                             行内第二层显示该对象已有的约束胶囊（胶囊内嵌「×」，按 id 删除约束）
    hint-editor.ts           状态区两行（当前操作 / 操作提示）+ 尺寸输入（填充左侧栏下半区）：ValueDisplay / NumberField / NumberRow
    parse-dim-input.ts       尺寸输入纯解析（node 可测，无 DOM）
    notify.ts                错误提示进 miko_ui MessageArea；info 走状态栏；确认框用 Panel + Button
    download.ts              Blob/<a download>/objectURL 下载适配器
    measure-text.ts          canvas measureText 适配器（无 canvas 时回退估算）
  config/
    index.ts                 汇总出口，业务统一从 './config' 引入
    angle.ts                 TAU / sweepOf / normalizeAngle / 弧段数
    constraints-meta.ts      16 种约束元数据、去重键、引用字段推导（操作槽位/执行在 operations.ts）
    export.ts                导出标定：颜色/线宽/精度/文件名/虚线/点半径/空图文案
    format.ts                formatNumber / formatDimValue（显示格式，与回填全精度分开）
    layout.ts                侧栏宽度记忆键、键盘步长、布局变量读不到时的兜底值（宽度与上下限的真相在 styles.css :root）
    limits.ts                缩放/网格/留白/退化阈值/初始 id 序列/尺寸默认偏移
    solver.ts                LM 迭代预算、收敛阈值、λ 超参、数值雅可比步长
    tolerances.ts            拾取/吸附/尺寸命中/拖拽阈值（屏幕像素）+ worldTol + SNAP_PRIORITY
    ui.ts                    无法用 CSS 表达的几何/交互常量（滚轮灵敏度、尺寸文字/引线留白、角度弧最小半径等）
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
  （以及 state / selection / sketch-actions / operations / export-svg / viewport）都不 import
  renderer/editor/toolbar/main/theme/ui，
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
- **配置分层**（按「外观 / 布局 / 手感 / 数值 / 导出 / 元数据」拆分，变更频率不同）：
  - 外观（颜色/线宽/点半径/点图元外环半径/虚线/箭头/字体）→ `src/styles.css :root`，`theme.ts` 读取；
    `theme.ts` 里的默认值必须与 CSS 保持一致（改 token 要同时改两处兜底值）。
  - 页面布局（侧栏宽度默认值与上下限、分隔条宽度、画布最小宽度）→ `src/styles.css :root`，拖拽时
    读同一批变量；键盘步长与宽度记忆键 → `config/layout.ts`（`LAYOUT_FALLBACK` 只在计算样式读不到时兜底）。
  - 交互手感（拾取/吸附/命中/拖拽阈值）→ `config/tolerances.ts`，屏幕像素声明、用时 `worldTol(px, zoom)` 换算。
  - 视图/模型上下限 → `config/limits.ts`。
  - 数值算法（角度、LM 超参、迭代预算、收敛阈值）→ `config/angle.ts`、`config/solver.ts`。
  - 导出标定（颜色/线宽/精度/文件名/虚线/点半径）→ `config/export.ts`，导出不读 canvas 主题。
  - 元数据表 → `config/constraints-meta.ts`（约束引用字段/去重键）与 `dimensions.ts` 的 `DIM_META`（尺寸）；
    操作的槽位/执行/预览 → `operations.ts`。
- **单一来源**：常量与文案只写一处，`config/index.ts` 统一出口；业务代码不深引 config 内部文件。

## 约定与扩展点

### 注释

每个文件的注释只描述本文件内发生的事（依赖其他文件时说明依赖关系），并且只允许三类内容：

1. **是什么**：这段代码/文件的职责；
2. **为什么**：原理、公式、推导、可能的坑、警告（例如为什么整圆弧要按 `TAU` 而不是 `0`）；
3. **元信息**：作者、时间等。

### 图元多态

- 图元不是「可辨识联合 + 各调用点 `switch (e.type)`」，而是 `EntityBase` 的子类：引用点
  （`pointIds`）、尺寸目标（`dimTarget`）、点在图元里的结构角色（`pointRole`）、重合/相切约束映射
  （`pointOnConstraint` / `tangentWith`）、求解自由度（`freeParams`）、结构残差
  （`structuralResiduals`）与半径（`radius`）都由子类重写，调用点只依赖基类接口；
- 几何差异再归一到 `EntityPrimitive`：`segment`（线段）/ `circular`（圆心 + 半径 + 起始角 + 扫角）/
  `dot`（点）。拾取距离、吸附候选、折线近似、包围盒、canvas 绘制与 SVG 导出只对这三种基元
  写一次数学，圆与圆弧共用同一段半径/角度逻辑（整圆 = `sweep` 为 `TAU` 的圆弧）；
- 调用点不检查 `e.type`（`constraints-meta` 的 `accepts` 校验仍按种类字面量）；
  `isCurveEntity` 用 `instanceof CurveEntityBase` 判断，新增曲线子类时自动覆盖；
- 图元方法需要模型里的点时接收 `PointLookup`（由 `model.getPoint` 注入），
  因此 `entities.ts` 不反向依赖 model 容器；`model.primitiveOf()` / `arcGeometry()` /
  `curveRadius()` 是注入点表后的薄门面。

### 圆弧的表示

- `ArcEntity` 只存三个点的 id：`c`（圆心）、`a`（起点）、`b`（终点）；半径 = |起点 - 圆心|，起终角是两点
  相对圆心的极角，都由 `ArcEntity.arcGeometry()` 派生，**没有** `r` / `a0` / `a1` 字段
  （`model.arcGeometry()` 是注入点表后的门面）。改半径或角度的约束因此作用在点上，
  而不是某个标量参数上。
- 「终点与起点共圆」是圆弧的**结构残差**（`ArcEntity.structuralResiduals`：
  `|终点-圆心| - |起点-圆心| = 0`），不是 `Constraint`：它不可删除、不出现在约束按钮里，
  只维持圆弧自洽。新增引用圆弧半径/角度的约束时，半径统一走 `model.curveRadius()`
  （多态实现：圆读 `r`，圆弧由点算）。
- 端点就是普通 `Point`：拾取/框选/拖拽/固定/删除级联和其它图元端点同权；点工具可以把端点提升为
  点图元；创建圆弧时复用吸附到的已有点，圆弧与直线就共享同一个点（不需要再加 `coincident`）。
- 求解器阻尼用标量 λ 而不是按 `JᵀJ` 对角缩放：圆弧端点存在「整体绕圆心旋转」的零空间方向，
  各向异性阻尼会把它推出伪位移（见 `solver.ts` 注释）。

### 新增图元

1. `entities.ts`：加一个 `EntityBase` 子类——实现抽象 `primitive()`，按能力重写 `pointIds` /
   `dimTarget` / `pointRole` / `pointOnConstraint` / `tangentWith` / `freeParams` /
   `structuralResiduals` / `radius`；把子类加进文件顶部的 `Entity` 联合（曲线再加进
   `CurveEntity`）。`EntityKind` 由联合自动推导，`isCurveEntity` 由 `instanceof` 自动覆盖；
2. 若新图元的几何能复用 `segment` / `circular` / `dot` 之一，**渲染、导出、拾取、吸附无需改动**；
   只有当它引入新的基元种类时，才扩展 `EntityPrimitive` 联合，并在 `geometry.ts` 的
   `primitiveDistance` / `primitiveSnapCandidates` / `primitiveSamples` / `primitiveBounds`、
   `renderer.ts` 与 `export-svg.ts` 的基元 switch 补分支——穷尽 switch 会直接报错提醒；
3. `model.ts`：`addXxx()` 里 `new` 子类；级联删除与孤立点回收自动走 `pointIds`；若图元独占
   已有对象，还要补类似 `addPointEntity` / `pointEntityOf` / `ownedPointIds` 的归属查询；
4. 点图元这类零尺寸图元：基元返回 `dot`；`pickPoint` 跳过 `ownedPointIds()`、`pickEntity` 先按点
   容差命中；渲染循环跳过被拥有的点，否则同一对象会有 `pt` / `ent` 两种选择身份；
5. `sketch-actions.ts`：`addXxx` 的原子创建入口与退化阈值；`operations.ts`：对应操作的槽位
   （`accepts`）与 `execute`（点图元是 `point` 槽位 + `placePointEntity`）；
6. `tests/`：补创建、基元、拾取、包围盒、导出、槽位匹配用例（多态契约见 `tests/entities.test.ts`）。

### 新增约束种类

1. `types.ts`：`ConstraintKind` 联合 + `Constraint` 的引用字段；
2. `config/constraints-meta.ts`：`CONSTRAINT_META` 加记录（label/refs，refs 决定去重键与 model 的
   `ENTITY_REF_KEYS`/`POINT_REF_KEYS` 推导）；
3. `constraints.ts`：`RESID` 是 `Record<ConstraintKind, …>`，漏写会编译失败；
4. `solver.ts` 无需改（自由度与残差表解耦）；有按钮入口时在 `operations.ts` 加一条约束操作：
   `slots(...)` 声明每个参数的接受类型（可带 `reject` 做上下文排除），`execute(values)` 用
   `addConstraints([{ kind, props }])` 写入——不再需要单独的 resolve/适用性判断；
   一个按钮按参数类型生成不同 kind 时（重合、相切都是），把映射写进图元的多态方法
   （`pointOnConstraint` / `tangentWith`），槽位负责把不合法的组合提前挡掉
   （相切用动态槽位，重合用 `pointRole` 拼出的 `reject`）；
5. `tests/operations.test.ts` / `coincident.test.ts` / `solver.test.ts` 补槽位、拒绝与收敛用例。

### 新增操作（工具 / 按钮 / 命令）

1. `operations.ts`：往 `OPERATIONS` 加一条 `OperationMeta`：
   - `id` 加进 `OperationId` 联合；`label` 是状态栏与按钮文案；
   - `group` 决定按钮区（`draw` 走工具分段、`constraint`/`edit` 走按钮行），`tool` 非空时绑定工具 id；
   - `slots(values)` 返回槽位表：`accepts` 声明接受的操作数，`place: 'point' | 'position'` 允许空白点击
     落参（新建/复用点或纯位置），`repeat` 允许可变参数，`reject` 做上下文排除；
   - `execute(values, ctx)` 返回普通动作（`actionOut(...)`）或尺寸输入会话（`dimOut(...)`）；
     成功后可给 `continueWith` 让同一操作自动接续（直线连续画就是这么做的）。
2. `options` 里的槽位表就是适用性单一来源：工具/按钮只是 `setTool` / `armOperation` 的入口，
   不要在 UI 层再写数量/类型判断；
3. 工具类操作还要在 `TOOL_ORDER` / `TOOL_HINTS` 里补快捷键与提示（label 自动取操作表）；
4. 有几何预览就在 `commandPreview` 的 switch 里补分支，返回 `PreviewShape`（线段/圆弧基元），
   渲染器与实体绘制共用同一份画法；
5. `tests/operations.test.ts` 补「选择集预填 / 点击补槽位 / 上下文排除 / 执行」用例。

### 新增尺寸种类

1. `dimensions.ts`：`DimKind` 联合 + `DimConstraint` 联合分支 + `DIM_META` 一条记录
   （label/value/setValue/text/validate?/layout/drag/matchesEntity/`matchesPoints?`/`matchesEntities?`）；
   `DimKind` 的 `Record` 会强制穷尽。布局返回 `DimLayout`（屏幕坐标的 `segments` / `arcs` / `arrows` / `text`），
   拖拽函数只改摆放参数（offset / leaderAngle / angleSector 之类），不碰目标值、不求值；
2. `types.ts` 的 `ConstraintKind` / `Constraint` 字段 + `config/constraints-meta.ts` 的 refs；
   `constraints.ts` 的 `RESID`（`Record<ConstraintKind, …>` 会强制穷尽）——角度类用 cos 残差并处理好象限/回绕；
3. 在 `sketch-actions.ts` 里接上创建入口（如 `dimForEntity`/`dimForPoints`/`dimForLines`）与已有尺寸查找；
   点图元没有独立尺寸目标（多态方法 `dimTarget()` 返回 null），它只作为两点距离的一端，入口在
   `operations.ts` 的尺寸操作 `execute` 的 `point` 分支里把点操作数交给 `dimForPoints`；
4. `operations.ts` 的尺寸槽位：新目标类型需要第二击时加可选槽位 / 放置槽位；拖拽是纯展示参数，
   不需要改 solver；
5. `tests/dimensions.test.ts` 补布局/命中/拖拽用例；`tests/solver.test.ts` 若引入新残差补收敛用例。

### 约束现状与构造线

- **10 个约束按钮**：重合、水平、竖直、平行、垂直、等长、共线、相切、同心、等半径，定义在
  `operations.ts` 的 `CONSTRAINT_OPERATIONS`。「相切」由图元多态方法 `tangentWith()` 映射到
  `tangentLineCircle` 或 `tangentCircleCircle`；「重合」按目标对象分派到 `coincident`（点）
  与图元方法 `pointOnConstraint()`（`pointOnLine` / `pointOnCircle`）。
  另有 `distancePointPoint`（距离）、`radius`（半径）与 `angleLineLine`（两直线夹角）三种尺寸类约束，
  入口在尺寸操作，不在约束按钮区；角度目标值以「度」存储，残差在 `constraints.ts` 里换算成弧度。
  角度的象限由标注的 `angleSector` 符号位决定，拖动角度标注可切换象限并自动取补角。
- 构造线是图元属性而不是约束：由工具栏「构造」切换，只影响虚线与导出样式，不参与求解；点图元同样有
  构造属性，构造点在画布上只画虚线外环、导出为空心的虚线小圆。

### 测试约定

- node 环境、无 DOM；测试显式 `import { describe, it, expect } from 'vitest'`（不开 globals）；
- 需要按「圆心 + 半径 + 起终角」造圆弧 fixture 时用 `tests/fixtures.ts` 的 `addArcByAngles`
  （内部会换成三个点；整圆复用起点，与生产创建一致）；
- 直接测纯逻辑模块（model/geometry/dimensions/solver/export-svg/selection/sketch-actions/operations/
  entities/parse-dim-input 等），用 `model.clearModel()` 隔离单例 fixture；命令引擎的用例直接构造
  `ClickInput`（假 CameraView / MeasureText / Snap）驱动 `clickCommand`，不需要真实画布；
- 需要视图数据时传假 `CameraView` / 假 `MeasureText`，不 mock 全局 camera 的渲染；
- 测试文件与用例数不在这里写死：见 `npm run test`，当前全部通过。

## 许可

GNU AGPL-3.0，见 `LICENSE`。
