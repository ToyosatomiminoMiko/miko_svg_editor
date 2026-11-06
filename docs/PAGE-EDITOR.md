# 出版排版编辑器(map.html)数据流与契约

> 状态:**取代** `docs/merge/DESIGN.md` 的「冻结底图 × 草图叠加层」方案.旧方案把 cartopy 出的
> 整幅成品当底图,让草图内核画几何约束叠加层;新方案把**所有非地理内容(文字/图例/标题/图框/注释)
> 全部搬到前端**,cartopy 只负责纯地图字节.
>
> 自 2026-10-28 起本页是**纯静态前端**:没有 studio,没有 Python,没有任何 HTTP API.用户在浏览器里
> 上传 Cartopy 产出的 `base.svg + geo.json`,在浏览器内排版,编辑后导出**同一份 `geo.json`**
> (geo 全部字段 + `page` 排版块)与成品 SVG;用导出的 `geo.json` 重新打开即可恢复排版,继续编辑.
> 自 2026-10-29 起**成品 SVG 本身就是可再编辑的工程文件**:导出时把整份 `geo.json` 原文与底图前后缀
> 写进 `<metadata id="mapdoc-source">`,只选一份成品 SVG 就能恢复排版与底图(§6.2).**打开只支持
> 两条路径**:`base.svg + geo.json`,或带内嵌可编辑源的成品 SVG;没有内嵌源的旧版成品不再支持--
> 请用 Cartopy 重新生成 `base.svg + geo.json` 导入后重新导出.
> 本文件是地图页的唯一契约:`geo.json` / `page` 块 / 最终 SVG 的字段,布局公式,文件类型与校验
> 语义,导出命名都在这里;实现改动先改这里.

## 1. 数据流

```
Cartopy_file(另一个仓;本仓只消费它的产物)
  <stem>.svg           纯几何底图:地形/水系/边界/经纬网/地理坐标点;无任何 <text>,
                       无标题/图例/色标/图框/画布白底;viewBox 裁到地图框
  <stem>.geo.json      地理元数据(format mapdoc-geo v2):地图框,经纬网刻度,地名候选
                       (role/文字/位置/锚点/字号;样式归前端 config/text-style.ts),
                       图例样式,默认文案,色标刻度;只读
        │  浏览器上传(文件选择 / 拖放):
        │    ① base.svg + geo.json(各恰好一个);或
        │    ② 一份本编辑器导出的成品 <stem>.svg(内嵌整份 geo.json 与底图前后缀,单文件即可再编辑)
        ▼
map.html(Vite 静态站;npm run dev -> http://localhost:5173/map.html)
  core/base-svg.ts      底图契约 C1–C4 + 根标签内原文切片(inner / prefix / suffix)
  core/open-map.ts      打开的两条路径:分栏 -> 校验 -> PageDocument + 初始排版(纯逻辑,node 可测)
  core/final-svg.ts     成品 SVG 的再编辑支持:读 `<metadata>` 内嵌源,定位 mapdoc-map,
                        还原底图原文(纯逻辑,node 可测)
  core/document.ts      PageDocument(底图字节 + sha256 + 底图解析结果 + 规范化 geo)+
                        createPageDocument(两条路径共用的一致性校验)
  core/base64.ts        内嵌源与 marker 的 UTF-8 base64 编解码
  core/page.ts          normalizeGeo / validateGeo / normalizePage / validatePage /
                        enforceHorizontalCenter(左右居中约束)/ sha256OfBytes / canonicalJson /
                        geoDigest / pageDigest / serializeMapDocFile
  core/text-style.ts    分类文字样式:item -> 分类,覆盖表解析/批量写回 item,整分类/单字段恢复默认,
                        打开时按分类重建逐条文字样式(resyncTextStyles;纯逻辑,node 可测)
  core/page-layout.ts   §5 全部布局公式 + defaultPageLayout(缺可选块时降级;
                        title/subtitle/source 默认开启左右居中)
  render/compose-svg.ts layout + geo + base.inner -> final.svg 字符串(纯函数,node 可测)
        │  编辑:排版只改内存里的 PageLayout(不落盘)
        │  导出(保存对话框优先;不可用/写失败退回 Blob + <a download>)
        ▼
  <stem>.geo.json      统一文件:geo 全部字段 + `page` 排版块(纸张,地图摆放,图框/刻度,
                       分类文字样式覆盖,文字,图例,色标);再次打开即恢复排版
  <stem>.svg           交付成品:纸张尺寸,底图矢量内联,文字为可选中 <text>,
                       不引用外部 base.svg(底图自带的内联 <image> 属底图内容,原样内联);
                       同时是再编辑工程文件(§6.2 内嵌源 + §6.1 marker)
```

**分层规则(不可协商)**

1. 地理层只读:底图上传后只作为预览用的 `<image>` 与成品内联的原文,不解析成图元,不回写.
2. Cartopy/底图里**不出现任何文字**(连经纬度刻度数字也没有),不出现标题/图例/色标/图框/画布白底.
3. 所有文字,图框,图例,色标,注释由前端编排,存 `geo.json` 的 `page` 块(排版真值).
4. 成品由**浏览器内同一实现**合成(`render/compose-svg.ts`):同一份「底图字节 + geo + `page` 块」
   在**同一浏览器实现下**得到同一字节(确定性口径见 §6).导出是纯函数,不读 DOM,时间,随机数.

**地图文字标注链路(样式唯一真源)**

| 层             | 位置                                                                                              | 拥有                                                                                       | 不拥有                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Cartopy 生成端 | `geo.labels[]` 的 `id`/`role`/`text`/`x`/`y`/`anchor`/`font_size_pt`/`order`                      | 语义与摆放                                                                                 | 任何文字样式;`font_size_pt` 只是「分类默认统一字号」的中位数来源,不是逐条样式 |
| 代码默认       | `config/text-style.ts` 的 `MAP_LABEL_ROLE_STYLES`/`MAP_LABEL_STYLE`/`PAGE_TEXT_STYLES`/分类元信息 | 默认样式                                                                                   | 用户覆盖                                                                      |
| 用户覆盖       | `page.text_style`                                                                                 | 只存用户显式改过的分类字段                                                                 | 逐条 item 的样式真值                                                          |
| item 物化值    | `TextItem` 的 `font_size_pt`/`color`/`halo` 等显式字段                                            | 渲染消费的字段,由分类样式批量写入;页面分类字号同时作为「覆盖 ?? 现值 ?? 默认」中的现值回退 | 独立样式真值;颜色等以分类为准,页面字号现值也不会被固定默认字号覆盖            |
| 排版/几何      | `PageLayout.items`                                                                                | 位置,内容,角色,锚点,旋转,居中约束                                                          | 样式来源                                                                      |

链路:`geo.labels[]` -> `core/open-map.ts` 打开(`validateGeo`/`normalizeGeo`;`page` 块缺省 ->
`defaultPageLayout`,存在 -> `validatePage`+`normalizePage`)-> `core/page-layout.ts` 的 `makeLabelItem`
(`geo_label_id = label.id` 绑定回来源,分类 = `label.role`,样式 = `page.text_style[分类]` 覆盖 ??
`config/text-style.ts` 默认,字号 = 覆盖 ?? 该分类全部地名 `font_size_pt` 的中位数 × 地图缩放 `s`,
夹 4..40 并保留 1 位小数)-> 用户在「样式设置」窗口改分类时,`core/text-style.ts` 的 `applyTextStyle`
写覆盖并把该分类全部 item 的物化字段同步一遍(打开时 `resyncTextStyles` 做同一件事)-> 渲染/合成只读
item 的物化字段 -> `serializeMapDocFile` 把 geo 全字段 + `normalizePage(layout)` 落盘,成品 SVG 内嵌
同一份 geo.json 原文 -> 重新打开走同一条链路.**生成端不存样式;item 不是独立样式真源;地图分类
字号恒统一**(同一分类下所有地名永远相等;窗口改任意字段,哪怕只改颜色,也会把该分类字号统一到
窗口值).页面文字的分类字号口径不同:`覆盖 font_size_pt ?? 该分类现有 item 的字号 ?? 固定默认
字号`(`PAGE_TITLE_SIZE_PT=18` / `PAGE_SUBTITLE_SIZE_PT=9` / `PAGE_NOTE_SIZE_PT=7.5` /
`PAGE_SOURCE_SIZE_PT=7`,不随纸张缩放)--item 里已有的字号优先保留,导出 -> 打开幂等,窗口把
这种与固定默认不同的状态标为「排版值」;只有用户显式改字号或恢复默认才按固定默认/覆盖重算.

## 2. 文件与落点

```
Cartopy_file 侧(另一个仓):
  <stem>.svg                 纯几何底图;与 geo 成对生成
  <stem>.geo.json            format=mapdoc-geo v2;与底图字节 sha256 绑定

浏览器上传(只读;不落盘,不写服务器):
  <stem>.svg                 底图(Cartopy 纯几何),或本编辑器导出的成品(必须带内嵌可编辑源)
  <stem>.geo.json            地理元数据(`base.svg` 路径必需;只打开成品 SVG 时可省略;不再有可选的 scene.json)

浏览器导出的两个文件(优先弹系统保存对话框让用户选位置,不支持时落到浏览器下载目录;
文件名由底图文件名派生):
  <stem>.geo.json            geoFileNameOf(document) = `<底图 stem>.geo.json`
                             = geo 全部字段 + `page` 排版块
  <stem>.svg                 finalFileNameOf(document) = `<底图 stem>.svg`
```

- `<stem>` = 上传底图文件名去掉末尾 `.svg`(大小写不敏感;空名回退 `map`),见
  `core/document.ts` 的 `baseStemOf`.
- 一次只打开一份地图(没有图库/多图切换);`打开...` 会先丢弃当前文档(脏时确认).
- 没有任何服务器侧产物:不再有 `.build/`,`.lock`,`tools/` 下的读写,也没有「保存」动作--
  导出的 `geo.json` 就是排版落盘;导出的成品 SVG 也自带同一份排版(§6.2),可单独再打开.
- 打开成品 SVG 时文件名沿用该 SVG 的 stem:再次导出的 `geo.json` / 成品 SVG 同名覆盖,便于归档.

## 3. `geo.json`(format `mapdoc-geo` v2)

Cartopy 侧已对齐本契约:渲染时直接写「纯几何底图 + geo.json」,本仓不再从成品 SVG 反推
(旧的 `extract.py`/`prepare_demo.py` 已删除).`geo.json` 的**地理字段**(`format` / `version` /
`base` / `graticule` / `labels` / `relief` / `legend` / `suggestions`)是只读输入,**所有 geo 字段
在打开,编辑,导出全过程都不改写**;编辑器导出时只在同文件顶层追加 `page` 块(§4).
Cartopy 直出的 geo.json 没有 `page` 键(未知键对 Cartopy 的 `tools/check_geo.py` 无影响,它只校验
已知必需块).

