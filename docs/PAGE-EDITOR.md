# 出版排版编辑器（map.html）数据流与契约

> 状态：**取代** `docs/merge/DESIGN.md` 的「冻结底图 × 草图叠加层」方案。旧方案把 cartopy 出的
> 整幅成品当底图、让草图内核画几何约束叠加层；新方案把**所有非地理内容（文字/图例/标题/图框/注释）
> 全部搬到前端**，cartopy 只负责纯地图字节。
>
> 本文件是前后端共同遵守的**唯一契约**：`geo.json` / `scene.json` / 最终 SVG 的字段、布局公式、
> HTTP 端点、文件布局都在这里。实现改动先改这里。

## 1. 数据流

```
[Cartopy 渲染（当前轮不改 Cartopy 仓）]
   成品 SVG（含地形/水系/矢量 + 标题/图例/色标/文字/框）
        │  tools/prepare_demo.py（本仓的一次性适配器：剥离非地理层）
        ▼
  .build/<stem>.base.svg   纯地图：地形、水系、行政边界、经纬网、地理坐标点；无任何 <text>、
                         无标题/图例/色标/图框/画布白底；viewBox 裁到地图框
  <stem>.geo.json          地理元数据：地图框、经纬网刻度、地名标注候选、配色/图例样式、
                         默认文案、色标刻度。只读，前端与 Python 都读它
        │  浏览器 map.html（出版排版编辑器）
        ▼
  <stem>.scene.json        排版真值：纸张、地图摆放、图框/刻度、文字、图例、色标
        │  PUT /api/scene → tools/studio.py → tools/mapdoc/compose.py（Python 合成）
        ▼
  <stem>.svg               交付成品：纸张尺寸的 SVG，内嵌纯矢量地图 + 排版层
```

**分层规则（不可协商）**

1. 地理层只读：底图 SVG 在前端只作为 `<image>` 显示，不解析、不回写。
2. cartopy/底图里**不出现任何文字**（连经纬度刻度数字也没有），不出现标题/图例/色标/图框/画布白底。
3. 所有文字、图框、图例、色标、注释由前端编排，存 `scene.json`。
4. 成品由 **Python 合成**：浏览器只读写 `scene.json`；`final.svg` 由 `compose.py` 生成，
   同一 base + geo + scene → 同一字节。

当前轮（无法改 Cartopy 仓）由 `prepare_demo.py` 从现有成品 SVG **剥离**出纯底图并抽取 `geo.json`；
未来 Cartopy 侧直接按本契约输出 `base.svg + geo.json` 时，`prepare_demo.py` 只做复制/校验。

## 2. 文件与落点

```
demo/figures/<Figure>/                        # demo/ 被 gitignore
  <stem>.svg                                  # final（compose 写）
  <stem>.geo.json                             # geo（prepare 写；只读）
  <stem>.scene.json                           # scene（studio 写；前端真值）
  .build/<stem>.base.svg                      # 纯底图（prepare 写；只读）
  .build/<stem>.lock                          # 合成/写入的 fcntl.flock

tools/
  mapdoc/contract.py   底图契约（C1..C4）、SVG 切分、sha256、final marker
  mapdoc/extract.py    成品 SVG → (纯底图字节, geo 对象)；纯函数，便于 fixture 测试
  mapdoc/geo.py        geo.json 读取/校验/派生（bbox、刻度、配色）
  mapdoc/page.py       scene.json 数据类、校验、规范化、digest
  mapdoc/render.py     scene + geo → 排版层 SVG 字符串（纯函数）
  mapdoc/compose.py    base + 排版层 → final SVG 字节（加锁、原子写）
  mapdoc/fsutil.py     flock + 原子写（沿用）
  prepare_demo.py      跑 extract，写 base/geo（幂等；不碰 scene/final）
  studio.py            HTTP：doc/geo/scene/compose/静态文件
  check_contract.py    契约自检 CLI
```

`tools/studio.toml` 保持「figure key → final svg 路径」；base 仍在 `.build/`、geo/scene 与 final 同目录。

## 3. `geo.json`（format `mapdoc-geo` v1，只读）

