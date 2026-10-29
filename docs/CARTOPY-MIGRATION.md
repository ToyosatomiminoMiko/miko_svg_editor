# Cartopy_file → 出版排版编辑器：迁移调查与结论

> 状态：**调查结论 + 迁移计划 + 执行记录**（2026-10-27 调查；2026-10-28 起实施）。Cartopy 侧已对齐
> 「只出地理」并直接产出 `base.svg + <stem>.geo.json`（§12.1）；miko 已改为**纯静态前端**——删除
> `tools/` 与 Python 合成，改为浏览器上传 + 浏览器内合成，见 §13。契约以
> [`PAGE-EDITOR.md`](PAGE-EDITOR.md) 为准，`docs/merge/` 下的旧合并稿已被它取代，只作历史。
>
> 涉及两个仓库：本仓 `miko_svg_editor`（下称 miko）与
> `/mnt/IVSTINIANVS/__projects_python/Cartopy_file`（下称 Cartopy）。
>
> 阅读提示：§2 / §6 / §12 里提到的 `tools/mapdoc`、`studio.py`、Python 合成都是**当时**的实现，
> 已在 §13 删除；保留这些文字只为记录决策与迁移过程的证据。

> **2026-10-28 更新**：`scene.json` 已并入 `geo.json`——排版真值改为 `geo.json` 顶层的 `page` 块，
> 打开 `base.svg + geo.json`、导出同一份 `geo.json` 即可再次编辑。本文件中出现的 `scene.json` /
> `mapdoc-page` / `导出 JSON` 描述都是**历史记录**（只记录当时的方案与迁移过程），当前契约以
> [`PAGE-EDITOR.md`](PAGE-EDITOR.md) 为准。

## 0. 决策记录（本轮由用户确定）

| 编号   | 决策                                                   | 含义                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | **Cartopy 只做地理，只出「没有标注、没有文字」的地图** | 成品里的文字/图例/色标/标题/注/来源/刻度数字/比例尺文字/指北针文字都不再由 Cartopy 绘制；标注工具（浏览器标签编辑器）也从 Cartopy 删除                                                                                                                                                                                                                                        |
| **D2** | **Cartopy 产出「初始标注」JSON**（城市、河流等位置）   | 因为前端不知道标注该在哪；Cartopy 把地名候选（文本 + 位置 + 锚点 + 字号 + 语义 `role`）写进 `geo.json` 的 `labels`，样式归前端 `config/text-style.ts`，前端据此生成默认排版                                                                                                                                                                                                   |
| **D3** | **字体嵌入在前端完成**                                 | 浏览器按 scene 实际用到的字符裁字体子集（WOFF2）。原计划「随保存交给 studio，由 Python compose 拼 `@font-face`」已随后端删除而作废（§13）：字体嵌入必须在浏览器内完成（用户上传字体文件 → 前端子集化 → 合成时写进 `<defs>`）；本轮未实现，`final.svg` 仍只写 `font-family`。项目级规定（仓库根部 `constitution.md`）：成品 SVG 必须 `<text>` + 字体嵌入，文字可复制且字体不变 |

本文所有"建议/计划"都以 D1–D3 为前提。

## 1. 结论摘要