```jsonc
{
  "format": "mapdoc-geo",
  "version": 2,
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
  // 地名/地物标注候选:位置是底图坐标(viewBox 坐标);样式由前端 role 表决定,这里不给样式
  "labels": [
    {
      "id": "label-country-哈萨克斯坦", // 生成端给稳定 id(id 前缀按角色家族)
      "role": "country", // 语义角色,决定颜色/斜体(枚举见下方约束)
      "text": "哈萨克斯坦", // 原始文字;换行用 "\n",前端自己 split
      "x": 719.381081, // 底图坐标;anchor=start 是文字块左端,middle 中心,end 右端
      "y": 703.365097, // 底图坐标;文字块垂直中心(v2 语义,前端换算回第一行基线)
      "anchor": "middle", // start|middle|end
      "font_size_pt": 12,
      "order": 0, // 原图绘制顺序(z 序)
    },
  ],
  // 可选块:Cartopy 不画色标时整个 relief 键缺省(前端归一化为 null,默认排版不生成色标)
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
  // 可选块:没有图例时缺省(前端归一化为空 entries,默认排版不留空图例框)
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
        "marker": null, // point 时:star|square|circle
      },
    ],
  },
  // 可选块:只用于前端「默认排版」预填,不参与合成;整块缺省时标题/注记/来源都不生成
  "suggestions": {
    "title": "伏尔加河流域地形图",
    "subtitle": "ETOPO 2022 | 流域: HydroSHEDS | 国界: GADM 4.1",
    "notes": ["注 1:...", "..."], // 原图右栏注记(每项一行)
    "source": "地形: NOAA NCEI ETOPO 2022(15″) | ...",
    "area_annotation": ["伏尔加河流域", "约 141 万 km²"],
    "legend_title": "图例",
    "colorbar_title": "高程 / 水深",
  },
}
```

约束:

- **必需块**:`format` / `version` / `base` / `graticule`(至少 `lon`,`lat` 两个数组)/ `labels`.
  `base.view_box` 是 `[x, y, w, h]`,`width_pt/height_pt = w/h`;`geo.base.sha256` 必须等于实际上传
  底图字节的 sha256(打开时校验).`graticule.style` 是可选字段(缺省时 `normalizeGeo` 补中性线型,
  当前渲染不读它,只为类型完整).
- **可选块**:`relief` / `legend` / `suggestions` 允许**整块缺省**(键不存在,由 Cartopy 决定写不写),
  不是必须写 `null`;`suggestions` 的**内部字段也可以逐个缺省**(Cartopy 只写调用方给了的键).
  `validateGeo` 只在块存在时做基础结构检查(`legend.entries` 数组,`relief.stops` 数组且
  `vmax > vmin`,`suggestions.notes` 数组),`normalizeGeo` 逐块/逐字段兜底:
  - `legend` 缺省或结构坏 -> `{title:'图例', entries: []}`(`title` 缺省也用「图例」);
  - `suggestions` 缺省或结构坏 -> 全空(字符串 -> `''`,数组 -> `[]`);只影响缺的那一项;
  - `relief` 缺省或结构不完整(缺 `title`/`unit`/`vmin`/`vmax`/`stops`,`stops` 为空,
    `vmax <= vmin`,数值非有限)-> `null`.
    这样「没有图例/没有色标/没有默认文案」的图也能打开,默认排版自动不生成对应的框(§5.6).
- 刻度 `x/y` 都在底图坐标系;`side`:经度用 `bottom|top`,纬度用 `left|right`;
  `labels` 只含**地图内**地名,图外面积注记放 `suggestions.area_annotation`.
- `labels[].role` 枚举(唯一真源是 `src/config/text-style.ts` 的 `MAP_LABEL_ROLES`):`country`,
  `country-name`,`sea`,`city`,`city-reference`,`river`,`highland`,`area`,`area-muted`,
  `area-accent-1` ~ `area-accent-4`,`area-basin`;它决定颜色/斜体,其余样式是全局常量.
- `labels` 逐条校验(`validateGeo`):`id` 非空且唯一,`role` 在枚举内,`text` 字符串,`x`/`y` 有限,
  `anchor` 合法,`font_size_pt` 正数,`order` 整数.v2 已无 `kind`/`lines`/`color`/`italic`/`halo`/
  `rotation_deg`:多行由前端 `text.split('\n')` 得到,样式由 `role` 查 `config/text-style.ts`,
  旋转默认 0(编辑器里仍可旋转).版本为 1 的旧 geo 直接拒绝并提示「旧 v1 契约,请重新生成」.
- 颜色只接受 `#rrggbb`.geo 侧数值保留 Cartopy 原样精度(例如 `view_box` 的 `896.350289` 不截断);
  只有导出时 `page` 块内的数字统一 3 位小数(§4).导出文件递归按键名排序,2 空格缩进,末尾一个
  换行,同一输入两次导出字节相同.

## 4. `page` 块(排版真值,编辑器写入 `geo.json`)

`page` 是 `geo.json` 顶层的排版块(键名固定 `page`,`MAP_DOC_PAGE_KEY`),由本编辑器写入;
Cartopy 直出的 geo.json 没有这个键.形状:

```jsonc
{
  "paper": {
    "preset": "A4", // A5|A4|A3|Letter|Custom(仅 UI 记忆用)
    "orientation": "landscape", // portrait|landscape
    "width_pt": 841.89,
    "height_pt": 595.276,
  },
  "map": { "x": 28, "y": 72, "width_pt": 597.7 },
  // 高度由宽度派生:map.height = width * geo.base.height_pt / geo.base.width_pt(保持纵横比)
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
  // 分类样式覆盖表(可选):只存用户显式改过的字段,没列出的分类/字段用分类默认值
  "text_style": {
    "title": { "font_size_pt": 20, "color": "#111111", "font_weight": 600 },
    "city": {
      "font_size_pt": 8, // 地图分类:字号恒统一;缺省时用分类默认统一字号(该分类底图字号中位数 × 缩放)
      "color": "#222222",
      "halo": { "color": "#ffffff", "width_pt": 2 },
    },
  },
  "items": [/* 见 4.1;数组序 = 绘制序(z 序) */],
  "seq": 42, // 必须 > 所有 item id
}
```

约束:

- `page` 块**没有** `format` / `version` / `figure` / `base`:文件身份只在顶层 `geo`
  (`format` / `version`),底图身份也只在顶层 `geo.base`;`geo.base.sha256` 必须与上传底图字节的
  sha256 一致(打开时校验).排版不再单独声明底图,因此不存在「排版记录的底图与本次上传不一致」
  的分支.
- `paper` 宽高 50..5000pt;`map.x/y` 有限即可(越界只告警);`map.width_pt > 1`;颜色只接受
  `#rrggbb`;数字 3 位小数;`items.length ≤ 500`;`seq` 为正整数且大于所有 item id.
  text item 的 `font_weight` 必须是 100..900 的整数,`letter_spacing_em` 必须是有限数且在 -1..2;
  text item 的 `center_h` 必须是布尔值,且 `space=map` 时不能为 `true`(地图地名位置属于底图数据).
- `text_style`(可选,缺省 `{}`,`normalizePage` 一定补上):**分类文字样式覆盖表**.键必须属于
  20 个分类 id(页面文字 `title`/`subtitle`/`annotation`/`note`/`source`/`label` + 地图地名
  `city`/`city-reference`/`area`/`area-muted`/`area-accent-1` ~ `area-accent-4`/`country`/
  `country-name`/`sea`/`river`/`highland`/`area-basin`,唯一真源是 `config/text-style.ts` 的
  `TEXT_STYLE_CATEGORY_IDS`);值对象的字段只允许 `font_size_pt`,`color`,`italic`,`font_weight`,
  `letter_spacing_em`,`line_height`,`halo` 七个,且**只存用户显式改过的值**--默认值仍在
  `config/text-style.ts`,不复制进文件.地图分类的字号**恒统一**:`font_size_pt` 缺省时使用
  「分类默认统一字号」--取该分类全部 `geo.labels` 的 `font_size_pt` 中位数 × 地图缩放比 `s`,
  夹到 4..40 并保留 1 位小数;该分类没有地名时回退 10pt;同一分类下所有地名永远使用同一个字号.
  页面分类的字号口径是「覆盖 `font_size_pt` ?? 该分类现有 item 的字号 ?? `defaultTextFontSizePt`」:
  页面默认字号固定(标题 18pt / 副标题 9pt / 注记 7.5pt / 来源 7pt,不随纸张缩放);item 里已有
  的字号优先保留,按分类重建不会改写它(导出 -> 打开字节幂等);用户显式改字号或恢复默认才按
  固定默认值/覆盖重写.覆盖表是「覆盖 ?? 分类默认」的样式来源:设置时由 `core/text-style.ts` 把
  解析后的样式批量写回该分类全部 item,默认排版(§5.6)也按它解析初始值;渲染仍只读 item 上的
  显式字段(§5.3).
- `text_style` 校验口径:`font_size_pt` 是 1..500 的有限数(页面/地图分类同一口径,不允许 `null`);
  `color` `#rrggbb`;`italic` 布尔;`font_weight` 100..900 的整数;`letter_spacing_em` -1..2;
  `line_height` 0.5..5;
  `halo` 为 `null`(= 显式关光晕,与「没有该键」不同)或 `{ "color": "#rrggbb", "width_pt": 0..20 }`
  (对象出现时两个字段都必须给).未知分类/未知字段一律校验失败,与 page 块其它字段同一严格口径.

### 4.1 item 联合类型

三种 `kind`,共字段:`id`(正整数,唯一),`kind`,`space`(`page` = 纸张坐标;`map` = 底图坐标).

**text**

```jsonc
{
  "id": 1,
  "kind": "text",
  "space": "page",
  "role": "title", // title|subtitle|label|annotation|note|source(页面文字角色;样式由分类覆盖决定)
  "x": 420.944882,
  "y": 50, // page: pt;map: 底图坐标(viewBox 坐标)
  "lines": ["伏尔加河流域地形图"], // 1..40 行,每行 ≤200 字符;开启自动折行时是派生量
  "text": null, // 自动折行的原始内容(含手动换行);null = lines 即真值
  "wrap_width_pt": null, // 自动折行宽度(pt);null = 不自动折行(只有页面注记可为数字)
  "font_size_pt": 18,
  "font_family": null, // null = 用 style.font_family
  "color": "#111111",
  "anchor": "middle", // start|middle|end
  "rotation_deg": 0,
  "line_height": 1.35,
  "italic": false,
  "font_weight": 400, // 100..900 的整数;替换旧的 bold:boolean
  "letter_spacing_em": 0, // 字距(em,相对字号),-1..2
  "halo": null, // 或 {"color":"#ffffff","width_pt":2}(先描边后填充;开光晕时默认取 TEXT_HALO)
  "geo_label_id": null, // 地图地名 item = 来源 geo.labels[].id;页面文字恒为 null
  "center_h": false, // 左右居中约束(页面空间可开关;地图地名恒为 false)
}
```

- `geo_label_id`(**必填**):`space=map` 的地名 item 必须是非空字符串,且必须是本次 `geo.labels[].id`
  中存在的 id--它决定该 item 属于哪个地图分类(分类统一字号/样式与聚合都按它归类);
  `space=page` 的文字 item 必须为 `null`.缺字段,指向不存在的 id,page 空间给了非 `null` 值,都算
  page 块校验不合法:打开时告警并回退默认排版(§8.2).