```jsonc
{
  "format": "mapdoc-geo",
  "version": 1,
  "base": {
    "sha256": "<base.svg 的 sha256>",
    "view_box": [38.88, 102.7728, 896.350289, 712.3824],
    "width_pt": 896.350289,
    "height_pt": 712.3824,
  },
  "graticule": {
    "lon": [{ "value": 35, "label": "35°E", "x": 169.527973, "y": 829.8452, "side": "bottom" }],
    "lat": [{ "value": 46, "label": "46°N", "x": 33.88, "y": 731.037789, "side": "left" }],
    "style": { "stroke": "#808080", "width_pt": 0.5, "dash": [0.5, 0.825], "opacity": 0.4 },
  },
  // 地名/地物标注候选：位置是底图坐标（viewBox 坐标）；文字由前端渲染
  "labels": [
    {
      "id": "label-country-哈萨克斯坦",
      "kind": "country", // country|sea|highland|river|city|area|other
      "text": "哈萨克斯坦", // 主文字（多行时 name_lines 全给）
      "lines": ["哈萨克斯坦"],
      "x": 719.381081,
      "y": 703.365097,
      "rotation_deg": 0,
      "anchor": "middle", // start|middle|end
      "font_size_pt": 12,
      "color": "#3a3a3a",
      "italic": false,
      "halo": { "color": "#ffffff", "width_pt": 3 }, // 无描边光晕时 null
      "order": 0, // 原图绘制顺序（z 序）
    },
  ],
  "relief": {
    "title": "高程 / 水深",
    "unit": "m",
    "vmin": -2500,
    "vmax": 2500,
    "stops": [
      { "offset": 0, "color": "#08306b" },
      { "offset": 1, "color": "#ffffff" },
    ],
    "ticks": [-2000, -1000, 0, 500, 1000, 1500, 2000],
  },
  "legend": {
    "title": "图例",
    "entries": [
      {
        "label": "国界",
        "shape": "line", // line|rect|point
        "stroke": "#4a4a4a",
        "width_pt": 1.4,
        "dash": null,
        "fill": null,
        "opacity": 1,
        "marker": null, // point 时：star|square|circle
      },
    ],
  },
  "suggestions": {
    // 只用于前端「从底图初始化」预填，不参与合成
    "title": "伏尔加河流域地形图",
    "subtitle": "ETOPO 2022 | 流域: HydroSHEDS | 国界: GADM 4.1",
    "notes": ["注 1：…", "…"], // 原图右栏注记（每项一行）
    "source": "地形: NOAA NCEI ETOPO 2022（15″） | …",
    "area_annotation": ["伏尔加河流域", "约 141 万 km²"],
    "legend_title": "图例",
    "colorbar_title": "高程 / 水深",
  },
}
```

约束：`base.view_box` 是 `[x, y, w, h]`；`width_pt/height_pt = w/h`；刻度 `x/y` 都在底图坐标系；
`side`：经度用 `bottom|top`，纬度用 `left|right`；`labels` 只含**地图内**地名，
图外面积注记放 `suggestions.area_annotation`。数值一律 3 位小数以内、无单位后缀。

## 4. `scene.json`（format `mapdoc-page` v1，前端真值）

```jsonc
{
  "format": "mapdoc-page",
  "version": 1,
  "figure": "demo/figures/Volga/volga_basin_topography_etopo2022_lambert_conformal.svg",
  "base": { "sha256": "<声明>", "width_pt": 896.350289, "height_pt": 712.3824 },
  "paper": {
    "preset": "A4", // A5|A4|A3|Letter|Custom（仅 UI 记忆用）
    "orientation": "landscape", // portrait|landscape
    "width_pt": 841.889764,
    "height_pt": 595.275591,
  },
  "map": { "x": 28, "y": 72, "width_pt": 597.7 },
  // 高度由宽度派生：map.height = width * base.height_pt / base.width_pt（保持纵横比）
  "frame": {
    "show": true,
    "stroke": "#000000",
    "width_pt": 0.8,
    "ticks": true,
    "tick_length_pt": 5,
    "tick_font_size_pt": 7,
    "tick_color": "#444444",
    "tick_gap_pt": 2,
  },
  "style": {
    "paper_color": "#ffffff",
    "font_family": "'Noto Sans Mono CJK SC', 'JetBrains Mono Slashed Medium', 'DejaVu Sans', sans-serif",
    "color": "#111111",
  },
  "items": [/* 见 4.1；数组序 = 绘制序（z 序） */],
  "seq": 42, // 必须 > 所有 item id
}
```