1. **目标方向是自洽的**：契约早就规定「Cartopy 只出纯地图 + `geo.json`，base 里不许有 `<text>`」
   （[PAGE-EDITOR.md §1/§7](PAGE-EDITOR.md#L10-L38)），Cartopy 现有产物违反这条，才由 miko 的
   `extract.py` 一次性适配器临时剥离。
2. **但现在不能直接删 Cartopy 的标注**：miko 目前**只接入了 1 张图（Volga）**——`prepare_demo.py`
   硬编码、`studio.toml` 只配一张；其余 6 张用现适配器实测有 4 张会丢东西（§7）。
3. **最关键的断链**：`geo.json` 的经纬刻度、地名候选、图例、色标刻度、标题/注/来源，**全靠从 Cartopy
   成品的 `<text>` 反推**（`extract.py` 的 `_graticule`/`_label_entry`/`_legend`/`_colorbar`/`_suggestions`）。
   Cartopy 一旦"无文字"，这些数据必须改由 Cartopy 直接输出到 `geo.json`（D2），否则前端默认排版全空。
4. **要搬的是「miko 没有、Cartopy 有」的标注能力**：前端字体子集嵌入（D3）、比例尺、指北针、引线标注、
   多行/自定义图例、旋转手柄等编辑交互，以及现有 `labels.json` 手工位移的迁移（§6）。
5. **Cartopy 侧"删标注"本身是可控的**：删 1 个包模块（`labels.py`）+ 1 个浏览器编辑器 + 1 个布局文件 +
   3~4 个文档页 + 1 条 `fonttools` 依赖；真正的大头是「7 张图改造成 base + geo 输出」。
6. 前置修复：现适配器有 4 个实测缺陷（northern_shan 图例残留、图内区域名误判、图例多行丢行、USSR 标题丢），
   建议在动 Cartopy 之前先补或直接由 Cartopy 原生输出取代。

## 2. 现状核对

|          | Cartopy                                                                                                                                                                        | miko                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 定位     | cartopy 出图：7 张 SVG（缅甸 3、苏联 1、乌克兰 1、伏尔加 2），约 62 MB；成品含文字/图例/色标/图框 + 标签编辑器                                                                 | SVG 草图编辑器 + `map.html` 出版排版编辑器；`tools/mapdoc`（纯 stdlib）做 base/geo/scene/render/compose                  |
| 标注现状 | `labels.py`（732 行）+ `tools/label_editor.py`（511 行）+ `editor.js`（2097 行）+ `labels.json`；5 个脚本里共 **235 个 `label-*` 组、473 条 `<text>`**，每张 3 个 `@font-face` | 文字 item（多行/旋转/锚点/行高/halo/斜体/加粗）、图例、色标、图框刻度、点选/拖拽/方向键/保存合成；157 个 Python 单测全绿 |
| 契约     | 无（产物=成品 SVG）                                                                                                                                                            | `base.svg` + `geo.json` + `scene.json` + `final.svg`，四层职责写死                                                       |
| 覆盖     | 7 张图                                                                                                                                                                         | **1 张图**（Volga 流域图）                                                                                               |

### 2.1 打开前端时看到的「标注」来自哪里（问：在 SVG 里还是 JSON 里？）

**在 `geo.json` 里，不在 SVG 里。** 具体链路与实测：

1. `prepare_demo.py` 从 Cartopy 旧成品里**剥离**出纯底图，并把原图的文字抽成 `geo.json` 的 `labels`
   （实现见 `tools/mapdoc/extract.py`：`_label_entry` 抽地名、`_graticule` 抽刻度、`_legend`/`_colorbar`
   抽图例色标、`_suggestions` 抽标题/注/来源）。
2. 实测 Volga demo：
   - 底图 `demo/figures/Volga/.build/…base.svg`（9,874,736 B）里 **`<text>` 出现 0 次**（契约 C2 也强制如此）；
   - `geo.json`（23,396 B）的 `labels` 共 **39 条**：city 23 / river 6 / highland 4 / country 3 / sea 3，
     每条带 `x/y`（底图坐标，y 是文字块垂直中心）、`role`、`text`、`anchor`、`font_size_pt`、`order`
     （v1 提取产物还带 `rotation_deg`/`color`/`italic`/`halo`；v2 已删，样式归前端 `config/text-style.ts`）；
   - `scene.json`（15,129 B）共 45 个 item：text 43（**39 个 map 空间地名** + title/subtitle/note/source 4 个
     page 空间文字）+ legend 1 + colorbar 1。
3. 结论：前端的默认地名是 `defaultScene(geo)` 用 `geo.labels` 生成的 scene text item；用户改动只写
   `scene.json`，**不会回写底图**。因此：
   - 现在能看到标注，是 `geo.json` 的功劳；
   - Cartopy 删掉文字后，只要它继续（改为**直接**）输出 `geo.labels`，前端行为不变；
   - 如果 Cartopy 删文字又不输出 `geo.json`，默认地名/刻度/图例/色标/标题会全部消失。

### 2.2 工作区与文档状态

- Cartopy `git status` 干净；miko 9 个未提交文件属端口重构（`studio.toml` 5173、`vite.config.ts` 读取
  同一真值、`studio.py` 去掉默认端口），未触及本文主题。
- `docs/merge/DESIGN.md` 文件头已标注**被 `PAGE-EDITOR.md` 取代**，不要当契约使用。
- `docs/*` 默认被 `.gitignore` 忽略，只有 `ARCHITECTURE.md` / `PAGE-EDITOR.md` 例外；本文同样加例外后入库。

## 3. Cartopy 的「地理 / 标注」切分

### 3.1 纯地理（保留）

`data.py`（数据/缓存定位）、`relief.py`（ETOPO 读取、配色、晕渲、海陆底色、裁剪）、`overlap.py`
（边界重合剪枝，纯 shapely）、`download_data.py` 与 6 个数据准备脚本的几何部分、各脚本的投影/框/边界/
河流/湖泊/行政区/城市点绘制、`output.py` 中与文字无关的部分（`svg.image_inline`、固定 `hashsalt`、
`Date=None`、后缀强制）。

### 3.2 标注/文字（从 Cartopy 删除）

| 对象                                                                                                   | 说明                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cartopy_file/labels.py`                                                                           | `label_id`、`labels.json` v2 读写、位移/旋转增量、`added` 新标注、baked marker、Figure/SVG 两条施加路径                                                              |
| `tools/label_editor.py` + `tools/label_editor/{index.html,editor.css,editor.js}` + `label_editor.toml` | 127.0.0.1 服务、`/api/state`、`/api/save`、拖拽/旋转手柄/键盘旋转/新增标注/样式抄写                                                                                  |
| `src/cartopy_file/svgtext.py`、`fonts.py`                                                              | 文字外置 `<text>`、fontTools 子集 WOFF 内嵌、halo→CSS stroke；三字体逐字符回退                                                                                       |
| `output.py` 的 labels/svgtext/marker 分支                                                              | `save_svg` 的 `placements`、`_apply_label_*`、`_write_layout_marker`                                                                                                 |
| 5 个脚本的文字/版式绘制                                                                                | 地名（含双语）、标题/副标题/注/来源、图例、色标、经纬度刻度文字、比例尺文字、指北针 "N"、引线                                                                        |
| `Volga/…lambert_conformal.labels.json`                                                                 | git 里唯一一份，v1、2 条 moved；且**没有烤进 SVG**（产物里 `cartopy-file-labels:` 标记数 = 0）                                                                       |
| 文档                                                                                                   | `docs/label-editing.md`、`docs/reference/labels.md`（随 fonts 一起删 `reference/fonts.md`）；README 44-79；index/overview/add-map 的相应条目；6 个图种页的"调标签"节 |
| 依赖                                                                                                   | `pyproject.toml` 的 `fonttools`（只有 `svgtext.py` 用）                                                                                                              |

### 3.3 两可项（随 D1 全部归入"搬去 miko"或"删除"）

- 经纬网刻度数字：网线留（地理），刻度数字删（miko 画，数据来自 `geo.graticule`）。
- 比例尺/指北针：图形+文字整组搬去 miko（见 §6），Cartopy 只保留几何/比例元数据。
- 城市点/星形符号：属契约允许的"地理坐标点"，留 base；图例色块随图例一起删。
- `svg.fonttype="path"`：随 `fonts.py` 一起删或保留作兜底，对 base 无影响。

## 4. 删除影响面（Cartopy 侧）

- 删：`labels.py`、`svgtext.py`、`fonts.py`、`tools/label_editor*`、`labels.json`、4 个文档页、`fonttools`、
  `__init__.py` 里 fonts 重导出、5 个脚本的 `label_id`/文字/图例/色标/标题/刻度/比例尺/指北针代码。
- 改：`output.py` 收敛成"纯几何出图 + 元数据输出"；`check_docs.py` 规则不动，但必须同步 3 处源码指针
  （`northern_shan.py:69`、`volga.py:56`、`output.py:72/205`）与 6 处 fonts 指针；`add-map.md` 的
  "给标注加 gid / 跑编辑器"清单；README/overview/index 的模块表。
- 重出：7 张 SVG（约 62 MB 全变，git diff 巨大；历史无法瘦身）。
- 不变：数据准备、投影、晕渲、边界剪枝、确定性出图约定。

## 5. miko 现有能力与缺口

已具备（可直接承接）：文字 item 全字段（多行/旋转/锚点/行高/斜体/字重/字距/halo/字号/颜色）、map/page 两种
空间、图例（line/rect/point + dash/fill/opacity/marker + 外框/高度派生）、色标、图框 + 经纬刻度、纸张/
方向/两套默认版式、点选/拖拽/方向键/双击改字/缩放平移/保存合成/冲突检测/确定性字节/157 个单测。

缺口（详见 §6）：字体子集嵌入、比例尺、指北针、引线标注、多行/hatch/分组图例、区域注记落位、旋转手柄
等编辑交互、多图接入、scene.json 入库、`labels.json` 迁移。

## 6. 搬迁清单

### 6.1 P0：删标注前必须先有

| #    | 能力                                      | Cartopy 现有实现                                                                   | miko 现状                  | 落点 / 代价                                                                               |
| ---- | ----------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| P0-1 | 字体子集内嵌                              | `svgtext.py:121-227`（fontTools + WOFF + 固定时间戳保字节稳定）                    | 只写 `font-family` 字体栈  | **前端嵌入（D3，§6.2）**                                                                  |
| P0-2 | 比例尺（0/100/200 km）                    | `myanmar_admin.py:644-688`（按参考纬线换算投影长度）                               | 没有（明确非目标）         | 新增版面组件；`geo.json` 给 `km`/`pt_per_km`/参考位置                                     |
| P0-3 | 指北针（箭头 + N）                        | `myanmar_admin.py:692-712`                                                         | 没有                       | 新增版面组件；`geo.json` 给 `north.angle_deg`                                             |
| P0-4 | 引线标注（文字→地理锚点细线，终点小圆点） | `myanmar_admin.py:442-457`（双语标签带引线）、`ukraine.py:957-976`（境外狭长区域） | text item 无 `leader` 字段 | scene text 增 `leader`（底图坐标锚点）+ render/compose/侧栏；`geo.labels[].leader` 给候选 |
| P0-5 | 多行图例标签                              | Ukraine 图例有 `\n`（如"哈尔科夫人民共和国/（未实际控制）"）                       | legend entry 只有单行      | `geo.legend.entries[].label_lines` + render + 侧栏；**现 extract 实测丢第二行**           |
| P0-6 | 初始标注 JSON（D2）                       | 地名写在脚本里 + `gid`                                                             | 拿不到"标注在哪"           | **Cartopy 直接输出 `geo.json.labels`（§6.3）**                                            |

### 6.2 P0-1 详解：字体在前端按字符裁子集，再交给合成（D3）

**为什么必须裁**：浏览器读不到本机字体文件；项目 CJK 字体 `Noto Sans Mono CJK SC` 的 TTC 有 **31.9 MB**
（`/usr/share/fonts/google-noto-sans-mono-cjk-vf-fonts/NotoSansMonoCJK-VF.ttc`），整份内嵌不可接受；
JetBrains 已有 woff2（`miko_ui/styles/fonts/jetbrains_mono_slashed/`，3 个字重各 ~92 KB）。

**流程（建议契约）**：

1. **字体来源**：studio 新增只读端点（如 `GET /api/font-file?family=…`），从 `studio.toml` 的 `[fonts]`
   配置路径读取（默认系统 Noto TTC + `miko_ui` 的 JetBrains woff2）；浏览器一次取回并缓存。
   前言页面同时用 `@font-face` 加载同一份字体，保证**预览与成品同字形**。
2. **裁子集**：保存时前端收集 scene 里**所有会出现的字符**——text 的 `lines`、legend 的 title/labels、
   colorbar 的 title/unit/ticks、图框刻度文字（取 `geo.graticule.*.label`）——按字体族/字重裁成 WOFF2。
   前端需要一个浏览器端子集库（候选：`harfbuzzjs` 的 hb-subset wasm，或 fontkit 系的 `subset-font`），
   **这是新依赖**，原契约"不引入新依赖"要相应放宽（约 1–2 MB wasm/JS）。
3. **提交**：`PUT /api/fonts`（或保存请求里的独立字段）提交
   `{"format":"mapdoc-fonts","version":1,"faces":[{family,weight,style,woff2(base64),sha256}],"charset_sha256":…}`；
   建议落成与 `final.svg` 同目录的 `.fonts.json` sidecar；请求体上限 2 MB 需要放宽（子集通常几十~几百 KB）。
4. **合成**：`compose.py` 把 `@font-face` 原样拼进 `final.svg` 的 `<defs><style>`（与 base inner 一样按字节
   拼接，不重序列化字体），marker 增加 `"fonts":"<sha256>"`；`final = f(base, geo, scene, fonts)`，同输入同字节。
5. **失败降级**：前端裁字失败/未提交 → 不嵌入，成品回退 v1 行为（只写字体栈）并给警告。
6. **命名统一**：现在有三套写法——契约 `style.font_family` 用 `'Noto Sans Mono CJK SC', 'JetBrains Mono
Slashed Medium', 'DejaVu Sans'`；`miko_ui` 声明 `'JetBrains Mono Slashed'`；Cartopy 的 matplotlib 名是
   `'JetBrains Mono Slashed Medium'`。`@font-face` 的 family 必须与 SVG 里写出的字符串完全一致，迁移时
   统一成一套（建议以 miko_ui 的 `'JetBrains Mono Slashed'` 为准，Cartopy 的 geo 输出跟着改）。
7. **斜体**：SVG 用 `font-style:italic`，但 Noto CJK 没有斜体面，浏览器会合成倾斜；子集只需覆盖 regular/bold，
   文档里要写清"斜体是合成倾斜，不是真斜体"。
8. **确定性风险**：成品字节开始依赖前端子集库版本。marker 里记 fonts 摘要可复现，但"换浏览器/库版本重合成
   不保证同字节"——这是接受 D3 的代价；若不可接受，唯一替代是把最终组装也搬到前端（契约改动更大，不推荐）。

### 6.3 P0-6 详解：Cartopy 直接产 `geo.json`（D2）

`geo.json` 沿用契约 §3 的字段，由 Cartopy 在自己的出图流程里生成（不再由 miko 解析 SVG）：

- `base`：`sha256`、`view_box`（= 地图框）、`width_pt/height_pt`；
- `graticule`：`lon/lat` 每项 `{value,label,x,y,side}` + 线型 `style`（刻度值来自 FixedLocator，坐标由投影换算，
  label 沿用现有 `dms`/半球格式）；
- `labels`（**初始标注**，v2 契约）：每项
  `{id, role(枚举见 miko 的 config/text-style.ts), text, x, y, anchor, font_size_pt, order}`；
  位置由脚本现有数据表与计算给出（城市点、手工避让偏移、出图框过滤、同名序号、双语成对 `-en`），
  `y` 是文字块**垂直中心**；**文字样式（颜色/斜体/字重/字距/行高/描边）已归前端
  `config/text-style.ts` 的 role 表，生成端不再写 color/halo/italic/rotation，也不再做基线偏移与角度**；
- `relief`：`title/unit/vmin/vmax/stops/ticks`；
- `legend`：`title` + `entries[{label,shape,stroke,width_pt,dash,fill,opacity,marker}]`；
- `suggestions`：`title/subtitle/notes/source/area_annotation/legend_title/colorbar_title`。

**geo v2 已落地**：`labels` 只留 `id/role/text/x/y/anchor/font_size_pt/order`（样式归前端）；
**仍建议新增**（配合 P0-2/3/4/P0-5，下面示例里的 `leader`/`lang`/`scale`/`north` 属这一组）：

```jsonc
"labels": [
  {
    "id": "label-river-伏尔加河-1",
    "role": "river",
    "text": "伏尔加河",
    "x": 512.25, "y": 640.5, "anchor": "middle",
    "font_size_pt": 9.8,
    "leader": { "x": 501.0, "y": 655.2 },   // 可选：引线目标点（底图坐标；尚未实现）
    "lang": "zh",                            // 可选：双语配对（尚未实现）
    "order": 12
  }
],
"scale": { "kind": "line", "km": 200, "pt_per_km": 1.23, "anchor": { "x": 120, "y": 1180 } },
"north": { "angle_deg": 0.0 },
"legend": {
  "title": "图例",
  "entries": [
    { "label": "国界", "label_lines": ["国界"], "shape": "line", "stroke": "#4a4a4a",
      "width_pt": 1.4, "dash": null, "fill": null, "opacity": 1, "marker": null, "hatch": null },
    { "label": "MNDAA 实控区（大致）", "label_lines": ["MNDAA 实控区（大致）"], "shape": "rect",
      "fill": "#c9a227", "hatch": "////", "opacity": 0.4 }
  ]
},
"area_labels": [ /* 图内区域名，不再混入 suggestions.area_annotation */ ]
```

实现建议：**不要照搬 `extract.py` 的 SVG 解析**（1590 行，按 Volga 结构校准、依赖 matplotlib 内部 id）。
Cartopy 在画图时天然知道这些元数据：axes bbox、tick locator/label、文字 artist 的 gid 与位置、legend
handles、colorbar 的 norm/cmap。让脚本把这些数据收集成普通 dict，`output.save_base()` 同时写
`base.svg` + `geo.json`；底图不画文字，C2（无 `<text>`）自然成立。

### 6.4 P1：成品保真

| #    | 能力                                | 现状                                                                                                                                                                                                                             | 建议                                                             |
| ---- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| P1-1 | 自定义图例面板（分组色块 + 小标题） | `myanmar_admin.py:715-995` 自绘 axes：7 邦/7 省色块矩阵 + "冷色/暖色"小字；现 extract 把整块当"非地图 axes"删掉，图例全丢                                                                                                        | 要么扩展图例类型（分组/swatch 网格），要么该图接受简化（需拍板） |
| P1-2 | 图例 hatch 条目                     | `northern_shan.py:557-640`；extract 实测丢 hatch                                                                                                                                                                                 | geo+render 加 hatch 定义                                         |
| P1-3 | 图内区域注记 / 图外面积注记         | `volga` 的图外 `label-area-流域`；`northern_shan` 的图内 `label-area-*`。现 extract 按 id 前缀一律当"图外注记"，导致 northern_shan **7 条图内区域名进入未被消费的 `suggestions.area_annotation`**（geo.labels 32 vs 产品 39 组） | 按位置而不是 id 前缀区分；`defaultScene` 消费 area_annotation    |
| P1-4 | 图内文字随地图缩放联动              | 字号只在建默认 scene 时按 `s = map.width/base.width` 换算一次，改地图宽度后字号不跟                                                                                                                                              | 改成 map 空间字号随 s 实时换算，或契约写清"重排默认版式才重算"   |
| P1-5 | `labels.json` 迁移                  | Volga 仅 2 条 moved（别拉亚河 `dx -19.937/dy -9.421`、维亚特卡河 `dx -10.746/dy -2.515`，v1，未烤入）                                                                                                                            | 一次性迁成 scene 的 map 空间文字坐标，否则重出后位置回退         |

### 6.5 P2：编辑交互 parity（从 `label_editor` 搬）

- 拖拽旋转手柄绕文字锚点 + `Shift` 吸附 15°；`[`/`]` 与侧栏按钮按步长旋转（miko 现在只有侧栏数值输入）。
- 方向键步长档位：`Shift×10 / Alt×0.1`（miko 固定 1/10 pt）。
- 新增标注的**样式抄写**（从当前选中标签继承字号/颜色/斜体/halo/锚点）、单条重置/全部重置、突出标签
  （半透明地形上更醒目）。
- 双语标签成对语义（zh + `-en` 两条各自偏移）——可接受的简化是不配对，只当两条普通 text。

### 6.6 工程类

- **scene.json 入库**：`labels.json` 与产物一起提交；现在 `demo/` 被 gitignore，排版真值 `scene.json` 不入库。
  必须解决（移出 `demo/` 或给 `scene.json` 加忽略例外），否则搬过来的手工排版无法版本化。
- **多图接入**：`prepare_demo.py` 硬编码 Volga、`studio.toml` 只配一张；`studio.py` 的 `?figure=` 是死路径
  （多图时 `/api/doc` 直接 400），前端从不带 figure。7 张图要接就得补数据准备脚本 + 前端 figure 切换。
- **顺带修 2 个既有小缺陷**（与搬迁无关，但先修）：前端读 `report.out_of_canvas` 而 compose 返
  `out_of_paper`；图例条目上限前后端不一致（后端 50 / 前端常量 100）。

## 7. 反向断链实测：现适配器对 7 张图的覆盖

用 `extract`（纯函数，未写盘）对现有 7 张成品逐张跑：

| 图                         | 结果                                                                                                | 结论                          |
| -------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------- |
| Volga 流域图               | 39 地名 / 8 图例 / 2 area / 刻度 6+8 / relief / 文案齐                                              | **校准基准，唯一完全可用**    |
| Volga 共和国图             | 35 地名 / 10 图例 / 刻度 / 文案齐                                                                   | 可用                          |
| Myanmar 全境               | 11 地名 / 色标 / 刻度 / 标题来源                                                                    | 基本可用（该图无图例）        |
| **Myanmar 行政区（双语）** | 76 地名 ✓；**图例 0 条**（自绘面板被整块删）；base 留 20 个 `line2d_`（比例尺/引线/城市点混在一起） | **图例全丢 + 非文字标注残留** |
| **northern_shan**          | 32 地名，**7 条图内区域名被误判**；`id="legend"` **残留在 base**；hatch 图例 0 条                   | **区域名丢 + 图例图形残留**   |
| **Ukraine**                | 33 地名 ✓；图例 5 条但**多行只留第一行**；base 15 个 `line2d_`（引线残留）                          | 图例文字丢行 + 引线残留       |
| **USSR**                   | 无 label gid；`ax.set_title` 的标题**没被抽到**（suggestions.title 空）；刻度 0                     | 标题丢                        |

即：`extract` 是"按 Volga 一张图校准"的适配器，Cartopy 真删文字后这 7 张图不可能靠它兜住；应由 Cartopy
原生输出取代（§6.3），`prepare_demo.py` 退化为"复制 + 校验"。

## 8. 目标契约变更一览

| 契约         | 现状                         | 变更                                                                                                                                   |
| ------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `base.svg`   | 由 extract 从成品剥离        | Cartopy 直接产出；C1–C4 不变（无 `<text>`、viewBox=地图框、无 overlay 痕迹）                                                           |
| `geo.json`   | v1；由 extract 抽取          | Cartopy 直接产出；v2 增 `scale`/`north`/`labels[].leader`/`labels[].lang`/`legend.entries[].label_lines`/`hatch`/`group`/`area_labels` |
| `scene.json` | v1：text/legend/colorbar     | v2：text 增 `leader`；新增 `scale`/`north` 组件类型（或作为 text 的附属图形）                                                          |
| HTTP         | doc/geo/scene/compose/health | 增字体端点（取字体文件 + `PUT /api/fonts`）；请求体上限放宽                                                                            |
| marker       | counts/geo/scene             | 增 `fonts` 摘要                                                                                                                        |
| 字体         | 不内嵌（v1 已知限制）        | 前端按字符裁子集 → compose 拼入；失败降级为 v1 行为                                                                                    |
| 确定性       | `f(base, geo, scene)`        | `f(base, geo, scene, fonts)`；同输入同字节，换前端子集库版本可能不同（接受）                                                           |

## 9. 实施顺序（建议）

**阶段 0：拍板**——§10 的剩余决策（标注删除范围、自定义图例、7 张图范围、scene 入库方式）。

**阶段 1：基线快照**——用现有 7 张成品 + 现 `extract` 各跑一遍（纯函数、只读），把 base/geo 存成回归
fixture；同时修 4 个实测缺陷（§7），或直接跳过 extract 以 Cartopy 新输出为准。

**阶段 2：Cartopy 改造**（大头）——脚本停止创建文字/图例/色标/标题/刻度/比例尺/指北针，改为收集元数据；
`output.py` 输出 `base.svg + geo.json`；双轨运行，和旧成品逐图 diff 验证（地名数/位置/样式、图例条目、
刻度、relief、文案）。

**阶段 3：miko 补 P0/P1**——字体前端子集嵌入（§6.2）、比例尺、指北针、引线、图例多行/hatch、area 落位、
多图接入、scene 入库；接 7 张图逐张验收（默认排版、拖动、保存、合成、成品对比旧图）。

**阶段 4：Cartopy 清理**——删 `labels.py`/`label_editor*`/`svgtext.py`/`fonts.py`/`labels.json`/文档/
`fonttools`；重出 7 张产物；`check_docs.py` 全绿。

**阶段 5：质量门**——base 无 `<text>` 断言（契约 C2）、geo 字段完整、7 图可 prepare+compose、确定性字节、
`python3 -m unittest discover -s tools/tests -t tools` 与 `npm run check` 全绿。

## 10. 待拍板

1. **标注删除范围**：确认删到"base 零 `<text>`"（含刻度文字、图例、色标、标题、比例尺/指北针文字），
   而不只是删浏览器编辑器。
2. **自定义图例面板**（Myanmar 行政区）：扩展 miko 图例类型去还原，还是该图接受简化？
3. **区域注记**：`area_labels`（图内）与 `suggestions.area_annotation`（图外）按位置区分的规则确认。
4. **多图范围**：先 Volga 一张闭环，还是本轮直接铺 7 张（建议先 Volga + Myanmar 全境，小步验证）。
5. **scene.json 入库**：移到 `demo/` 之外，还是给 `demo/figures/**/*.scene.json` 加忽略例外？
6. **前端子集库选型**：`harfbuzzjs`（wasm）还是 fontkit 系；确认允许新增该 npm 依赖。
7. **确定性口径**：接受"fonts 载荷进 marker、换子集库版本可能不同字节"，还是要求 CI 里固定库版本？

## 11. 调查方法与证据

- 全程只读：读源码/文档/git；用 `extract` 纯函数对 7 个产物跑剥离（`PYTHONDONTWRITEBYTECODE=1`，未写盘）；
  miko 的 157 个 Python 单测由调查员跑过（只读）；**没有**跑 `prepare_demo.py`/`check_contract.py`/compose/npm
  （都会写 demo/dist）；`git status` 前后一致。
- 关键证据文件：`tools/mapdoc/extract.py`（剥离与 geo 抽取）、`tools/prepare_demo.py`（一次性适配器）、
  `tools/mapdoc/{geo,page,render,compose}.py`、`docs/PAGE-EDITOR.md`（契约）、
  Cartopy 的 `src/cartopy_file/{labels,svgtext,fonts,output}.py`、`tools/label_editor*`、
  `Myanmar/myanmar_admin.py`（比例尺/指北针/引线/双语/自绘图例）、`Ukraine/ukraine.py`（引线/多行图例）、
  `Myanmar/northern_shan.py`（hatch 图例）、`Volga/*.labels.json`。
- 复现（只读）：

```bash
# 1) base 是否无文字（应为 0）
grep -c '<text' demo/figures/Volga/.build/*.base.svg

# 2) 前端默认地名的来源：geo.labels → scene text item
python3 - <<'PY'
import json, glob
geo = json.load(open(glob.glob('demo/figures/Volga/*.geo.json')[0]))
scene = json.load(open(glob.glob('demo/figures/Volga/*.scene.json')[0]))
print(len(geo['labels']), sum(1 for i in scene['items'] if i['kind'] == 'text'))
PY

# 3) 对 7 张 Cartopy 成品跑 extract（纯函数，不写盘）
PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY'
import sys; sys.path.insert(0, 'tools')
from mapdoc import extract
base = '/mnt/IVSTINIANVS/__projects_python/Cartopy_file'
for rel in ['Volga/volga_basin_topography_etopo2022_lambert_conformal.svg',
            'Myanmar/myanmar_administrative_divisions_bilingual.svg',
            'Ukraine/ukraine_borders_1991_2014_2022_lambert_conformal.svg',
            'USSR/ussr_topography_etopo2022_lambert_azimuthal.svg']:
    b, g = extract.extract(open(f'{base}/{rel}', 'rb').read())
    print(rel, len(b), len(g['labels']), len(g['legend']['entries']))
PY
```

## 12. 执行记录（2026-10-27）

### 12.1 已完成：Cartopy 侧「移除标注/文字」

- 共享包：删 `labels.py`、`svgtext.py`、`fonts.py`；`output.py` 改为纯几何出图（去掉文字外置/字体子集/
  `placements`/baked marker，保留 `image_inline`、固定 `hashsalt`、`Date=None`、后缀强制）；`__init__.py`
  不再导出字体符号；`pyproject.toml` 去掉 `fonttools`。
- 工具：删 `tools/label_editor.py`、`tools/label_editor/`（index.html/editor.css/editor.js）、`label_editor.toml`。
- 布局：删 `Volga/…lambert_conformal.labels.json`。
- 文档：删 `docs/label-editing.md`、`docs/reference/labels.md`、`docs/reference/fonts.md`；同步改写
  `README.md`、`docs/index.md`、`docs/overview.md`、`docs/add-map.md`、`docs/reference/output.md`、
  6 个图种页。
- 脚本（6 个）：删全部文字/图例/色标/标题/注/来源/刻度文字/比例尺/指北针/引线及标注数据；保留投影、
  extent、晕渲、边界、河流湖泊、填色、城市点符号、网格线（`draw_labels=False`）、figure 与地图 axes
  位置、`save_svg`。涉及 `Myanmar/{myanmar,myanmar_admin,northern_shan}.py`、`USSR/ussr.py`、
  `Ukraine/ukraine.py`、`Volga/volga.py`。
- 一次性演示：`global.py`、`AmericaArmy/main.py` 去掉字体导入/调用。

验证（本轮实际跑过）：

- `python3 tools/check_docs.py` → `文档检查通过: 16 个 Markdown 文件, 89 条链接, 10 个模板页,
索引 14 页, 源码指针 65 处`；
- 仓库内全部 `.py` `py_compile` 通过；无 `label_id`/`apply_matplotlib_fonts`/`cartopy_file.labels|fonts|svgtext`/
  `label_editor`/`labels.json` 引用；无 `ax.text`/`fig.text`/`annotate`/`set_title`/`colorbar`/`legend(` 等调用；
- `git status`：改/删共 **34 个跟踪文件（+312/−7058）**；**7 张 `.svg` 一个都没动**（按决策暂不重出）；
- Cartopy 侧未提交 git，改动留给用户 review/提交。

### 12.2 寄存（已搬到 `demo/`，gitignored）

- 位置：`demo/pending-port/cartopy/`（44 个文件、588K）；`origin/` 是 Cartopy 改造前快照，
  `origin/GIT-HEAD.txt` = `72a7f31 2026-10-26 … 标签编辑旋转`，`SHA256SUMS` 已校验通过。
- 内容：改造前 `src/cartopy_file/*.py`、`tools/label_editor*`、5 个带标注的绘图脚本 + `map_lib.py`、
  全部 `docs/`、`README.md`、`pyproject.toml`、`Volga/*.labels.json`。
- 说明：`demo/` 被 `.gitignore` 忽略，快照不进版本库；移植对照（能力 → 参考文件 → 落点）写在
  `demo/pending-port/cartopy/README.md`。

### 12.3 本轮未做（后续工作）

1. Cartopy 仍未输出 `base.svg + geo.json`（D2）——当前 miko 的抽取链路仍依赖 7 张旧成品；这是移植第一优先。
2. miko 前端字体子集嵌入（D3）未实现（项目级规定要求成品 `<text>` + 字体嵌入）。
3. 7 张产物未重出：仓内仍是旧带字版本（README 已注明）。
4. 比例尺/指北针/引线/图例多行/hatch/区域注记、编辑器旋转手柄等交互、`scene.json` 入库、多图接入：见 §6。
5. 备注：`Myanmar/myanmar.py` 的城市数据保留 3 个名称字段（仅数据、不绘制，作为未来 `geo.json`
   初始标注的种子）；其余脚本的标注数据已删，移植时以快照为准。

## 13. 2026-10-28 执行记录：移除后端

> **2026-10-28 晚更新**：本节是「`geo.json` + `scene.json` 双文件」过渡实现的历史记录；同日随后合并为
> 单文件 `geo.json`（排版存顶层 `page` 块）：函数改名为 `validatePage` / `normalizePage` /
> `serializeMapDocFile` / `pageDigest`，导出改为 `<stem>.geo.json`，旧 `scene.json` 不再支持。
> 当前契约见 [`PAGE-EDITOR.md`](PAGE-EDITOR.md)；本节以下内容（含 §13.2 的旧函数名、§13.3 的
> `<stem>.scene.json` 导出与「旧 scene.json 仍可导入」）只作历史记录，**不是当前流程**。

### 13.1 已删除：`tools/`

- 整个 `tools/` 目录删除：`studio.py`、`studio.toml`、`prepare_demo.py`、`check_contract.py`、
  `mapdoc/`（`__init__` / compose / contract / extract / fsutil / geo / page / render）、
  `tools/tests/`（Python 单测）、`tools/README.md`、`__pycache__`。
- `vite.config.ts` 同步移除 studio 子进程管理（`studioDevPlugin` / `ensureStudio` / 探活 / 内部端口）、
  `server.proxy`（`/api`、`/base.svg`、`/final.svg`、`/geo.json`）与 `tools/studio.toml` 端口读取；
  dev 端口固定 5173（`SITE_PORT` + `strictPort`），唯一真值在 `vite.config.ts`。
- 删除后仓库内不再有 Python 代码；`npm run dev` 只启动 Vite，`map.html` 不发起任何后端请求。

### 13.2 已迁移：合成从 Python 改到 TypeScript

- `tools/mapdoc/contract.py::read_base` → `src/core/base-svg.ts::readBaseSvg`（C1–C4 与中文错误文案同步）。
- `tools/mapdoc/page.py` 的校验/规范化/digest → `src/core/page.ts`（`validateGeo` / `validateScene` /
  `normalizeGeo` / `normalizeScene` / `canonicalJson` / `sha256OfBytes` / `serializeSceneFile` /
  `geoDigest` / `sceneDigest`）。
- `tools/mapdoc/render.py` 的排版几何 → `src/core/page-layout.ts`：预览 `render/page-svg.ts` 与成品
  `render/compose-svg.ts` 共用同一套公式。
- `tools/mapdoc/compose.py` → `src/render/compose-svg.ts::composeFinalSvg`：图层顺序与 marker 形状
  沿用旧字节布局；数值走 `render/page-format.ts`；确定性口径见 `docs/PAGE-EDITOR.md` §6（同一浏览器
  实现下同输入同字节，不再要求与旧 Python 逐字节一致）。
- 补丁：成品给 `<g id="mapdoc-map">` 加 `clip-path="url(#mapdoc-map-clip)"`（`<defs>` 里固定输出，
  矩形 = `geo.base.view_box`）。原因：Cartopy/matplotlib 底图根内自带覆盖整个 Figure 的图幅白底
  path，旧 Python 合成同样未裁剪；预览 `<image>` 天然只显示地图矩形，成品不裁剪会在非白纸色下
  外溢整页。裁剪后预览与成品可见范围一致。
- 新增 `src/core/document.ts`（`PageDocument`、上传文件分类、导出命名）与 `src/ui/page-open.ts`
  （上传面板）；`src/app/page-main.ts` / `page-editor.ts` 去掉全部 HTTP 客户端，改为上传打开 + 双导出。

### 13.3 新的输入/输出流程

- 输入：浏览器上传/拖入 Cartopy 直出的 `<stem>.svg` + `<stem>.geo.json`（可选 `scene.json`）；
  打开时校验底图 C1–C4、严格 UTF-8、sha256 与 `geo.base.sha256` 一致、viewBox/尺寸容差 0.01pt；
  scene 不合法只告警并回退默认排版。
- 输出：`导出 JSON`（`Ctrl+S`）→ `<stem>.scene.json`（`application/json`）；`导出 SVG` →
  `<stem>.svg`（`image/svg+xml`，浏览器内合成）。
- 首次运行不再需要 `python3 tools/prepare_demo.py`；`demo/` 里的旧底图/geo 可直接上传（本地
  gitignored 产物）。

### 13.4 字体仍未做

- D3（前端按字符裁字体子集 + 成品嵌入）本轮未实现；`final.svg` 的文字仍用 `font-family` 引用本机
  字体，跨机字形可能变化，印刷前转曲。合成接口已留好以后往 `<defs>` 插 `@font-face` 的位置。

### 13.5 旧产物与旧脚本

- `extract.py` / `prepare_demo.py` / `check_contract.py` 随 `tools/` 废弃：本仓不再解析旧带字成品 SVG，
  也不再用 Python 单测校验契约；契约由 Cartopy 直出 + 前端打开校验保证。
- 旧 demo 的 `scene.json` 仍可导入：`figure` 里的服务器路径会被覆盖成当前底图文件名（标脏），
  `base` 声明不一致只告警并更新；需要交付时重新导出 JSON/SVG。
- 7 张 Cartopy 旧产物若还要用，需要先跑新版 Cartopy 脚本重出 `base.svg + geo.json`（§12 只是历史记录）。

### 13.6 验证

- `npm run check`（typecheck / lint / arch / format:check / test / build）通过。
- 浏览器 `npm run dev` → `http://localhost:5173/map.html`：上传 demo 的 base + geo → 默认排版完整 →
  编辑 → 导出 JSON/SVG；再上传导出的 JSON round-trip 恢复排版，再导出 SVG 字节一致。
- 细节见 `docs/PAGE-EDITOR.md` §10。