- 页面文字角色 `label`(样式窗口里的显示名「地名(手动)」)属于**页面空间**,是工具栏「文字」手动
  新增的文字;它与来自 `geo.labels[].role` 的「地图标注」分类不在同一层:地图分类只由 Cartopy 的
  `role` 决定,Python/底图侧不画任何文字.
- `center_h`(**必填**布尔值):页面文字的「左右居中」约束.`true` 时水平锚点恒为纸张中心
  `paper.width_pt / 2`(按 3 位小数取整),`anchor` 恒为 `middle`;`y`,旋转,内容不受影响.
  `space=map` 的地图地名必须为 `false`(位置由底图数据决定,纸张变宽不能改变地名在地图上的
  相对位置),`validatePage` 对 map 空间给 `true` 直接判错.`normalizePage` 把缺失/非布尔兜底成
  `false`,随后调用 `enforceHorizontalCenter` 把 `center_h=true` 的 item 拉回纸张中心;打开文件,
  每次排版修改(包括改纸张宽度/方向)后也都会执行同一约束,因此居中项会自动跟随纸张宽度重新
  贴合.拖拽与方向键移动对居中项只改 `y`(水平位移被约束吃掉);在侧栏关掉
  开关后保持当前 `x`/`anchor` 不变.新建文字时 `title`/`subtitle`/`source` 默认开启,其余关闭.
- **注记自动折行**(`text` / `wrap_width_pt`,可选字段,旧 page 块缺省):只有
  `space=page` 且 `role=note` 的文字允许开启;`text` 是不折行的原始内容(手动换行用 `\n`),
  `lines` 是它按 `wrap_width_pt` + 当前字号/字重/字距折出来的结果.派生约束由
  `core/page-layout.ts` 的 `enforceNoteWrap` 统一执行:内容,折行宽度,字号,字重,字距任一
  变化后重算 `lines`;宽度先夹到下限 `PAGE_NOTE_WRAP_MIN_PT=20` 并收敛到 3 位小数再折行,
  保证「导出 -> 重新打开」用同一宽度复现同一批 `lines`(幂等).旧 page 块没有这两个字段时,
  打开流程按「`x` 到右页边距的宽度」补默认宽度,把现有 `lines` 当原始内容,标脏并告警
  「排版中的注记已按折行宽度自动重排(N 条)」;其它角色/地图地名带这两个字段会被校验拒绝.
  `normalizePage` 只做类型兜底(非注记上的字段清成 null),折行必须由带字体测量的
  `enforceNoteWrap` 完成.

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

高度自动派生(公式见 §5.4),不落盘;`width_pt` 由前端创建时按文字测量给出,之后可改.

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

配色/刻度来自 `geo.relief`(vmin/vmax/stops/ticks),不落 `page` 块;`page` 块只存摆放与文字.
`geo.relief` 为 `null` 时不能再添加色标(编辑器提示「该 geo.json 没有 relief 色标数据」),
合成时若 `page.items` 里仍有 colorbar 会抛 `Error('色标需要 geo.relief')`.

## 5. 布局公式(预览与导出共用 `core/page-layout.ts`)

所有几何只在 `core/page-layout.ts` 实现一次:预览(`render/page-svg.ts`)与成品
(`render/compose-svg.ts`)调同一批函数,不得各写一套.所有数值都是 pt(1 用户单位 = 1pt);
写进 SVG 的数值格式由 `render/page-format.ts` 统一(最多 3 位小数,去尾零).

### 5.1 底图坐标 -> 纸张坐标

```
s  = map.width_pt / geo.base.width_pt          // mapTransform().s
tx = map.x - geo.base.view_box[0] * s
ty = map.y - geo.base.view_box[1] * s
page(p) = (tx + p.x * s, ty + p.y * s)
map.height = map.width_pt * geo.base.height_pt / geo.base.width_pt   // mapHeightPt()
```

### 5.2 图框与刻度(`frameTickLayout`)

- 图框 = `rect(map.x, map.y, map.width_pt, map.height)`,`fill=none`,stroke/线宽来自 frame.
- 经度刻度(`side=bottom`):`px = page(tick.x).x`,线从 `(px, map.y+map.height)` 到
  `(px, map.y+map.height+tick_length)`;标签 `text-anchor=middle`,基线
  `y = map.y+map.height+tick_length+tick_gap+tick_font_size`;`top` 侧镜像(线向上,
  基线 `y = map.y-tick_length-tick_gap`).只画 `0 ≤ page(tick.x).x ≤ paper.width` 的刻度.
- 纬度刻度(`side=left`):`py = page(tick.y).y`,线从 `(map.x, py)` 到
  `(map.x-tick_length, py)`;标签 `text-anchor=end`,`x = map.x-tick_length-tick_gap`,
  基线 `py + tick_font_size*0.35`;`right` 侧镜像.只画落在 `0..paper.height` 的刻度.
- 刻度文字取 `geo.graticule.lon/lat[].label`.图框/刻度只在 frame.show/frame.ticks 为 true 时画.

### 5.3 text(`textLayout`)

- 起点 `(px, py)`:page 空间直接用 item.x/item.y;map 空间用 §5.1 变换.
- 第 i 行基线 `y = py + i * font_size_pt * line_height`(i 从 0 起);`text-anchor = anchor`.
- 多行整体绕第一行锚点旋转:`<g transform="rotate(rotation_deg px py)">`,组内逐行 `<text x=px y=py+i*lh>`.
- `halo` 非空:同一文字先画 `stroke=halo.color; stroke-width=halo.width_pt; fill=halo.color;
paint-order=stroke` 的副本,再画正常填充(与 matplotlib 的 paint-order 效果一致).
- 字体:`font-family = item.font_family ?? style.font_family`;`font-size=...px`(用户单位就是 pt).
  `italic` -> `font-style:italic`;`font_weight ≠ 400` -> `font-weight="<数字>"`(不再写 `bold`);
  `letter_spacing_em ≠ 0` 时写 `letter-spacing="<letter_spacing_em × font_size_pt,3 位小数>"`(纸面 pt).
- SVG 文字属性顺序固定(成品字节确定性):`font-family` -> `font-size` -> `font-style`(italic) ->
  `font-weight` -> `letter-spacing` -> `fill` -> 光晕的 `stroke`/`stroke-width`/`paint-order`.
- 文本转义:`& < >`.
- **分类覆盖不改变渲染口径**:渲染只读 item 上的显式样式字段(`font_size_pt`/`color`/`italic`/
  `font_weight`/`letter_spacing_em`/`line_height`/`halo`);`page.text_style` 只是「设置时批量写回
  item」的来源.在「样式设置」窗口改一个分类时,`core/text-style.ts` 按分类口径解析出有效样式,
  逐条写回该分类全部 item(地图 item 若字号/行高变化,按「文字块垂直中心」修正 map 坐标 `y`,
  保住用户手动拖过的位置).字号口径按分类类型区分:
  - 地图分类:item 字号 = 覆盖 `font_size_pt` ?? **分类默认统一字号**(该分类底图字号中位数 ×
    地图缩放比 `s`,夹 4..40 并保留 1 位小数,无地名时 10pt).因此同一地图分类下所有地名
    **字号必须相等**:默认排版,批量应用(哪怕只改颜色),恢复默认,单条 item 切换分类都会写回
    该统一字号.
  - 页面分类:item 字号 = 覆盖 `font_size_pt` ?? 该分类现有 item 的字号 ?? 固定默认字号
    `defaultTextFontSizePt`(标题 18pt / 副标题 9pt / 注记 7.5pt / 来源 7pt,不随纸张缩放).
    改颜色/行高等不含字号的补丁不会顺手改写页面文字字号;item 里已有的字号优先保留
    (`resyncTextStyles` 不会改它,导出 -> 打开幂等);用户显式改字号或恢复默认才写新值.
- **分类样式是唯一真源**:打开带 `page` 块的排版后,会按分类重建每一条 text item 的样式
  (`resyncTextStyles`):颜色/斜体/字重/字距/行高/光晕以分类覆盖为准,地图分类字号强制统一;
  页面分类字号按「覆盖 ?? item 现值 ?? 默认」回退,因此文件里已排好的字号不会被固定默认字号
  改写.逐条值与分类口径不一致时覆盖,标脏并告警(§8.2).
- **渲染不感知 `center_h`**:`textLayout` 只读 item 的 `x`/`anchor`;居中约束由
  `enforceHorizontalCenter` 在打开,每次排版修改与 `normalizePage` 时保证自洽,渲染与合成不需要
  第二套几何(§4.1).

### 5.4 legend(高度派生,`legendLayout`)

```
p  = padding_pt
row_h = max(row_height_pt, font_size_pt * 1.5)
title_h = title ? title_size_pt * 1.4 : 0
height = p*2 + title_h + n*row_h
title 基线 = y + p + title_size_pt
第 i 行中心 = y + p + title_h + row_h*(i+0.5)
swatch: x0 = x+p, x1 = x0+swatch_width_pt(线 / 矩形 / 点都画在 [x0,x1] × 中心线)
label 基线 = 中心 + font_size_pt*0.35,x = x1+swatch_gap_pt,anchor=start
frame.show -> 先画 rect(x,y,width_pt,height)
```

- `line`:`<line x0..x1>`,stroke/width/dash;
- `rect`:`<rect x0..x1,高=font_size*0.9>`,中心对齐;stroke/fill/opacity;
- `point`:在中心点画 marker(star:外接半径 `font_size*0.55` 的五角星;square:边长
  `font_size*0.7`;circle:半径 `font_size*0.35`),fill/stroke 取条目.

### 5.5 colorbar(`colorbarLayout` / `colorbarTitleText`)

```
bar = rect(item.x, item.y, width_pt, height_pt)
vmin/vmax/stops/ticks 来自 geo.relief
线性渐变(def id = "mapdoc-cbar-<item.id>"):y1=100% y2=0%(下 = vmin,上 = vmax),
stops 用 offset/color 原样
title(show_title):基线 y-4,anchor=middle,x = item.x+width_pt/2
每个 tick v:ty = y + height*(1-(v-vmin)/(vmax-vmin));右侧短线 x+width..x+width+3;
标签 x+width+5,anchor=start,基线 ty + label_size*0.35
单位:title 后接 " (unit)"(unit 非空且标题不含单位时)
```

### 5.6 默认排版(`defaultPageLayout(geo, options)`)

- 纸张默认 A4 横向;排版随纸张自适应:`k = clamp(min(长边/841.89, 短边/595.28), 0.62, 1.6)`
  缩放图例/色标尺寸与版式间距;**页面文字字号固定**(`PAGE_TITLE_SIZE_PT=18` /
  `PAGE_SUBTITLE_SIZE_PT=9` / `PAGE_NOTE_SIZE_PT=7.5` / `PAGE_SOURCE_SIZE_PT=7`,不随纸张缩放);
  **横向**纸用「左地图 + 右栏」,**纵向**纸(`h > w*1.05`)用「地图满内容宽 + 下方一排图例/注记/
  色标」,并让开地图底部的经度刻度标签.