约束：`paper` 宽高 50..5000pt；`map.x/y` 有限即可（越界只告警）；`map.width_pt > 1`；
`base` 由前端回传声明、服务器用真实 base 复核；颜色只接受 `#rrggbb`；数字 3 位小数；
`items.length ≤ 500`；`seq` 为正整数。

### 4.1 item 联合类型

三种 `kind`，共字段：`id`（正整数、唯一）、`kind`、`space`（`page` = 纸张坐标；`map` = 底图坐标）。

**text**

```jsonc
{
  "id": 1,
  "kind": "text",
  "space": "page",
  "role": "title", // title|subtitle|label|annotation|note|source
  "x": 420.944882,
  "y": 50, // page: pt；map: 底图坐标（viewBox 坐标）
  "lines": ["伏尔加河流域地形图"], // 1..40 行，每行 ≤200 字符；不做自动换行
  "font_size_pt": 18,
  "font_family": null, // null = 用 style.font_family
  "color": "#111111",
  "anchor": "middle", // start|middle|end
  "rotation_deg": 0,
  "line_height": 1.35,
  "italic": false,
  "bold": false,
  "halo": null, // 或 {"color":"#ffffff","width_pt":3}（先描边后填充）
}
```

**legend**

```jsonc
{
  "id": 3,
  "kind": "legend",
  "space": "page",
  "x": 641.7,
  "y": 72,
  "width_pt": 172.2,
  "title": "图例",
  "entries": [
    {
      "label": "国界",
      "shape": "line",
      "stroke": "#4a4a4a",
      "width_pt": 1.4,
      "dash": null,
      "fill": null,
      "opacity": 1,
      "marker": null,
    },
  ],
  "font_size_pt": 9,
  "title_size_pt": 12,
  "row_height_pt": 14,
  "padding_pt": 7,
  "swatch_width_pt": 24,
  "swatch_gap_pt": 6,
  "frame": {
    "show": true,
    "stroke": "#bbbbbb",
    "width_pt": 0.8,
    "fill": "#ffffff",
    "opacity": 0.94,
  },
}
```

高度自动派生（公式见 §5.2），不落盘；`width_pt` 由前端创建时按文字测量给出，之后可改。

**colorbar**

```jsonc
{
  "id": 4,
  "kind": "colorbar",
  "space": "page",
  "x": 700,
  "y": 360,
  "width_pt": 14,
  "height_pt": 160,
  "title": "高程 / 水深",
  "unit": "m",
  "show_title": true,
  "show_ticks": true,
  "title_size_pt": 8,
  "label_size_pt": 7,
}
```

配色/刻度来自 `geo.relief`（vmin/vmax/stops/ticks），不落 scene；scene 只存摆放与文字。

## 5. 布局公式（浏览器预览与 Python 合成必须逐字一致）

所有数值都是 pt（1 用户单位 = 1pt）。输出 SVG 的数值格式：最多 3 位小数、去掉尾零（`format_number`）。

### 5.1 底图坐标 → 纸张坐标

```
s  = map.width_pt / geo.base.width_pt
tx = map.x - geo.base.view_box[0] * s
ty = map.y - geo.base.view_box[1] * s
page(p) = (tx + p.x * s, ty + p.y * s)
```

### 5.2 图框与刻度

- 图框 = `rect(map.x, map.y, map.width_pt, map.height)`，`fill=none`，stroke/线宽来自 frame。
- 经度刻度（`side=bottom`）：`px = page(tick.x).x`，线从 `(px, map.y+map.height)` 到
  `(px, map.y+map.height+tick_length)`；标签 `text-anchor=middle`，基线
  `y = map.y+map.height+tick_length+tick_gap+tick_font_size`；`top` 侧镜像（线向上、
  基线 `y = map.y-tick_length-tick_gap`）。只画 `0 ≤ page(tick.x).x ≤ paper.width` 的刻度。
- 纬度刻度（`side=left`）：`py = page(tick.y).y`，线从 `(map.x, py)` 到
  `(map.x-tick_length, py)`；标签 `text-anchor=end`，`x = map.x-tick_length-tick_gap`，
  基线 `py + tick_font_size*0.35`；`right` 侧镜像。只画落在 `0..paper.height` 的刻度。