- **页边距固定为内部常量**:`PAGE_DEFAULT_MARGIN_PT = 28` 只在 `defaultPageLayout` 生成初始
  排版时作为纸面内边距使用,不作为任何设置项暴露,也不写进 `page` 块;已放置元素只由各自 x/y
  决定位置,不受页边距约束,改纸张尺寸后位置不变.
- 地名标注(`geo.labels`)按 map 空间铺上,**同分类统一字号**(见下条):颜色/斜体按 `role` 查
  `config/text-style.ts` 的角色表,字重/字距/行高/描边取 `MAP_LABEL_STYLE`;`label.y` 是文字块
  垂直中心,按 `baseline_ratio` 换算回第一行基线后加回(见契约 §4),旋转默认 0.标题/副标题/
  注记/来源来自 `geo.suggestions`.
- **分类样式覆盖参与默认排版**:`defaultPageLayout` 仍接受 `options.text_style` 覆盖表,返回值的
  `text_style` 是它的深拷贝(缺省 `{}`);打开时的初始排版没有已有覆盖,传入缺省 `{}`.标题/副标题/
  注记/来源:字号 = 覆盖 `font_size_pt` ?? **固定默认字号**(`PAGE_TITLE_SIZE_PT=18` /
  `PAGE_SUBTITLE_SIZE_PT=9` / `PAGE_NOTE_SIZE_PT=7.5` / `PAGE_SOURCE_SIZE_PT=7`,不乘 `k`);
  颜色/斜体/字重/字距/行高/光晕 = 覆盖 ?? `PAGE_TEXT_STYLES[role]`(注记/来源无颜色覆盖时仍沿用
  `style.color`);注记/来源的折行测量与块高必须用**解析后的**字号/字重/行高,否则覆盖后文字会
  溢出或压到下一块.注记同时把原始文案(手动换行保留)与**折行宽度**(横向右栏宽 / 纵向一排的
  注记列宽,取 3 位小数)写进 item 的 `text` / `wrap_width_pt`,之后改内容/字号/字距/宽度由
  `enforceNoteWrap` 用同一口径重算,不再需要重新生成排版;来源只在这里折一次(不自动换行).
  地名:按 `label.role` 解析覆盖(颜色/斜体/字重/字距/行高/光晕),字号 = 覆盖
  `font_size_pt` ?? **分类默认统一字号**(该分类底图字号中位数 × `s`,夹 4..40 并保留 1 位小数;
  分类没有地名时回退 10pt),同一分类全部地名同字号;`geo_label_id = label.id`.默认排版只用于
  打开时的初始生成;之后改纸张尺寸/方向不会重新生成版式,既有 item 的字号保持不变(§5.3).
- **可选块降级**(无后端后新增):`hasLegend = geo.legend.entries.length > 0`,
  `hasNotes = suggestions.notes 有非空行`,`hasColorbar = geo.relief !== null`.
  - `hasLegend` 为假 -> 不生成 legend item,也不留空图例框;
  - `hasColorbar` 为假 -> 不生成 colorbar item;
  - `title`/`subtitle`/`source` 只在 `suggestions` 对应字段非空时生成;`notes` 折行后为空也不生成;
  - 右栏(横向)/下方一排(纵向)只在 `hasLegend || hasNotes || hasColorbar` 时存在:
    **有图例**时右栏沿用图例列宽(横向 150..260pt 按文字测量夹取;纵向随 k 收缩),既有布局/数值
    不变(回归 demo);**无图例但有注记/色标**时横向右栏改用窄列 `0.7 × 150pt × k`(A4 横向约
    105pt,只容纳折行注记与色标),地图相应加宽;纵向注记从左边距开始,色标仍贴右,空块不占列;
    三块都没有时整栏/整排不存在,地图用满内容宽.
- **标题/副标题/来源默认左右居中**:`center_h = true`,`x = paper.width_pt / 2`,`anchor = middle`
  (派生 x 按 page 的 3 位小数口径写,保证与 `enforceHorizontalCenter`/`normalizePage` 自洽);
  注记(默认排版里唯一的自由摆放页面文字)与全部地图地名 `center_h = false`;标注/手动地名不在默认
  排版里,由用户新增时按角色决定(默认关闭).纸张宽度/方向改变后由编辑器重新贴合,不需要重排.
- 返回完整合法的 `PageLayout`(`seq` > 所有 item id),由调用方标记为「未导出」.

### 5.7 item 几何框(选中框 / 命中盒,`itemBoundsPt`)

预览里的**选中框**与**点击命中盒**必须是同一个可核对的几何量,不允许手写虚框,也不允许从
DOM `getBBox()` 外扩:`getBBox()` 不含元素自身的 transform(旋转文字会画在锚点附近而错位),
且会把透明命中盒一起算进包围盒,使框变成没有依据的外扩装饰.

`itemBoundsPt(item, layout, geo, measure)` 从 `page` 块 + 本节 §5 公式推出纸张坐标里的
**未旋转声明框**(预览,导出,命中判定共用同一批函数):

```
text:    水平 = 锚点 anchor + 各行前进宽度(measureText;CSS font 带 font_size_pt/font-family/字重;
               字距按 letter_spacing_em × font_size_pt × max(0, 字符数-1) 叠加)
         垂直 = 首行基线 − ascent − halfLeading .. 末行基线 + descent + halfLeading
                halfLeading = max(0, (font_size_pt × line_height − (ascent + descent)) / 2)
                ascent/descent 是 CSS font 的字体行盒:浏览器取 canvas
                fontBoundingBoxAscent/Descent;无 canvas(node 单测)按 0.8em/0.2em 回退
                (config PAGE_TEXT_FALLBACK_ASCENT_RATIO / DESCENT_RATIO)
                单行文字也随 line_height 变高:多行由 step = font_size_pt × line_height 展开行距,
                半行距把额外空间均分到首行上方与末行下方;行高小于字体行盒时 halfLeading = 0
         旋转 = §5.3 的 rotate(rotation_deg px py),pivot = 首行锚点 (px, py)
legend:  rect(x, y, width_pt × s, legendLayout().height)          // §5.4
colorbar:rect(x, y, width_pt × s, height_pt × s)                  // §5.5
```

- 图例/色标的 `s` = map 空间缩放比(§5.1);page 空间 `s = 1`.text 在 map 空间只换坐标
  (§5.1),字号与前进宽度**不**乘 `s`(§5.3).
- text 的垂直声明框按**行盒**计算:单行文字改大 `line_height` 时选中框随之变高,而不是只包住
  字体 ascent/descent;多行仍以 `step` 展开.
- **命中盒** = 声明框四周加 `PAGE_HIT_TOLERANCE_PT`(指针精度容差,只决定点击范围);
  **选中框** = 声明框原样,虚线/颜色/线宽只写在 `styles-page.css` 的 `.page-selection-box`.
- 两者都只在预览层出现,不进入成品;旋转 item 的框按同一 `rotate` 变换绘制,因此始终贴住
  文字块.

## 6. 最终 SVG(`render/compose-svg.ts` 输出)

```
<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="{paper.width}pt" height="{paper.height}pt"
     viewBox="0 0 {paper.width} {paper.height}" version="1.1">
<rect x="0" y="0" width="{paper.width}" height="{paper.height}" fill="{paper_color}"/>
<metadata id="mapdoc-source"><base64(canonicalJson({format,version,document,base}))></metadata>
<defs>
<clipPath id="mapdoc-map-clip"><rect x="{vb[0]}" y="{vb[1]}" width="{vb[2]}" height="{vb[3]}"/></clipPath>
[<linearGradient id="mapdoc-cbar-{id}" ...>...stops...</linearGradient>]   # 仅当 page 块有 colorbar
</defs>
<g id="mapdoc-map" clip-path="url(#mapdoc-map-clip)" transform="translate({tx},{ty}) scale({s})">BASE_INNER</g>
<g id="mapdoc-frame"> rect + ticks + tick texts </g>
<g id="mapdoc-overlay"> items 按数组序 </g>
<!-- mapdoc-final:<base64(JSON)> -->\n
</svg>\n
```

- `BASE_INNER` = 上传底图根 `<svg>` 起始标签之后,最后一个 `</svg>` 之前的全部原文
  (`BaseSvgInfo.inner`,含 `<defs>`/`<metadata>`/`<style>`/图形),**原样拼接**,不重序列化.
- `<g id="mapdoc-map">` 带 `clip-path="url(#mapdoc-map-clip)"`,clip 矩形用底图局部坐标
  `geo.base.view_box`(map group 的 transform 已把底图坐标映射到纸面,局部坐标系里地图框就是
  viewBox).**为什么必须裁剪**:预览把底图当 `<image>` 放在 map 矩形里,天然被矩形裁掉;而
  Cartopy/matplotlib 底图根内自带覆盖整个原始 Figure 的图幅白底(`<g id="patch_1">` 的白色 path,
  范围大于地图框),成品若不裁剪,它会在非白纸色(`page.style.paper_color`)下铺满整页,
  与预览不一致.裁剪后成品与预览的可见范围一致,底图局部越界内容(图幅白底等)不会外溢.
- 成品**不引用外部底图资源**(没有指向 `base.svg` 的 `<image href>`);但底图内部自带的内联
  `<image>`(例如 Cartopy 的晕渲位图 base64)属于底图内容,会随 `BASE_INNER` 原样进入成品,这是允许的.
- `<metadata id="mapdoc-source">` 是**可再编辑源**(§6.2):整份导出 geo.json 的原文 + 底图
  `prefix`/`suffix`.它不参与渲染,外部工具可能保留或丢弃;丢掉了只影响「单文件再编辑」,不影响
  成品显示.位置固定在纸张底色之后,`<defs>` 之前(便于按行定位,也让 §6 的图层顺序保持稳定).
- 底图自带全局 CSS(如 `*{stroke-linejoin:round;stroke-linecap:butt}`)会作用于整份成品,接受.
- 图层 id 前缀 `mapdoc-`;底图与排版层 id 不得冲突.
- 字体**不内嵌**(v2 已知限制):文字用 `font-family` 引用本机字体;换机器可能换字形,
  需要印刷时在 Inkscape/AI 里转曲.合成接口已留好以后加字体载荷(`<defs><style>@font-face...`)的位置.
- 文件末尾恰好一个换行.**确定性口径**:同一浏览器实现,同一 `(base.inner, base sha256, geo, page)`
  输入两次得到相同字节;不读 DOM/时间/随机数.不同浏览器/不同版本的浮点与序列化实现可能不同,
  「同字节」只在同一浏览器实现下承诺(不跨实现).
- `report`(返回值里同时给出):`counts` 四类计数(0 也出现),`warnings`(越界元素 + 地图超出纸张
  的中文告警),`out_of_paper`(越界 item id,按 items 序).越界容差 1e-6.

### 6.1 marker

`<!-- mapdoc-final:<base64> -->`,base64 内容为 `canonicalJson(payload)`(键排序,无空白,数字 3 位小数):

```ts
/** 成品尾部 marker 的 JSON(UTF-8 后标准 base64,带 padding) */
interface FinalMarkerPayload {
  counts: { colorbar: number; legend: number; text: number; total: number };
  /** geoDigest(geo) = sha256Hex(canonicalJson(geo)) */
  geo: string;
  /** pageDigest(layout) = sha256Hex(canonicalJson(normalizePage(layout))) */
  page: string;
  version: 2;
}
```

实现见 `render/compose-svg.ts` 的 `makeMarker` 与 `core/page.ts` 的 `canonicalJson` / `geoDigest` /
`pageDigest`.marker 从 v2 起把排版摘要的键名改为 `page`(旧 `scene` 键已删除).`marker.page`
**只按当前 `pageDigest` 对照**:

自 2026-10-29 起 marker **会被读取**(`core/final-svg.ts` 的 `readFinalSvg`):

- 单文件打开(成品 SVG 自带内嵌源):marker 摘要与内嵌 geo/page 不一致只**告警**(内嵌源才是可编辑
  真值;外部工具改过成品时仍允许打开,用户重新导出即可刷新 marker);marker 缺失也只告警.
- 「成品 SVG + 所选带 `page` 的 geo.json」:marker 摘要与所选 geo 不一致**直接拒绝**(多半是拿错了
  配套 JSON,继续打开会得到底图/排版互相错位的假文档);marker 缺失时无法配对校验,只告警.
- `mapdoc-final` / `mapdoc-overlay` 仍被 §7 的 C4 拒绝:它们不能被当成 Cartopy 底图内联.

### 6.2 内嵌可编辑源(成品 SVG 再编辑)

`<metadata id="mapdoc-source">` 的文本是标准 base64(UTF-8,带 padding),解码后为 `canonicalJson`:

```ts
interface FinalSourcePayload {
  format: 'mapdoc-final-source';
  version: 1;
  /** 导出时 serializeMapDocFile(geo, layout) 的原文:geo 全部字段 + page 块 */
  document: string;
  base: {
    /** 底图原文中 inner 之前/之后的字节(XML 声明 + 根起始标签 / </svg> 及收尾) */
    prefix: string;
    suffix: string;
    /** prefix+inner+suffix 还原出的底图字节 sha256(必须等于 geo.base.sha256) */
    sha256: string;
    /** 来源标志:恒为 true;非 true 的旧版成品不再支持打开 */
    exact: boolean;
  };
}
```

- 为什么这样拆:`BASE_INNER` 已原样内联在 `<g id="mapdoc-map">` 里,再存整份 10 MB 底图会让成品
  体积翻倍;只补 `prefix + inner + suffix` 就能逐字节还原底图,`geo.base.sha256` 因此仍然成立.
- 为什么还要 `base.sha256`:内嵌源里的底图前后缀必须能**逐字节还原**出导出时的底图字节,且
  sha256 必须等于 `geo.base.sha256`(证明内嵌 geo 与内联底图来自同一次导出).打开时逐字节校验,
  不成立即拒绝;没有跳过 sha256 校验的分支.
- 打开口径(`core/open-map.ts` 的 `openFromFinalOnly`):
  1. 读内嵌 `document` -> JSON.parse -> `format=mapdoc-geo` / `validateGeo` / `normalizeGeo`;
  2. 用 `mapdoc-map` 组内容 + 内嵌前缀/后缀还原底图原文 -> `readBaseSvg`(C1–C4)-> sha256 必须等于
     `geo.base.sha256`,不成立即拒绝;
  3. `page` 块按 §8.2 恢复排版(缺省/不合法 -> 默认排版;恢复后按分类重算逐条样式);
  4. marker 对照只告警(见 §6.1);
  5. 文件名沿用该成品 SVG 的 stem.
- **字节幂等**:成品 -> 重新打开 -> 再导出,得到的成品 SVG 与第一次逐字节相同(同一浏览器实现;
  内嵌源,marker 摘要,渲染内容都由同一套纯函数重建,见 `tests/core/open-map.test.ts`).
- 没有内嵌可编辑源的旧版成品:**不再支持打开**(§8.1);请用 Cartopy 的 `base.svg + geo.json`
  重新导入排版后,由本编辑器重新导出带内嵌源的成品.

## 7. 底图契约(`src/core/base-svg.ts`)

`readBaseSvg(text) -> BaseSvgInfo`,检查全部是字符串级扫描(不解析整棵 XML,10 MB 底图也很快):

```ts
interface BaseSvgInfo {
  readonly view_box: readonly [number, number, number, number] | null; // C1 失败为 null
  readonly width_pt: number; // 取 viewBox 第三项;C1 失败为 0
  readonly height_pt: number; // 取 viewBox 第四项;C1 失败为 0
  readonly inner: string; // 根起始标签之后,最后一个 </svg> 之前;C1 失败为 ''
  readonly prefix: string; // inner 之前(XML 声明 + 根起始标签);C1 失败为 ''
  readonly suffix: string; // inner 之后(</svg> 及收尾);C1 失败或 C3 失败为 ''
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}
```

- **C1**:有根 `<svg`,且 `viewBox="x y w h"` 合法,`w/h > 0`.
- **C2**:不含 `<text`(纯地图;注释/标题/刻度文字都不允许).
- **C3**:`</svg>` 恰好 1 次且位于文件末尾(之后允许空 / 一个 `\n` / `\r\n`).
- **C4**:不含 `mapdoc-overlay` / `mapdoc-final` 痕迹(防止把已经合成过的成品再当底图内联).
- `warnings`:根标签 `width`/`height` 与 viewBox 的 `w/h` 不一致(只告警,不拒绝).
- 打开流程另有约束:文件名 `.svg`;字节必须能**严格**按 UTF-8 解码(坏字节直接拒绝,因为有损文本
  会让 sha256 与切片都不可信);`errors` 非空即拒绝打开.
- `errors` 为空时 `base.inner` 就是 §6 成品内联的唯一来源;C1 失败时 `inner=''`,避免对半坏文件做拼接.
  `prefix + inner + suffix` 首尾相接等于完整底图原文(§6.2 逐字节还原用).
- 本契约由 Cartopy 侧直接产出保证;本仓不再有 Python 版 `contract.py`/`check_contract.py`(已随
  `tools/` 删除).

## 8. 文件 I/O 契约(取代旧 HTTP 端点)

地图页是纯静态前端,**没有任何 HTTP 接口**:没有 `/api/doc|geo|scene|compose|health`,没有
`/base.svg|/final.svg|/geo.json` 代理,也没有随 dev server 启动的 Python 进程.数据进出只有
「浏览器上传文件」与「浏览器下载文件」.

### 8.1 上传

上传由 `core/open-map.ts` 分派,按**内容**(不是文件名)落到两条路径:

| 路径 | 输入                                  | 何时使用                                    | 底图身份                                  |
| ---- | ------------------------------------- | ------------------------------------------- | ----------------------------------------- |
| 1    | `<stem>.svg`(底图)+ `<stem>.geo.json` | Cartopy 直出的两份源文件                    | sha256 / viewBox / 尺寸全校验             |
| 2    | 一份本编辑器导出的 `<stem>.svg`       | 成品必须内嵌可编辑源(§6.2),单文件即可再编辑 | 前缀+inner+后缀逐字节还原,sha256 必须成立 |

- 选择框:**SVG 与 JSON 分成两个独立选择框**(`ui/page-open.ts` 的两个选择栏)--SVG 栏
  `<input accept=".svg,image/svg+xml">`(单选),JSON 栏 `<input accept=".json,application/json">`
  (`multiple: false`,只收一个 geo.json;一次给出多个 JSON 时报「只能选择一个 geo.json」).
  - **只选一份 SVG 也能点「打开地图」**(JSON 栏可选):成品 SVG 单文件即可打开;如果选的是普通
    底图却缺 geo.json,core 给出「缺少 geo.json:请把与底图配套的 geo.json 一起上传;也可以只上传
    一份本编辑器导出的成品 SVG」.
  - 成品**自带内嵌源**时再选 geo.json:内嵌排版优先,JSON 只做交叉校验--带 `page` 且与 marker
    不一致就拒绝(marker 只按当前 `pageDigest` 对照,见 §6.1);没有 `page`(Cartopy 原始 geo)
    只校验 geo 摘要并用内嵌排版(告警提示).
  - **旧版成品(没有内嵌可编辑源)直接拒绝打开**:不再支持「成品 SVG + 配套 geo.json」的迁移路径,
    提示用 Cartopy 的 `base.svg + geo.json` 重新导入排版后,由本编辑器重新导出带内嵌源的成品.
  - SVG 栏与 JSON 栏各自独立替换:换底图不影响已选 JSON,换 JSON 也不影响已选底图;
  - 也支持把文件拖到页面任意位置:按扩展名自动落进对应栏,一次拖入两份会同时填好两栏;
    只拖一种时另一栏保持原值.
- 扩展名只用于快速分桶与分栏,**内容才是真值**(改错扩展名不会误判):
  `.svg` 里是 Cartopy 底图还是成品,`.json` 顶层 `format`/`version` 都按内容判断;
  没有 `.svg`/`.json` 之外的文件时报「不识别的文件」.
- 缺少或重复的 SVG / 多于一个 geo,JSON 顶层 `format` 不是 `mapdoc-geo`(或 `version` 不是 2,
  其中 `version: 1` 属旧契约,提示重新生成):都在打开阶段拒绝并给出中文原因,不改变当前已打开的
  文档.旧 `mapdoc-page`(`scene.json`)不再
  支持,错误文案是「是旧版 scene.json:排版已并入 geo.json,请改用 Cartopy 产出的 geo.json(或本编辑器导出的 geo.json)」.

### 8.2 打开校验(任一失败 -> 面板显示原因,不崩,不离开页面)

0. 文件读取:`app/page-main.ts` 只把 `File` 读成字节;分栏与解码都在 `core/open-map.ts`--
   先按扩展名分桶(不识别文件先被拒),再只对入选的 SVG/JSON 严格 UTF-8 解码
   (`fatal: true`,**保留 BOM**;JSON 在 parse 前单独去 BOM,避免带 BOM 的底图重编码后 sha 漂移).
1. 底图 / 成品识别:先按路径 1 试 `readBaseSvg`;C1–C4 全过即「底图 + geo」.
   否则 `readFinalSvg` 判断是否成品(`mapdoc-map` / `mapdoc-overlay` / `mapdoc-final` / 内嵌 metadata 任一
   命中);带内嵌可编辑源 -> 路径 2(有 JSON 时只做交叉校验);**没有内嵌源 -> 直接拒绝**(旧版成品
   不再支持,提示重新导入 `base.svg + geo.json` 后重新导出);都不是才报「底图不符合契约」.
2. geo:JSON 可解析;顶层 `format=mapdoc-geo`,`version=2`;`validateGeo` 无错误.
3. 一致性:`createPageDocument(baseFileName, baseText, geo)` 统一校验--底图字节 sha256 ==
   `geo.base.sha256`;`geo.base.view_box/width_pt/height_pt` 与底图根标签的 viewBox/width/height 一致,
   容差 0.01pt(`PAGE_BASE_SIZE_TOLERANCE_PT`).不一致直接报错,提示「请用 Cartopy 重新生成配套的
   base.svg + geo.json」.没有跳过 sha256 / 合成底图外壳的分支.