- 刻度文字取 `geo.graticule.lon/lat[].label`。图框/刻度只在 frame.show/frame.ticks 为 true 时画。

### 5.3 text

- 起点 `(px, py)`：page 空间直接用 item.x/item.y；map 空间用 §5.1 变换。
- 第 i 行基线 `y = py + i * font_size_pt * line_height`（i 从 0 起）；`text-anchor = anchor`。
- 多行整体绕第一行锚点旋转：`<g transform="rotate(rotation_deg px py)">`，组内逐行 `<text x=px y=py+i*lh>`。
- `halo` 非空：同一文字先画 `stroke=halo.color; stroke-width=halo.width_pt; fill=halo.color;
paint-order=stroke` 的副本，再画正常填充（与 matplotlib 的 paint-order 效果一致）。
- 字体：`font-family = item.font_family ?? style.font_family`；`font-size=...px`（用户单位就是 pt）。
  `italic` → `font-style:italic`；`bold` → `font-weight:bold`。
- 文本转义：`& < >`。

### 5.4 legend（高度派生）

```
p  = padding_pt
row_h = max(row_height_pt, font_size_pt * 1.5)
title_h = title ? title_size_pt * 1.4 : 0
height = p*2 + title_h + n*row_h
title 基线 = y + p + title_size_pt
第 i 行中心 = y + p + title_h + row_h*(i+0.5)
swatch: x0 = x+p, x1 = x0+swatch_width_pt（线 / 矩形 / 点都画在 [x0,x1] × 中心线）
label 基线 = 中心 + font_size_pt*0.35，x = x1+swatch_gap_pt，anchor=start
frame.show → 先画 rect(x,y,width_pt,height)
```

- `line`：`<line x0..x1>`，stroke/width/dash；
- `rect`：`<rect x0..x1，高=font_size*0.9>`，中心对齐；stroke/fill/opacity；
- `point`：在中心点画 marker（star：外接半径 `font_size*0.55` 的五角星；square：边长
  `font_size*0.7`；circle：半径 `font_size*0.35`），fill/stroke 取条目。

### 5.5 colorbar

```
bar = rect(item.x, item.y, width_pt, height_pt)
vmin/vmax/stops/ticks 来自 geo.relief
线性渐变（def id = "mapdoc-cbar-<item.id>"）：y1=100% y2=0%（下 = vmin，上 = vmax），
stops 用 offset/color 原样
title（show_title）：基线 y-4，anchor=middle，x = item.x+width_pt/2
每个 tick v：ty = y + height*(1-(v-vmin)/(vmax-vmin))；右侧短线 x+width..x+width+3；
标签 x+width+5，anchor=start，基线 ty + label_size*0.35
单位：title 后接 " (unit)"（unit 非空且标题不含单位时）
```

## 6. 最终 SVG（compose 输出）

```
<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="{paper.width}pt" height="{paper.height}pt"
     viewBox="0 0 {paper.width} {paper.height}" version="1.1">
  <rect ... paper_color .../>                       # 纸张底色
  <g id="mapdoc-map" transform="translate(tx,ty) scale(s)"> BASE_INNER </g>
  <g id="mapdoc-frame"> rect + ticks + tick texts </g>
  <g id="mapdoc-overlay"> items 按数组序 </g>
  <!-- mapdoc-final:<base64(JSON)> -->              # 见 §6.1
</svg>
```

- `BASE_INNER` = `<stem>.base.svg` 根 `<svg>` 起始标签之后、最后一个 `</svg>` 之前的全部字节
  （含 `<defs>`/`<metadata>`/`<style>`/图形），**原样拼接**，不重序列化。
- 底图自带全局 CSS `*{stroke-linejoin:round;stroke-linecap:butt}` 会作用于整份成品，接受。
- 图层 id 前缀 `mapdoc-`；底图与排版层 id 不得冲突。
- 字体**不内嵌**（v1 已知限制）：文字用 `font-family` 引用本机字体；换机器可能换字形，
  需要印刷时在 Inkscape/AI 里转曲。
- 文件末尾恰好一个换行；同一 (base, geo, scene) 输入得到相同字节。

### 6.1 marker

`<!-- mapdoc-final:<base64> -->`，base64 内容为 JSON（键排序、无空白）：
`{"counts":{"colorbar":n,"legend":n,"text":n,"total":n},"geo":"<sha256>","scene":"<digest>","version":1}`
`scene` digest 由 `page.digest(scene)` 定义（对规范化 scene JSON 的 sha256）。