4. 成品路径额外校验(§6.2):
   - 内嵌 `document` 必须可解码/校验;还原底图 sha256 必须与内嵌 geo 的 `geo.base.sha256` 一致,
     否则拒绝.
   - marker 摘要与内嵌 geo/page 不一致只告警;若用户同时选了带 `page` 的 geo.json,marker 摘要与
     所选 geo 不一致**直接拒绝**;marker 缺失只告警.
   - `marker.page` **只按当前 `pageDigest` 对照**(没有旧口径回退).
5. `page` 块(可选):`page` 键存在 -> `validatePage(raw, geo)`;通过则 `normalizePage` 作当前排版;
   不合法(例如 map 空间 text item 缺 `geo_label_id`/id 不在 `geo.labels` 里,page 空间 item 的
   `geo_label_id` 不是 `null`,`center_h` 缺失/非布尔,map 空间的 `center_h` 为 `true`)-> 告警并改用
   `defaultPageLayout`;缺省 -> `defaultPageLayout`(后两者都标脏).**排版确定后统一按分类重建每条
   文字样式**(`core/text-style.ts` 的 `resyncTextStyles`):
   - 颜色/斜体/字重/字距/行高/光晕以分类覆盖为准;地图分类字号强制统一(覆盖 ?? 中位数 × `s`),
     页面分类字号按「覆盖 ?? 该分类现有 item 的字号 ?? 固定默认字号」回退--页面默认字号固定,
     不随纸张缩放;item 里已有的字号优先保留,重建不会误改;
   - 若文件里存的逐条样式与上述口径不一致:覆盖并标脏,并告警「旧排版中的逐条文字样式已按分类
     设置统一(N 条),导出后会写成新口径」;
   - 默认排版本身与分类口径一致,重建通常不产生改动.
     随后执行一次 `enforceHorizontalCenter`(§4.1):手改过的 `center_h=true` item 的 `x`/`anchor`
     被纠回纸张中心;有改动则标脏并追加独立告警「排版中的左右居中约束已按纸张宽度重新贴合(N 条),
     导出后会写成新口径」(与样式重建分开,用户能分清是哪一步改了排版).最后统一 `normalizePage`,
     数值口径与导出/签名完全一致.底图身份只在 `geo.base`,不再有「排版记录的底图与本次上传不一致」
     的分支.
6. 打开后状态:带合法 `page` 块 -> 干净(路径 1「已载入 geo.json 中的排版...」;路径 2
   「已从成品 SVG 恢复排版;Ctrl+S 导出 geo.json」);样式被分类设置重算过或居中约束被纠偏过 -> 脏;
   否则默认排版 -> 脏(「已生成初始排版...」).

错误语义汇总(文案以 `core/open-map.ts` / `app/page-main.ts` 为准):没有收到文件 / 不识别的文件 /
缺少或重复的 SVG / 多于一个 geo / 文件不是 UTF-8 / 不是合法 JSON / `format` 不是 `mapdoc-geo` 或
`version` 不是 2(旧 v1 geo / 旧 `scene.json` 走这条)/ 底图不符合契约(列出前几条 C1–C4)/ geo 校验失败
(列出前几条)/ sha256 不一致 / viewBox 不一致 / 尺寸不一致 / 成品缺少内嵌可编辑源(旧版成品不再支持,
提示重新导入导出)/ 成品内嵌源不可用 / 成品与所选 geo 不配套(marker 摘要不一致)/ page 块不合法
(含缺 `geo_label_id`,缺 `center_h` 或 map 空间 `center_h=true`,改用默认排版并告警).

### 8.3 导出

| 命令                              | 产物                       | 文件名                 | MIME               |
| --------------------------------- | -------------------------- | ---------------------- | ------------------ |
| 工具条「导出 geo.json」/ `Ctrl+S` | geo 全字段 + `page` 排版块 | `<底图 stem>.geo.json` | `application/json` |
| 工具条「导出 SVG」                | 浏览器内合成的成品         | `<底图 stem>.svg`      | `image/svg+xml`    |

- 保存都经 `ui/download.ts`:支持 File System Access API 的浏览器(Chromium 系且页面在安全上下文
  HTTPS / localhost)先弹系统保存对话框,由用户选路径与文件名(默认名仍是 `<底图 stem>` 派生的
  文件名);API 不可用,被权限策略拦住或写入选定路径失败时,退回 `Blob` + `<a download>` 默认下载,
  objectURL 延迟 revoke(`PAGE_DOWNLOAD_REVOKE_MS`).用户在保存对话框取消 -> 提示「已取消导出」,
  **不清脏标记,不提示成功**;写入失败退回下载时按已导出处理(内容已交给浏览器).
- **导出 geo.json**:`serializeMapDocFile(geo, layout)`(`page` 数字 3 位小数,`geo` 数字保持 Cartopy
  原样精度,键排序,2 空格缩进,末尾一个换行)-> 保存;成功即清脏标记.`page` 块走 `normalizePage`,
  会再执行一次左右居中约束并把 `center_h` 随 `items[]` 一起落盘.geo.json 是排版唯一的持久化
  形态,用导出的文件重新打开即恢复排版.
- **导出幂等**:导出 -> 重新打开 -> 再导出,字节完全一致(同一浏览器实现).
- **导出 SVG**:`composeFinalSvg(document, layout)` -> 保存;展示 `report.warnings`;**不清脏标记**
  (导出 SVG 不改变排版数据,是否干净以导出 geo.json 为准).取消保存时不展示合成告警.
  `geo.relief` 为 `null` 而 `page.items` 里仍有 colorbar 时导出失败并提示「色标需要 geo.relief」,
  不写半成品文件.
- `打开...`:有未导出的修改时先确认(`notifier.ask`),确认后销毁编辑器,revoke 预览 objectURL,
  回到上传面板;`beforeunload` 在脏状态下提醒.
- 没有「保存中」状态,没有 409/400/503 响应处理:所有失败都是本地异常 + 中文提示.

### 8.4 端口与静态部署

- 开发端口唯一真值是 `vite.config.ts` 的 `SITE_PORT = 5173`(`strictPort`,被占直接报错),
  不再有 `tools/studio.toml` 之类的第二份真值.
- `npm run build` 产出 `dist/`(两个 HTML 入口,`base: './'`),任意静态服务器可托管;
  不需要 Python/Node 服务.浏览器直接 `file://` 打开 `dist/map.html` 可能受模块脚本/Blob 限制,
  请用静态服务器(如 `npm run preview`).

## 9. 前端(`map.html`)

**文件布局(遵守 `npm run arch` 的五层:`app -> ui/render/core/config`)**

```
map.html                        # 入口:<script type="module" src="/src/app/page-main.ts">
src/app/page-main.ts            # 组合根:建外壳 -> 上传面板 -> File 严格 UTF-8 解码 ->
                                #   core/open-map 打开 -> 建 sidebar/editor -> 建样式设置窗口 ->
                                #   toolbar -> start;换文档时先销毁窗口;「打开...」重开与拖拽兜底
src/app/page-editor.ts          # 状态机:选择/拖拽/缩放/平移/脏标记;分类样式补丁
                                #   applyTextStyleChange / resetTextStyleChange / resetTextStyleFieldChange;
                                #   每次排版修改后执行 enforceHorizontalCenter;
                                #   exportGeo()/exportFinal()/destroy()
src/config/page.ts              # 格式标识,上传 accept,校验容差,纸张预设,默认排版参数,
                                #   页面文字固定默认字号,默认排版内部页边距常量,纸张比例系数 layoutScaleForPaper,
                                #   上限,交互系数
src/config/text-style.ts        # 文字样式常量与分类元信息(role 颜色表,页面文字默认字号,
                                #   20 个分类 = 6 页面文字 + 14 地图地名 与两组顺序;样式唯一真源;
                                #   分类描述 description / 示例 example / 语义小标题 section)
src/core/base-svg.ts            # 底图契约 C1–C4 + 根标签内原文切片 inner/prefix/suffix(纯逻辑)
src/core/open-map.ts            # 两条打开路径:分栏 -> 校验 -> PageDocument + 初始排版(纯逻辑);
                                #   打开时按分类重建文字样式(resyncTextStyles)并贴合居中约束;
                                #   旧版成品(无内嵌可编辑源)直接拒绝
src/core/final-svg.ts           # 成品 SVG 再编辑:内嵌源读取,mapdoc-map 定位,底图逐字节还原(纯逻辑)
src/core/base64.ts              # 内嵌源 / marker 的 UTF-8 base64 编解码(纯逻辑)
src/core/document.ts            # PageDocument,createPageDocument,上传文件分类,导出文件名(纯逻辑)
src/core/page.ts                # geo/page 类型,normalize/validate,text item 的 center_h 与
                                #   enforceHorizontalCenter,canonicalJson,sha256OfBytes,
                                #   serializeMapDocFile,geoDigest/pageDigest(纯逻辑,node 可测)
src/core/page-layout.ts         # §5 全部布局公式 + defaultPageLayout(可选块降级,按 text_style 出样式,
                                #   地图分类统一字号,title/subtitle/source 默认居中)
src/core/text-style.ts          # 分类文字样式:item->分类,分类有效样式与默认统一字号解析,
                                #   覆盖表批量写回 item,整分类/单字段恢复默认,打开时按分类重建逐条样式(resyncTextStyles)
src/render/page-svg.ts          # 预览 SVG DOM(纸张/底图 image/图框刻度/items)
src/render/compose-svg.ts       # 浏览器内合成 final.svg(纯函数:结构/marker/内嵌源/report)
src/render/page-format.ts       # 数字格式化,颜色/转义,SVG 属性 helper
src/ui/page-open.ts             # 上传面板(SVG / JSON 两栏各自选择 + 打开按钮 + 错误文案)
src/ui/page-sidebar.ts          # 右侧属性面板编排:面板壳 / sync / 元素列表 / 选中项重建
src/ui/page-sidebar-context.ts  # 面板模块与侧栏状态的唯一契约(PageSidebarHandlers / SidebarContext)
src/ui/page-sidebar-controls.ts # 控件登记表(数字/颜色/文本/开关/分段 + 未聚焦控件回写)
src/ui/page-panel-paper.ts      # 「页面」面板:纸张预设/方向/宽高 + 落盘说明(改纸张不移动已放置元素)
src/ui/page-panel-map.ts        # 「地图」面板:摆放/派生高度/图框/刻度样式
src/ui/page-fields-common.ts    # 元素公共字段:坐标空间 + x/y + 页面文字「左右居中」开关(x/y 正下方;
                                #   开启时 x 冻结并置灰)
src/ui/page-fields-text.ts      # 文字字段:内容/角色(仅页面文字)/对齐/旋转 + 「打开样式设置」入口
                                #   (带当前分类);地图地名 item 显示指向地图分类的只读样式说明;
                                #   左右居中开启时对齐分段禁用
src/ui/page-fields-legend.ts    # 图例字段 + 条目增删/显隐(隐藏 = 移出 layout,会话内记住)
src/ui/page-fields-colorbar.ts  # 色标字段:标题/单位/宽高/字号/显示开关
src/ui/page-toolbar.ts          # 顶部工具条(文件/添加/样式/视图四组;「样式设置」按钮)
src/ui/page-style-window.ts     # 「样式设置」模态窗口:头部总说明 + 左列两组分类(语义小标题/数量徽标/
                                #   已改标记/地图 0 项置灰)+ 右列分类头(影响数量/默认·已改·排版值/
                                #   示例/恢复默认(有覆盖或排版值时可用)/实时预览)+ 四组字段
                                #   (字号/颜色与字形/行距与字距/描边光晕);字号/行高/字距/光晕宽度旁
                                #   各有字段级 reset(删该字段覆盖回默认,已是默认时禁用)
src/ui/page-notify.ts           # 消息区(miko_ui MessageArea + 简单确认框)
src/ui/download.ts              # downloadText(保存对话框优先,<a download> 回退)/ downloadSvg
src/styles-page.css             # 本页样式(.page-*;token 复用 miko_ui/styles.css 与 styles.css)
tests/core/page.test.ts         # codec/校验/布局公式,center_h 与 enforceHorizontalCenter
tests/core/text-style.test.ts   # 分类映射,覆盖解析,批量应用/恢复默认,resyncTextStyles
tests/core/base-svg.test.ts     # 底图 C1–C4 与 inner/prefix/suffix 切片
tests/core/base64.test.ts       # UTF-8 base64 往返与坏数据
tests/core/final-svg.test.ts    # 内嵌源读取,底图逐字节还原
tests/core/open-map.test.ts     # 两条打开路径,成品往返字节幂等,旧版成品拒绝,居中纠偏告警,错误文案
tests/core/page-geo.test.ts     # normalizeGeo / digest / serializeMapDocFile
tests/render/compose-svg.test.ts # 合成结构,marker,内嵌源,确定性,越界 report
```

`core`/`render` 不碰 DOM;`ui` 只用 miko_ui 与标准 DOM;组合与事件只在 `app`.新文件都按仓库
中文注释三分类(是什么/为什么/元信息)写注释.

**交互(基础可用即可,不做撤销/多文档)**

- **打开**:初始显示上传面板;在 SVG 栏与 JSON 栏里分别选/拖 `base.svg`,`geo.json`(JSON 可省略),
  或只选一份本编辑器导出的成品 SVG,点「打开地图」-> §8.2 校验 -> 生成 `PageDocument` -> 装配界面.
  带合法 `page` 块(或成品内嵌源)则恢复排版,并按分类重建每条文字样式,贴合左右居中约束,
  再执行一次注记自动折行(旧排版缺 `text`/`wrap_width_pt` 时补齐并告警,§4.1)
  (颜色等与分类不一致会覆盖;页面分类字号保留排版里的现值;有改动则标脏,告警);否则用
  `defaultPageLayout` 生成初始排版(标脏).没有内嵌可编辑源的旧版成品直接拒绝.
- **画布**:一个 SVG(viewBox 随缩放/平移变化).纸张白底 + 底图 `<image href=objectURL>`
  (放在 map 矩形)+ 图框/刻度 + items.滚轮以指针为中心缩放,空格/中键拖动平移,
  「适应页面」/「1:1」按钮.
- **选择与编辑**:点 item 选中(选中框 = §5.7 的声明几何框,随 `rotation_deg` 旋转;外观在
  `styles-page.css`);拖拽移动(map 空间 item 写回底图坐标,page 空间写回 pt);
  方向键 1pt 微移(Shift 10pt);Delete 删除(title 等也允许删);双击文字 item -> 侧栏内容框聚焦.
  **左右居中约束**:页面文字的「左右居中」开关在侧栏 x/y 正下方(`center_h`);开启时 x 数字框
  冻结并置灰,x 行变灰,显示说明「水平位置由纸张宽度决定(拖拽只改垂直位置)」,对齐分段也禁用;
  拖拽/方向键只改 y.关闭开关后 x 恢复可编辑并保持当前 x/anchor,重新可水平移动.地图地名 item
  不显示该开关(map 空间必须 false).
  选中文字时侧栏显示**坐标空间 + x/y(含居中开关)/ 内容 / 角色(仅页面文字)/ 自动换行(仅注记)/
  对齐 / 旋转**:注记多一组「自动换行」--文本域编辑原始内容,数字字段「折行宽度(pt)」改宽度后
  立即按新宽度重排(最小 20pt);文本域里的手动换行保留为强制分段.
  样式字段已全部迁到「样式设置」窗口,地图地名 item 还显示一条只读说明「样式在地图分类「城市」里
  统一设置,同分类全部地名一起改;单条文字不能单独改字号/颜色.」,底部按钮文案为「打开「城市」
  样式设置」,点击直接定位到该分类;页面文字则定位到它的角色分类.图例条目可改名/显隐/增删.
- **工具条**:文件(打开... / 导出 geo.json / 导出 SVG),添加(文字 / 标题 / 图例 / 色标),
  样式(样式设置),视图(适应页面 / 1:1).
- **样式设置窗口**:工具条「样式设置」或侧栏底部「打开样式设置」拉起独立模态窗口;侧栏入口会带上
  当前 item 的分类(地图地名 -> 它的 `role` 分类,页面文字 -> 它的角色分类),打开即定位到该分类.
  - 头部:标题「样式设置」+「关闭」;总说明「按分类统一设置文字样式;任何改动都会立即作用于该
    分类下的全部文字」,并解释页面文字(不在地图上,按文字角色)与地图标注(来自 Cartopy
    `geo.json`,按 `role` 分类)的区别,以及地图分类字号默认值的来源.
  - 左列:按 `TEXT_STYLE_CATEGORY_GROUPS` 分两组--「页面文字」6 类(标题/副标题/标注/注记/
    来源/地名(手动))与「地图标注」14 类(城市/境外参照城市/行政区/弱化行政区/强调区 1~4/
    国名/本国名/海域/河流/山系-地貌/流域),每组有标题与一句分组说明;组内按 `TEXT_STYLE_CATEGORY_META`
    的 `section` 加语义小标题(标题 / 标注与说明 / 手动地名;城市 / 行政区与强调区 / 国名与自然
    地物),不改变分类 id 与顺序.每个分类按钮显示颜色色块,名称,当前元素数量徽标;分类在
    `page.text_style` 里有覆盖时显示「已改」小标(右列分类头的「排版值」状态不会点亮这个标记);
    地图分类在该底图没有对应 `role` 地名(数量 0)时置灰,但仍可选中,右列说明「该底图没有...地名,
    修改对当前图没有效果」;页面分类数量 0 不置灰(之后可新增该角色文字).
  - 右列顶部是固定分类头:分类名 + 类型徽标(页面文字/地图标注)+ 状态徽标「默认」/「已改」/
    「排版值」+「影响 N 个元素」+ 示例文字(页面分类取该分类第一条 item 的整段文字,地图分类取
    前 1~2 条地名首行;没有 item 时用 `config/text-style.ts` 的静态示例).「排版值」= 页面分类
    没有覆盖,但当前 item 字号与固定默认字号不同(排版里保留了早先的纸面字号);「恢复「X」默认
    值」按钮在「有覆盖」或「排版值」时可用(地图分类只在有覆盖时可用);点击后有覆盖则删除覆盖,
    页面分类按固定默认字号重写 item,地图分类回到分类默认统一字号.
  - 分类头下方是实时预览:用当前分类样式重绘示例文字(背景取纸张色;地图分类用浅色地图底;光晕
    副本先画,填充副本后画,与渲染层同口径),字号/颜色/光晕改动立刻可见.
  - 预览下方字段分四组:字号 / 颜色与字形(文字颜色,字重四档,斜体)/ 行距与字距(行高,字距)/
    描边(光晕)(开关 + 颜色 + 宽度,关闭时颜色/宽度禁用).**每个字段输入即时生效**:窗口只发
    单字段补丁,由编辑器调 `core/text-style.ts` 的 `applyTextStyle` 写 `page.text_style` 并批量同步
    该分类全部 item;地图分类只有一个「字号(pt)」数字,改任意字段(哪怕只改颜色)都会把该分类
    全部地名统一到窗口值.字号/行高/字距/光晕宽度四个数字字段旁各有 reset 按钮:点它删除该字段
    覆盖,恢复代码默认值(不是把默认值写成覆盖),字段值已是默认时禁用;页面分类字号写回固定
    默认值,地图分类字号回到分类默认统一字号(该分类地名原始字号中位数 × 地图缩放),光晕宽度
    只重置宽度,保留当前颜色.分类头「恢复「X」默认值」仍保留,用于整分类恢复.
  - 关闭方式:头部「关闭」按钮,`Esc`,点遮罩(窗口不设底部操作条);窗口打开时焦点进面板,关闭后归还打开前的
    焦点.窗口读写最新 layout/geo,与当前文档同生命周期(换文档时销毁);外部 `sync` 就地刷新数值,
    分类头,左列徽标与预览,跳过聚焦中的控件(数字输入不被打断),光晕开关只切换颜色/宽度的
    可用性而不重建字段.
- **侧栏**:页面(纸张预设/方向/宽高;底部说明「纸张尺寸与元素位置都以 pt 落盘;预览与导出的
  final.svg 共用同一套排版公式」;改纸张不移动已放置元素,状态行提示「纸张已改变:已放置元素
  位置不变,可拖拽或改 x/y 调整」),地图(x/y/宽度,图框开关/刻度开关/线宽/颜色/刻度字号),
  元素列表(选中/删除/新增),选中项属性(按 kind 分支),图例条目编辑.
- **快捷键**:`Ctrl+S` = 导出 geo.json;未导出时 `beforeunload` 提醒.
- 选中 item 的 id 通过 SVG 数据属性命中;渲染是每帧全量重建 DOM(元素 ≤500,简单优先).
- 不引入新依赖;只用 `miko_ui` 与标准 DOM.禁止 `alert/confirm`,`console`(沿用 eslint).
- 字体用 `font-family` 引用本机字体,测量通过注入的 `MeasureText`(canvas measureText,无 canvas 时估算).

## 10. 验收

1. `npm run check`(typecheck/lint/arch/format:check/test/build)全绿.
2. `npm run dev` -> `http://localhost:5173/map.html`:上传真实 Cartopy 产物(`demo/figures/Volga/`
   的底图 `.build/...base.svg` + 同名 `.geo.json`)-> 生成默认排版(标题/地图/刻度/地名/
   图例/注记/色标/来源);编辑标题;「导出 geo.json」「导出 SVG」各得到一个文件;刷新页面无后端请求,
   无 404.在「页面」面板改纸张宽度/方向 -> 已放置元素位置不变,状态行提示「纸张已改变:已放置
   元素位置不变,可拖拽或改 x/y 调整」.
3. `final.svg` 不变量:根 `width/height` 带 `pt`,viewBox 一致;`<g id="mapdoc-map">` 内是底图内容
   (不引用外部 `base.svg`;底图自带的 base64 内联 `<image>` 允许存在),且带 `clip-path` 指向
   `<defs>` 里的 `mapdoc-map-clip`(矩形 = `geo.base.view_box`);文字为 `<text>`;有
   `mapdoc-final` marker(`geo` / `page` / `version:2`);有 `<metadata id="mapdoc-source">`(内容可
   解出整份 geo.json + 底图前后缀);XML 可解析;浏览器打开渲染正常.
4. **单文件往返**:用「底图 + 导出的 geo.json」重新打开 -> 排版原样恢复,状态为「已导出」(不标脏)
   -> 再次导出 geo.json 字节一致(导出幂等:导出 -> 重新打开 -> 再导出,字节完全相同).