## 7. 底图契约（`contract.py`）

`read_base(data) -> BaseInfo`，错误非空即不合格：

- **C1**：有根 `<svg>`，合法 `viewBox="x y w h"`，`w/h > 0`。
- **C2**：不含 `<text`（纯地图；注释/标题都不允许）。
- **C3**：`</svg>` 恰好 1 次且位于文件末尾（允许最后一个换行）。
- **C4**：不含 `mapdoc-overlay` / `mapdoc-final` 痕迹。
- 同时返回 `view_box`、`width_pt`、`height_pt`、`inner_start/inner_end`（根标签后/收尾标签前）。
- `sha256(data)`、`sha256_file(path)`、`is_sha256(v)`、`make_marker(payload)`、`read_marker(data)`。

`prepare_demo.py` 产出底图后必须跑 `read_base`，失败即中止。

## 8. HTTP 端点（studio，127.0.0.1:8791）

- `GET /api/doc` →
  `{"figure":{"key":"volga","path":"..."},
"base":{"url":"/base.svg","sha256":"...","width_pt":...,"height_pt":...},
"geo":{"url":"/geo.json"},"scene":{"url":"/api/scene"},
"final":{"url":"/final.svg"},
"needs":{"base":false,"geo":false}}`
- `GET /api/geo`：geo.json 原文（404 `{error:"geo_missing"}`）。
- `GET /api/scene`：scene.json 原文；不存在时 `null`。
- `PUT /api/scene`：body = scene（不含 figure；含 base 声明）。服务器校验 → 规范化写 scene.json
  → compose 写 final.svg。响应：
  - `200 {"saved":true,"composed":true,"report":{...},"marker":{...}}`
  - `400 {"error":"invalid_scene","message":"..."}`（不写任何文件）
  - `409 {"error":"base_changed","message":"..."}`；带 `"ack_base_change":true` 重提可接受
  - `409 {"error":"base_size_changed","message":"..."}`（画布尺寸变了，需要重新布局）
  - `503 {"error":"base_missing"|"geo_missing", ...}`
- `POST /api/compose`：用当前 scene 重新合成，返回同 `200` 形状。
- `GET /api/health` → `{"ok":true}`。
- 静态：`/base.svg`、`/final.svg`、`/geo.json`、`dist/index.html`（草图）、`dist/map.html`（本编辑器）。
- 请求体 ≤ 2 MB；no-store；非 GET 校验 Host；沿用现有 studio.py 的安全与错误格式。

## 9. 前端（`map.html`）

**文件布局（遵守 `npm run arch` 的五层）**

```
map.html                        # 入口：<script type="module" src="/src/app/page-main.ts">
src/app/page-main.ts            # 组合根：fetch doc/geo/scene → 建 shell → 交互接线 → 保存
src/app/page-editor.ts          # 编辑器状态机：选择/拖拽/缩放/平移/脏标记/保存
src/config/page.ts              # 纸张预设、默认页边距/字号、URL、上限
src/core/page.ts                # scene/geo 类型、serialize/validate/digest（纯逻辑，node 可测）
src/core/page-layout.ts         # §5 全部布局公式 + 默认排版（从 geo 生成初始 scene）
src/render/page-svg.ts          # scene + geo → 预览 SVG DOM（纸张/地图 image/框/刻度/items）
src/render/page-format.ts       # 数字格式化、颜色/转义、SVG 属性 helper
src/ui/page-sidebar.ts          # 右侧属性面板（页面/图框/元素/属性/图例编辑）
src/ui/page-toolbar.ts          # 顶部工具条
src/ui/page-notify.ts           # 简易消息区
src/styles-page.css             # 本页样式（只写 .page-*；token 复用 miko_ui/styles.css）
tests/core/page.test.ts         # codec/校验/布局公式
```

图层依赖按现有规则：`app → ui/render/core/config`、`ui → render/core/config`、`render → core/config`、
`core → config`。不允许 `src/core/page.ts` 碰 DOM。新文件都按现有中文注释三分类写注释。

**交互（基础可用即可，不做撤销/多文档）**

- 打开即 `GET /api/doc`、`/api/geo`、`/api/scene`；scene 为 `null` 时用 `core/page-layout.ts`
  的 `defaultScene(geo, doc.base)` 生成初始排版（默认 A4 横向：地图占左侧、右栏图例/注记/色标、
  标题/副标题顶部、来源底部、全部地名标注按 map 空间铺上），标记为未保存。
  排版随纸张自适应：`k = clamp(min(长边/841.89, 短边/595.28), 0.62, 1.6)` 缩放字号/间距；
  **横向**纸用「左地图 + 右栏」，**纵向**纸（`h > w*1.05`）用「地图满内容宽 + 下方一排
  图例/注记/色标」，并让开地图底部的经度刻度标签。
- 画布 = 一个 SVG（viewBox 随缩放/平移变化）。纸张白底 + 底图 `<image href="/base.svg">`
  （放在 map 矩形）+ 图框/刻度 + items。缩放滚轮（以指针为中心）、空格/中键拖平移、
  「适应页面」/「1:1」按钮。
- 选中：点 item 选中（高亮虚线框）；拖拽移动（map 空间的 item 写回底图坐标，page 空间写回 pt）；
  方向键 1pt 微移；Delete 删除（title 等也允许删）。
- 双击文字 item → 侧栏内容框聚焦；侧栏改内容/字号/颜色/对齐/旋转/行高/斜体/加粗/光晕。
- 工具栏：保存（Ctrl+S）、重新合成、打开成品、适应页面、添加文字/标题/图例/色标。
- 侧栏分区：页面（纸张预设/方向/宽高/页边距「重新排默认版式」）、地图（x/y/宽度、图框开关/
  刻度开关/线宽/颜色/刻度字号）、元素列表（选中/删除/新增）、选中项属性（按 kind 分支）、
  图例条目编辑（改 label、显示/隐藏、增删）。
- 保存：`PUT /api/scene`；成功提示「已保存并合成」+ 报告 warnings；409 base_changed → 确认后
  带 `ack_base_change` 重提；409 base_size_changed → 提示刷新；400 → 显示 message。
- 未保存保护：`beforeunload` 比对 scene 签名。
- 已保存时 `document.title` 显示图名 + 元素数；状态栏显示脏标记。
- 颜色输入用 `<input type=color>`，数字用 miko_ui 的 `createNumberField`/`createNumberRow`，
  按钮/开关/分段用 miko_ui 现有组件（参考 `src/ui/toolbar.ts`、`src/ui/editor-controls.ts`）。
- 不引入新依赖；只用 `miko_ui` 与标准 DOM。禁止 `alert/confirm`、`console`（沿用 eslint）。

## 10. 验收（本轮完成标准）

1. `python3 tools/prepare_demo.py` 在现有 Cartopy 成品上成功，产出纯底图（无 `<text>`）与 geo.json；
   `python3 tools/check_contract.py` 通过。
2. `python3 -m unittest discover -s tools/tests -t tools` 全绿。
3. `npm run check`（typecheck/lint/arch/format/test/build）全绿，`dist/map.html` 可被 studio 服务。
4. 浏览器打开地图编辑器：初始排版出现完整图（标题/副标题/地图/框+刻度/地名/图例/注记/色标/来源）；
   拖动/缩放地图后地名与刻度跟随；改标题/图例/色标后保存 → `final.svg` 对应变化。
5. `final.svg` 是纸张尺寸、单文件、地图为矢量（底图内联）、文字可选中、无 `<image>` 底图引用。
6. README / ARCHITECTURE 地图模式章节 / tools/README 同步到新数据流。

## 11. 非目标与已知限制

- 文字字体不内嵌（v1）；跨机字形可能变化，印刷前转曲。
- 不做自动换行/两端对齐/字距；换行由前端在创建条目时按宽度折好写进 `lines`。
- 不做比例尺/指北针（geo 未提供；后续 cartopy 侧补数据再加组件）。
- 不做撤销/重做、多图切换、图层管理（数组序即 z 序）。
- 默认排版只是起点：小纸张（A5）+ 8 条图例 + 多条注记时，按 k 缩小字号后仍可能偏挤，
  需要手工调字号/位置或换纸张；用户改过排版后切纸张不会自动重排（需点「重新排默认版式」）。
- Cartopy 仓本轮不改；`extract.py` 是一次性适配器，未来由渲染侧直接守 §7 契约。