5. **成品再编辑**:只上传导出的成品 SVG -> 排版原样恢复,底图逐字节还原 -> 再次导出成品 SVG 与第一次
   逐字节相同;没有内嵌可编辑源的旧版成品直接拒绝打开,并提示用 `base.svg + geo.json` 重新导入后
   重新导出.
6. 边界:只上传底图 svg / 只上传 geo / 成品 + 不配套 geo(marker 摘要不一致)/ geo 与底图不配套
   (sha 不符)/ 非法 JSON / 旧 `mapdoc-page`(`scene.json`)/ 旧版成品(无内嵌源)-> 面板给出中文
   原因且不崩;旧 `scene.json` 的提示是「是旧版 scene.json:排版已并入 geo.json,请改用 Cartopy
   产出的 geo.json(或本编辑器导出的 geo.json)」.
7. Cartopy 直出的 geo.json(无 `page` 块)打开即生成默认排版;本编辑器导出的 geo.json(带 `page`
   块)打开即恢复排版,两者都能作为输入.
8. 可选但尽量:无 `legend` 的图或手工删除 `legend`/`relief` 键的 geo 不报错,默认布局合理
   (不生成空图例框/色标).
9. **分类样式**:上传 demo geo -> 工具条「样式设置」打开窗口 -> 左列出现两组共 20 个分类(每组有
   标题与一句分组说明,组内有语义小标题),每项有颜色色块与当前元素数量徽标,改过的分类显示
   「已改」;该底图没有对应 `role` 地名的地图分类置灰但仍可选中,右列说明原因;右列分类头显示
   类型徽标/影响 N 个元素/默认·已改·排版值/示例,下方有实时预览与四组字段,字号/行高/字距/光晕
   宽度旁各有 reset 按钮(字段值为默认时禁用)-> 改「城市」颜色/字号/字重/行高 -> 画布上全部城市
   标注立即变化,右侧选中该分类后字段值同步;改「页面文字/标题」字号 -> 标题立即变化;地图分类
   改字号后该分类全部地名**严格同字号**(只改颜色等其它字段时也保持统一);「恢复默认」-> 该分类
   回到默认样式,页面分类回到固定默认字号,地图分类回到「分类默认统一字号」(该分类底图字号中位数
   × 缩放,全部地名相等).字段级 reset:把「城市」字号改掉后点字号旁的 reset -> 字号回分类默认
   统一字号,`page.text_style` 里该分类的 `font_size_pt` 覆盖键消失;行高/字距/光晕宽度同理
   (光晕宽度只重置宽度,保留颜色),字段值已是默认时按钮禁用.导出 `geo.json` 含
   `page.text_style`(只出现用户设过的分类/字段);重新打开该 geo.json 样式原样恢复;改纸张尺寸/
   方向不会丢掉分类样式.侧栏选中单条文字显示坐标空间/x-y(含「左右居中」开关)/内容/角色/
   对齐/旋转,没有字号/颜色等字段;注记另显示「折行宽度(pt)」;切换页面文字角色后该条立即套用
   新分类样式.**反例**:旧 page
   块缺 `geo_label_id`(或指向不存在的 id)-> 告警并回退默认排版;带合法 page 块但逐条样式与分类
   覆盖不一致 -> 打开时按分类覆盖,标脏并告警「旧排版中的逐条文字样式已按分类设置统一(N 条)」.
10. **左右居中约束**:默认排版里标题/副标题/来源 `center_h = true` 且 x = 纸张中心;改大/改小
    纸张宽度或切换方向 -> 三条仍水平居中(x 跟随纸张中心,anchor=middle),不需要重排.单条
    选中标题:开启「左右居中」时侧栏 x 输入框冻结并置灰,对齐分段禁用,只能上下移动;关掉开关
    后 x 恢复可编辑,对齐分段恢复可用,可水平拖动/方向键移动;再打开开关 -> 立即回到中心.地图
    地名 item 不显示该开关.导出的 geo.json 里 `page.items[]` 带 `center_h` 与居中 x;手改该
    标题的 `x`/`anchor` 后重新打开 -> 纠回纸张中心,标脏并告警「排版中的左右居中约束已按纸张宽度
    重新贴合(N 条)」;再导出并重新打开 -> 干净(幂等).
11. **页面字号固定与旧排版「排版值」**:页面文字(标题/副标题/注记/来源)默认字号固定为
    18/9/7.5/7pt,改变纸张宽/方向不会改变它们;导出 -> 重新打开字号一致,状态干净(不标脏,
    不出现「逐条文字样式已按分类设置统一」告警),再次导出字节一致.打开保留了非固定字号的
    旧 page 块(例如 12pt 标题)时:样式设置分类头显示「排版值」,恢复默认可用;
    点击后状态回到「默认」,字号写回当前固定默认值(标题 18pt),画布字号随之变化.地图分类字号
    仍恒为「覆盖 ?? 中位数 × `s`」.
12. **排版值状态**:页面分类无覆盖,当前字号与固定默认字号不同 -> 分类头状态显示「排版值」,
    「恢复「X」默认值」可用;点击后状态回到「默认」,字号变为固定默认值.地图分类无覆盖时仍显示
    「默认」且恢复按钮禁用;「排版值」不会点亮左列的「已改」标记.
13. **选中框行盒**:选中单行文字,把「行高」从 1.35 改到 2 -> 选中框上下沿随行高变高(半行距
    `halfLeading` 均分到上下),命中框同步变化;旋转文字的框仍按同一 `rotate` 变换贴住文字块.
14. **注记自动折行**:选中注记,把内容改成一长段(不敲回车)-> 超出「折行宽度(pt)」后自动拆成
    多行,画布/导出都在该宽度内折行,侧栏文本域仍显示原始一长段;把折行宽度改小 -> 行数变多,
    改回原值 -> 恢复原分行(原始内容没被拆断).内容里敲回车 -> 保留为强制分段.改注记分类字号/
    字距 -> 自动重排.导出 geo.json 带 `text`/`wrap_width_pt`;重新打开 -> 状态干净,字节一致.
    反例:手改 `lines` 与原始内容不一致 -> 打开时按宽度重排,标脏并告警「排版中的注记已按折行
    宽度自动重排(N 条)」;把 `wrap_width_pt` 放到标题/地图地名上 -> page 块校验不合法并回退默认
    排版.

## 11. 非目标与已知限制

- **字体不内嵌**(v2):成品文字用 `font-family` 引用本机字体,跨机器字形可能变化,印刷前
  Inkscape/AI 转曲.字体子集载荷位置已预留(合成时可往 `<defs>` 加 `@font-face`),本轮不做.
- **自动换行只覆盖页面注记**:标题/副标题/标注/地名(手动)/来源仍只在默认排版时按宽度折一次
  写进 `lines`,之后改内容/字号不会重排;地图地名按底图给的分行渲染.**不做两端对齐**;字距按
  item 的 `letter_spacing_em` 渲染并参与注记折行测量.
- **文字样式按分类统一覆盖**:单条 item 没有独立样式字段(侧栏只留内容/角色/对齐/旋转),改样式
  只能在「样式设置」窗口按分类改,一次应用到该分类全部 item;要单条不同只能换角色/分类.
  **分类样式是唯一真源**:打开带 `page` 块的排版后会按分类重算每条 text item 的样式
  (`resyncTextStyles`);颜色/斜体/字重/字距/行高/光晕以分类覆盖为准,地图分类字号强制统一,
  页面分类字号按「覆盖 ?? item 现值 ?? 固定默认」保留(固定默认字号不会覆盖 item 里已有的字号).
  逐条样式与分类口径不一致会被覆盖,标脏并告警「旧排版中的逐条文字样式已按分类设置统一(N 条)」;
  旧 page 块缺 `geo_label_id`/`center_h` 等新字段时 page 块校验不合法,会告警并回退默认排版.
  **地图标注按分类强制统一字号**,不能逐条保留底图字号层级.
- **页面文字字号固定**:标题/副标题/注记/来源默认 18/9/7.5/7pt,不随纸张尺寸缩放;排版里已有的
  其它字号显示为「排版值」,点「恢复默认」写回固定默认值.
- **左右居中只作用于页面文字**:地图地名的 `center_h` 恒为 `false`(位置来自底图数据);页面文字
  开启后水平位置由纸张宽度决定,拖拽/方向键只能改 `y`,要自由摆放需先关掉「左右居中」(关闭时
  保持当前位置).纸张宽度/方向变化后居中项自动重新贴合;非居中项保持原位置(位置只由各自
  x/y 决定).
- **无自动草稿**:不写 localStorage,不自动下载;刷新/关闭页面会丢未导出的修改(`beforeunload` 提醒).
  排版落盘 = 手动「导出 geo.json」.
- **大底图首次加载**:约 10 MB 的底图要一次性读入,严格 UTF-8 解码,求 sha256,做 C1–C4 扫描,
  首次打开和「导出 SVG」会有可感知的卡顿(都在主线程完成,尚无 Worker 化).
- **静态部署**:`npm run build` 后 `dist/` 可直接放任意静态服务器;开发端口唯一真值是
  `vite.config.ts`(5173,strictPort).不需要 Python/Node 后端;`file://` 直开可能受模块/Blob 限制.
- 不做比例尺/指北针(geo 未提供;后续 Cartopy 侧补数据再加组件).
- 不做撤销/重做,多图切换,图层管理(数组序即 z 序).
- **成品 SVG 的再编辑依赖内嵌源**:内嵌 `<metadata id="mapdoc-source">` 若被外部工具(Inkscape/AI)
  丢弃或内联底图被改写,就无法再打开(没有内嵌源的旧版成品不再支持);只能重新用 Cartopy 的
  `base.svg + geo.json` 导入排版,再由本编辑器重新导出带内嵌源的成品.
- 外部工具对成品渲染内容的修改(移动文字,改颜色等)**不会**被读回:再编辑以内嵌的 geo.json/page
  排版真值为准,渲染层只用于显示.
- 默认排版只是起点:小纸张(A5)+ 多图例 + 多条注记时,图例/色标与间距按 k 缩小后容易偏挤,
  需要手工调字号/位置或换纸张;页面文字字号固定,不随纸张缩放.用户改过排版后切纸张不会自动
  重排:已放置元素位置只由各自 x/y 决定,需要时手动拖拽或改 x/y.
- Cartopy 侧旧的带字产物不再被本仓解析:需要重新用 Cartopy 生成 `base.svg + geo.json`.
- **不再支持旧 `mapdoc-page`/`scene.json`**:排版已并入 geo.json 的 `page` 块,旧产物无法导入;
  需用 Cartopy 重新生成 `base.svg + geo.json`,再按新流程重新导入排版(或用本编辑器导出的 geo.json).

**迁移计划**:Cartopy 只做地理,直出 `base.svg + geo.json`(含初始标注候选),字体改为前端按字符裁子集后
交给合成,以及要搬过来的比例尺/指北针/引线/图例能力,统一记在
[`CARTOPY-MIGRATION.md`](CARTOPY-MIGRATION.md)(调查结论 + 分阶段计划 + 待拍板项).
