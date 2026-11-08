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
| item 物化值    | `TextItem` 的 `font_size_mm`/`color`/`halo` 等显式字段                                            | 渲染消费的字段,由分类样式批量写入;页面分类字号同时作为「覆盖 ?? 现值 ?? 默认」中的现值回退 | 独立样式真值;颜色等以分类为准,页面字号现值也不会被固定默认字号覆盖            |
| 排版/几何      | `PageLayout.items`                                                                                | 位置,内容,角色,锚点,旋转,居中约束                                                          | 样式来源                                                                      |

链路:`geo.labels[]` -> `core/open-map.ts` 打开(`validateGeo`/`normalizeGeo`;`page` 块缺省 ->
`defaultPageLayout`,存在 -> `validatePage`+`normalizePage`)-> `core/page-layout.ts` 的 `makeLabelItem`
(`geo_label_id = label.id` 绑定回来源,分类 = `label.role`,样式 = `page.text_style[分类]` 覆盖 ??
`config/text-style.ts` 默认,字号 = 覆盖 ?? 该分类全部地名 `font_size_pt` 的中位数 × 地图缩放 `s`,
夹到 1.5..15mm 并保留 1 位小数;地名坐标在这里由底图坐标一次性换算成纸张 mm,之后 item 只存纸张
坐标)-> 用户在「样式设置」窗口改分类时,`core/text-style.ts` 的 `applyTextStyle` 写覆盖并把该分类
全部 item 的物化字段同步一遍(打开时 `resyncTextStyles` 做同一件事)-> 渲染/合成只读 item 的物化
字段 -> `serializeMapDocFile` 把 geo 全字段 + `normalizePage(layout)` 落盘,成品 SVG 内嵌同一份
geo.json 原文 -> 重新打开走同一条链路.**生成端不存样式;item 不是独立样式真源;地图分类字号恒
统一**(同一分类下所有地名永远相等;窗口改任意字段,哪怕只改颜色,也会把该分类字号统一到窗口值).
页面文字的分类字号口径不同:`覆盖 font_size_mm ?? 该分类现有 item 的字号 ?? 固定默认字号`
(`PAGE_TITLE_SIZE_MM=6.35` / `PAGE_SUBTITLE_SIZE_MM=3.175` / `PAGE_NOTE_SIZE_MM=2.646` /
`PAGE_SOURCE_SIZE_MM=2.469`,不随纸张缩放)--item 里已有的字号优先保留,导出 -> 打开幂等,窗口把
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

**长度单位**:geo 块(Cartopy 契约)仍是 pt,坐标是底图 `viewBox` 坐标;这些字段只读,打开时由
`core/page-layout.ts` 的 `mapTransform`/`makeLabelItem` 一次性换算成纸张 mm.`page` 块与其中所有
item 只有一套单位 **mm**(1 SVG 用户单位 = 1mm),不存在第二套坐标空间;`geo_label_id` 非 null 的
item 只是带来源标记的普通纸张坐标文字(见 §4.1/§5.1).

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
    "width_mm": 297, // 纸张宽(mm);预设见 §4 约束
    "height_mm": 210,
    "locked": false, // 纸张尺寸锁(必填);true 时预设/方向/宽高冻结,落盘后重新打开仍锁定
  },
  // 页边距(mm,四边到纸张边缘的距离):版心参考,不参与排版计算,不移动已放置元素
  "margin": { "top": 0, "right": 0, "bottom": 0, "left": 0 },
  "map": { "x": 10, "y": 25.5, "width_mm": 210.4 },
  // 高度由宽度派生:map.height = width_mm * geo.base.height_pt / geo.base.width_pt(保持纵横比)
  "frame": {
    "show": true,
    "stroke": "#000000",
    "width_mm": 0.3,
    "ticks": true,
    "tick_length_mm": 1.8,
    "tick_font_size_mm": 2.5,
    "tick_color": "#444444",
    "tick_gap_mm": 0.7,
  },
  "style": {
    "paper_color": "#ffffff",
    // 全项目字体栈(config/fonts.ts 的 FONT_FAMILY_STACK),界面/预览/成品共用同一串
    "font_family": "'JetBrains Mono Slashed', 'Noto Sans Mono CJK SC', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    "color": "#111111",
  },
  // 分类样式覆盖表(可选):只存用户显式改过的字段,没列出的分类/字段用分类默认值
  "text_style": {
    "title": { "font_size_mm": 6.35, "color": "#111111", "font_weight": 600 },
    "city": {
      "font_size_mm": 3, // 地图分类:字号恒统一;缺省时用分类默认统一字号(该分类底图字号中位数 × 地图缩放)
      "color": "#222222",
      "halo": { "color": "#ffffff", "width_mm": 0.18 },
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
  的分支.长度字段一律 `_mm`;**旧 pt page 块不兼容也不迁移**:仍用 `width_pt`/`space` 等旧字段名的
  page 块会被**静默忽略**(不迁移,不告警,直接回退默认排版,§8.2);缺 `paper.locked`/`margin` 但
  没有旧 pt/space 字段的 page 块仍按「不合法」告警后回退.
- `paper` 宽高 20..2000mm;`paper.locked` 必须是布尔值(必填,缺省不算合法);`orientation` 为
  `portrait|landscape`;`preset` ∈ `A5|A4|A3|Letter|Custom`(预设仅 UI 记忆,尺寸以宽高为准).
- `margin` 必填对象,`top/right/bottom/left` 都是非负有限数字(mm,可为 0);不要求四边之和小于
  纸张,`normalizePage` 会把超出的值夹到纸张边长.页边距不参与版式计算,也不是元素约束;它只作为
  版心参考(§5.6/§9),另参与自动折行回退宽度与来源页底兜底两处次要计算(§4.1).
- `map.x/y` 有限即可(越界只告警);`map.width_mm > 1`;颜色只接受 `#rrggbb`;数字 3 位小数;
  `items.length ≤ 500`;`seq` 为正整数且大于所有 item id.
- text item 的 `font_weight` 必须是 100..900 的整数,`letter_spacing_em` 必须是有限数且在 -1..2;
  text item 的 `center_h` 必须是布尔值;`geo_label_id` 非 null(地图地名)时不能为 `true`
  (地图地名位置属于底图数据).
- `style`:`paper_color` / `color` 只接受 `#rrggbb`;`font_family` 是**全项目字体栈**
  (`config/fonts.ts` 的 `FONT_FAMILY_STACK`:拉丁 `'JetBrains Mono Slashed'` 在前,中文
  `'Noto Sans Mono CJK SC'` 兜底,界面与成品共用同一串).本编辑器没有字体选择入口,新文档写
  默认值,文件里已有的 `font_family` 原样沿用(手改的自定义字体串也保留,只是界面不提供切换).
  导出时按成品里实际用到的字形把这两族裁成子集内嵌(§6.3);没有对应资产的自定义字体串仍靠
  本机字体(§11).
- `text_style`(可选,缺省 `{}`,`normalizePage` 一定补上):**分类文字样式覆盖表**.键必须属于
  20 个分类 id(页面文字 `title`/`subtitle`/`annotation`/`note`/`source`/`label` + 地图地名
  `city`/`city-reference`/`area`/`area-muted`/`area-accent-1` ~ `area-accent-4`/`country`/
  `country-name`/`sea`/`river`/`highland`/`area-basin`,唯一真源是 `config/text-style.ts` 的
  `TEXT_STYLE_CATEGORY_IDS`);值对象的字段只允许 `font_size_mm`,`color`,`italic`,`font_weight`,
  `letter_spacing_em`,`line_height`,`halo` 七个,且**只存用户显式改过的值**--默认值仍在
  `config/text-style.ts`,不复制进文件.地图分类的字号**恒统一**:`font_size_mm` 缺省时使用
  「分类默认统一字号」--取该分类全部 `geo.labels` 的 `font_size_pt` 中位数 × 地图缩放比 `s`,
  夹到 1.5..15mm 并保留 1 位小数;该分类没有地名时回退 3.5mm;同一分类下所有地名永远使用同一个
  字号.页面分类的字号口径是「覆盖 `font_size_mm` ?? 该分类现有 item 的字号 ??
  `PAGE_TEXT_DEFAULT_FONT_SIZE_MM`」:页面默认字号固定(标题 6.35mm / 副标题 3.175mm /
  注记 2.646mm / 来源 2.469mm,标注与手动地名 3.5mm,不随纸张缩放);item 里已有的字号优先保留,
  按分类重建不会改写它(导出 -> 打开字节幂等);用户显式改字号或恢复默认才按固定默认值/覆盖
  重写.覆盖表是「覆盖 ?? 分类默认」的样式来源:设置时由 `core/text-style.ts` 把解析后的样式批量
  写回该分类全部 item,默认排版(§5.6)也按它解析初始值;渲染仍只读 item 上的显式字段(§5.3).
- `text_style` 校验口径:`font_size_mm` 是 0.35..180 的有限数(页面/地图分类同一口径,不允许
  `null`);`color` `#rrggbb`;`italic` 布尔;`font_weight` 100..900 的整数;`letter_spacing_em`
  -1..2;`line_height` 0.5..5;
  `halo` 为 `null`(= 显式关光晕,与「没有该键」不同)或 `{ "color": "#rrggbb", "width_mm": 0..7 }`
  (对象出现时两个字段都必须给).未知分类/未知字段一律校验失败,与 page 块其它字段同一严格口径.

### 4.1 item 联合类型

三种 `kind`,共字段:`id`(正整数,唯一),`kind`;所有 item 的 `x`/`y` 都是**纸张坐标**(mm,原点 =
纸张左上角,x 向右,y 向下),没有 `space` 字段,也没有 page/map 双坐标空间.地图地名 item 只是带
`geo_label_id` 来源标记的普通纸张坐标文字(打开时已换算,移动/缩放地图时由
`remapMapLabelItems` 整批搬移).

**text**

```jsonc
{
  "id": 1,
  "kind": "text",
  "role": "title", // title|subtitle|label|annotation|note|source(页面文字角色;样式由分类覆盖决定)
  "x": 148.5,
  "y": 15.2, // 纸张坐标(mm);首行基线
  "lines": ["伏尔加河流域地形图"], // 1..40 行,每行 ≤200 字符;开启自动折行时是派生量
  "text": null, // 自动折行的原始内容(含手动换行);null = lines 即真值
  "wrap_width_mm": null, // 自动折行宽度(mm);null = 不自动折行(只有页面注记/来源可为数字)
  "font_size_mm": 6.35,
  "font_family": null, // null = 用 style.font_family
  "color": "#111111",
  "anchor": "middle", // start|middle|end
  "rotation_deg": 0,
  "line_height": 1,
  "italic": false,
  "font_weight": 400, // 100..900 的整数;替换旧的 bold:boolean
  "letter_spacing_em": 0, // 字距(em,相对字号),-1..2
  "halo": null, // 或 {"color":"#ffffff","width_mm":0}(先描边后填充;页面文字开光晕默认取 TEXT_HALO=0mm 宽,地图地名默认 0.18mm)
  "geo_label_id": null, // 地图地名 item = 来源 geo.labels[].id;页面文字恒为 null
  "center_h": false, // 左右居中约束(页面文字可开关;地图地名恒为 false)
}
```

- `geo_label_id`(**必填**):地图地名 item(`geo_label_id` 非 null)必须是非空字符串,且必须是本次
  `geo.labels[].id` 中存在的 id--它决定该 item 属于哪个地图分类(分类统一字号/样式与聚合都按它
  归类);手动页面文字必须为 `null`.缺字段,指向不存在的 id,页面文字给了非 `null` 值,都算 page
  块校验不合法:打开时告警并回退默认排版(§8.2).
- `geo_label_id` 非 null 即「地图地名」:它仍是地图分类/样式的真值来源,但不再是独立坐标空间--
  位置就是纸张坐标 `x`/`y`,与页面文字同一套几何/拖拽/选中逻辑.
- 页面文字角色 `label`(样式窗口里的显示名「地名(手动)」)是工具栏「文字」手动新增的文字,
  `geo_label_id` 恒为 `null`;它与来自 `geo.labels[].role` 的「地图标注」分类不在同一层:地图分类
  只由 Cartopy 的 `role` 决定,Python/底图侧不画任何文字.
- `center_h`(**必填**布尔值):页面文字的「左右居中」约束.`true` 时水平锚点恒为纸张中心
  `paper.width_mm / 2`(按 3 位小数取整),`anchor` 恒为 `middle`;`y`,旋转,内容不受影响.
  地图地名必须为 `false`(位置由底图数据决定,纸张变宽不能改变地名在地图上的相对位置),
  `validatePage` 对地图地名给 `true` 直接判错.`normalizePage` 把缺失/非布尔兜底成 `false`,随后
  调用 `enforceHorizontalCenter` 把 `center_h=true` 的 item 拉回纸张中心;打开文件,每次排版修改
  (包括改纸张宽度/方向)后也都会执行同一约束,因此居中项会自动跟随纸张宽度重新贴合.拖拽与方向键
  移动对居中项只改 `y`(水平位移被约束吃掉);在侧栏关掉开关后保持当前 `x`/`anchor` 不变.新建
  文字时 `title`/`subtitle`/`source` 默认开启,其余关闭.
- **注记/来源自动折行**(`text` / `wrap_width_mm`):只有 `role=note|source` 的文字允许开启;
  `text` 是不折行的原始内容(手动换行用 `\n`),`lines` 是它按 `wrap_width_mm` + 当前字号/字重/
  字距折出来的结果.派生约束由 `core/page-layout.ts` 的 `enforceAutoWrap` 统一执行:内容,折行
  宽度,字号,字重,字距任一变化后重算 `lines`;宽度先夹到下限 `PAGE_AUTO_WRAP_MIN_MM=7` 并收敛到
  3 位小数再折行,保证「导出 -> 重新打开」用同一宽度复现同一批 `lines`(幂等).折行宽度只有一个
  口径 `effectiveAutoWrapWidth(layout, item)`:`enforceAutoWrap` 折行,侧栏「折行宽度(mm)」读数,
  §5.7 选中框/命中盒的横向声明框都从它取数(`wrap_width_mm` 为 null 时按锚点从页边距推导:
  注记/左锚点 = `x` 到右页边距,居中项 = `2 × min(x - 左页边距, 右页边距 - x)`),三处不会各算
  一份.来源额外按「页底说明」处理:折行后保持最后一行基线不动(块向上长),并用页底边距
  `margin.bottom` 兜底,避免多出来的行画到纸面外.
  `text`/`wrap_width_mm` 缺省(未开启自动折行,或手写的 page 块只给了 `lines`)时,打开流程补默认
  宽度(注记 = `x` 到右页边距;来源默认左右居中 = 左右页边距之间的内容宽),把现有 `lines` 当原始
  内容,标脏并告警「排版中的注记/来源已按折行宽度自动重排(N 条)」;其它角色/地图地名带这两个
  字段会被校验拒绝.`normalizePage` 只做类型兜底(非注记/来源上的字段清成 null),折行必须由带
  字体测量的 `enforceAutoWrap` 完成.

**legend**

```jsonc
{
  "id": 3,
  "kind": "legend",
  "x": 240,
  "y": 25.5,
  "width_mm": 47,
  "title": "图例",
  "entries": [
    {
      "label": "国界",
      "shape": "line",
      "stroke": "#4a4a4a",
      "width_mm": 0.49,
      "dash": null,
      "fill": null,
      "opacity": 1,
      "marker": null,
    },
  ],
  "font_size_mm": 3.2,
  "title_size_mm": 4.2,
  "row_height_mm": 4.9,
  "padding_mm": 2.5,
  "swatch_width_mm": 8.5,
  "swatch_gap_mm": 2.1,
  "frame": {
    "show": true,
    "stroke": "#bbbbbb",
    "width_mm": 0.3,
    "fill": "#ffffff",
    "opacity": 0.94,
  },
}
```

高度自动派生(公式见 §5.4),不落盘;`width_mm` 由前端创建时按文字测量给出,之后可改.图例条目
的 `width_mm` 是线宽(mm),来自 `geo.legend.entries[].width_pt` 打开时的一次换算(§5.1).

**colorbar**

```jsonc
{
  "id": 4,
  "kind": "colorbar",
  "x": 270,
  "y": 90,
  "width_mm": 5,
  "height_mm": 63.5,
  "title": "高程 / 水深",
  "unit": "m",
  "show_title": true,
  "show_ticks": true,
  "title_size_mm": 2.8,
  "label_size_mm": 2.5,
}
```

配色/刻度来自 `geo.relief`(vmin/vmax/stops/ticks),不落 `page` 块;`page` 块只存摆放与文字.
`geo.relief` 为 `null` 时不能再添加色标(编辑器提示「该 geo.json 没有 relief 色标数据」),
合成时若 `page.items` 里仍有 colorbar 会抛 `Error('色标需要 geo.relief')`.

## 5. 布局公式(预览与导出共用 `core/page-layout.ts`)

所有几何只在 `core/page-layout.ts` 实现一次:预览(`render/page-svg.ts`)与成品
(`render/compose-svg.ts`)调同一批函数,不得各写一套.所有数值都是 **mm**(1 SVG 用户单位 =
1mm,原点 = 纸张左上角);geo 块只读输入仍是 pt/viewBox 坐标,只在 §5.1 换算一次.写进 SVG 的
数值格式由 `render/page-format.ts` 统一(最多 3 位小数,去尾零,不带单位后缀).

### 5.1 底图坐标 -> 纸张坐标

```
s  = map.width_mm / geo.base.width_pt          // mapTransform().s(单位:mm / 底图 pt)
tx = map.x - geo.base.view_box[0] * s
ty = map.y - geo.base.view_box[1] * s
page(p) = (tx + p.x * s, ty + p.y * s)
map.height = map.width_mm * geo.base.height_pt / geo.base.width_pt   // mapHeightMm()
```

- geo 的 pt 只是外部契约单位(底图/viewBox 坐标),`page` 块内部不出现 pt;打开时
  `makeLabelItem` 用同一变换把 `geo.labels` 换到纸张 mm.
- 地图摆放(`map.x`/`map.y`/`map.width_mm`)变化后,`remapMapLabelItems` 把 `geo_label_id` 非 null
  的地名按新旧仿射关系整批搬移:`p' = newTransform(pagePointToMap(oldTransform, p))`,保留用户
  手动拖过的相对偏移;手动页面文字不动.
- 图例条目里的线宽/虚线是 geo 契约的 pt,`legendEntriesOf` 用 `25.4/72` 换算成 mm 落进 item;
  名字仍叫 `width_mm`.

### 5.2 图框与刻度(`frameTickLayout`)

- 图框 = `rect(map.x, map.y, map.width_mm, map.height)`,`fill=none`,stroke/线宽来自 frame.
- 经度刻度(`side=bottom`):`px = page(tick.x).x`,线从 `(px, map.y+map.height)` 到
  `(px, map.y+map.height+tick_length_mm)`;标签 `text-anchor=middle`,基线
  `y = map.y+map.height+tick_length_mm+tick_gap_mm+tick_font_size_mm`;`top` 侧镜像(线向上,
  基线 `y = map.y-tick_length_mm-tick_gap_mm`).只画 `0 ≤ page(tick.x).x ≤ paper.width_mm` 的刻度.
- 纬度刻度(`side=left`):`py = page(tick.y).y`,线从 `(map.x, py)` 到
  `(map.x-tick_length_mm, py)`;标签 `text-anchor=end`,`x = map.x-tick_length_mm-tick_gap_mm`,
  基线 `py + tick_font_size_mm*0.35`;`right` 侧镜像.只画落在 `0..paper.height_mm` 的刻度.
- 刻度文字取 `geo.graticule.lon/lat[].label`.图框/刻度只在 frame.show/frame.ticks 为 true 时画.

### 5.3 text(`textLayout(item)`)

- `textLayout(item)` 只接收 item(不再需要 geo/layout 参数):起点 `(px, py) = (item.x, item.y)`,
  两者都是纸张坐标(mm);地图地名也一样(打开时已换算).
- 第 i 行基线 `y = py + i * font_size_mm * line_height`(i 从 0 起);`text-anchor = anchor`.
- 多行整体绕第一行锚点旋转:`<g transform="rotate(rotation_deg px py)">`,组内逐行 `<text x=px y=py+i*lh>`.
- `halo` 非空:同一文字先画 `stroke=halo.color; stroke-width=halo.width_mm; fill=halo.color;
paint-order=stroke` 的副本,再画正常填充(与 matplotlib 的 paint-order 效果一致).
- 字体:`font-family = item.font_family ?? style.font_family`;`font-size="<mm>"`(SVG 用户单位 =
  mm,不带 `px`/`pt` 后缀).`italic` -> `font-style:italic`;`font_weight ≠ 400` ->
  `font-weight="<数字>"`(不再写 `bold`);`letter_spacing_em ≠ 0` 时写
  `letter-spacing="<letter_spacing_em × font_size_mm,3 位小数>"`(纸面 mm).
- SVG 文字属性顺序固定(成品字节确定性):`font-family` -> `font-size` -> `font-style`(italic) ->
  `font-weight` -> `letter-spacing` -> `fill` -> 光晕的 `stroke`/`stroke-width`/`paint-order`.
- 文本转义:`& < >`.
- **分类覆盖不改变渲染口径**:渲染只读 item 上的显式样式字段(`font_size_mm`/`color`/`italic`/
  `font_weight`/`letter_spacing_em`/`line_height`/`halo`);`page.text_style` 只是「设置时批量写回
  item」的来源.在「样式设置」窗口改一个分类时,`core/text-style.ts` 按分类口径解析出有效样式,
  逐条写回该分类全部 item(地图 item 若字号/行高变化,按「文字块垂直中心」修正纸张坐标 `y`,
  保住用户手动拖过的位置).字号口径按分类类型区分:
  - 地图分类:item 字号 = 覆盖 `font_size_mm` ?? **分类默认统一字号**(该分类底图字号中位数 ×
    地图缩放比 `s`,夹到 1.5..15mm 并保留 1 位小数,无地名时 3.5mm).因此同一地图分类下所有
    地名**字号必须相等**:默认排版,批量应用(哪怕只改颜色),恢复默认,单条 item 切换分类都会
    写回该统一字号.
  - 页面分类:item 字号 = 覆盖 `font_size_mm` ?? 该分类现有 item 的字号 ?? 固定默认字号
    `PAGE_TEXT_DEFAULT_FONT_SIZE_MM`(标题 6.35mm / 副标题 3.175mm / 注记 2.646mm / 来源
    2.469mm,不随纸张缩放).改颜色/行高等不含字号的补丁不会顺手改写页面文字字号;item 里已有
    的字号优先保留(`resyncTextStyles` 不会改它,导出 -> 打开幂等);用户显式改字号或恢复默认
    才写新值.
- **分类样式是唯一真源**:打开带 `page` 块的排版后,会按分类重建每一条 text item 的样式
  (`resyncTextStyles`):颜色/斜体/字重/字距/行高/光晕以分类覆盖为准,地图分类字号强制统一;
  页面分类字号按「覆盖 ?? item 现值 ?? 默认」回退,因此文件里已排好的字号不会被固定默认字号
  改写.逐条值与分类口径不一致时覆盖,标脏并告警(§8.2).
- **渲染不感知 `center_h`**:`textLayout` 只读 item 的 `x`/`anchor`;居中约束由
  `enforceHorizontalCenter` 在打开,每次排版修改与 `normalizePage` 时保证自洽,渲染与合成不需要
  第二套几何(§4.1).

### 5.4 legend(高度派生,`legendLayout`)

```
p  = padding_mm
row_h = max(row_height_mm, font_size_mm * 1.5)
title_h = title ? title_size_mm * 1.4 : 0
height = p*2 + title_h + n*row_h
title 基线 = y + p + title_size_mm;titleX = x + width_mm/2,anchor=middle
第 i 行中心 = y + p + title_h + row_h*(i+0.5)
swatch: x0 = x+p, x1 = x0+swatch_width_mm(线 / 矩形 / 点都画在 [x0,x1] × 中心线)
label 基线 = 中心 + font_size_mm*0.35,x = x1+swatch_gap_mm,anchor=start
frame.show -> 先画 rect(x,y,width_mm,height)
```

- `line`:`<line x0..x1>`,stroke/width/dash;
- `rect`:`<rect x0..x1,高=font_size_mm*0.9>`,中心对齐;stroke/fill/opacity;
- `point`:在中心点画 marker(star:外接半径 `font_size_mm*0.55` 的五角星;square:边长
  `font_size_mm*0.7`;circle:半径 `font_size_mm*0.35`),fill/stroke 取条目.

### 5.5 colorbar(`colorbarLayout` / `colorbarTitleText`)

```
bar = rect(item.x, item.y, width_mm, height_mm)
vmin/vmax/stops/ticks 来自 geo.relief
线性渐变(def id = "mapdoc-cbar-<item.id>"):y1=100% y2=0%(下 = vmin,上 = vmax),
stops 用 offset/color 原样
title(show_title):基线 y-1.4,anchor=middle,x = item.x+width_mm/2
每个 tick v:ty = y + height*(1-(v-vmin)/(vmax-vmin));右侧短线 x+width_mm..x+width_mm+1;
标签 x+width_mm+1.8,anchor=start,基线 ty + label_size_mm*0.35
单位:title 后接 " (unit)"(unit 非空且标题不含单位时)
```

### 5.6 默认排版(`defaultPageLayout(geo, options)`)

- 纸张默认 **A4 横向 297×210mm**(`PAGE_DEFAULT_PAPER_WIDTH_MM` / `HEIGHT_MM`),`locked:false`;
  排版随纸张自适应:`k = clamp(min(长边/297, 短边/210), 0.62, 1.6)`(`layoutScaleForPaper`)缩放
  图例/色标尺寸与版式间距;**页面文字字号固定**(`PAGE_TITLE_SIZE_MM=6.35` /
  `PAGE_SUBTITLE_SIZE_MM=3.175` / `PAGE_NOTE_SIZE_MM=2.646` / `PAGE_SOURCE_SIZE_MM=2.469`,
  不随纸张缩放);**横向**纸用「左地图 + 右栏」,**纵向**纸(`h > w*1.05`)用「地图满内容宽 +
  下方一排图例/注记/色标」,并让开地图底部的经度刻度标签.
- **初始版式内缩是内部常量,不是页边距**:`PAGE_DEFAULT_INSET_MM = 10`(左/下内缩),
  `PAGE_DEFAULT_MAP_TOP_MM = 25.5`(地图顶部起始 y);标题/副标题首行基线是纸张绝对坐标
  `PAGE_TITLE_BASELINE_MM = 15.2` / `PAGE_SUBTITLE_BASELINE_MM = 21.2`,不写成「相对页边距偏移」.
  这些常量只用于 `defaultPageLayout` 生成初始排版,不写进 `page` 块;返回的 `margin` 是四边 0 的
  页边距字段.已放置元素只由各自 x/y 决定位置,改纸张尺寸后位置不变.
- 地图摆放:`map.x = inset = 10`,`map.y = mapTop = 25.5`,`contentWidth = paper.width_mm - inset*2`;
  横向可用宽 = `contentWidth`(无右栏)或 `contentWidth - columnGap - 右栏宽`(有右栏),可用高 =
  `paper.height_mm - inset - sourceReserved - mapTop`;`mapWidth = max(2, min(可用宽, 可用高 /
baseRatio))`,纵向 `mapWidth = max(2, contentWidth)`;高度仍由
  `mapWidth × geo.base.height_pt / geo.base.width_pt` 派生.间距:`columnGap = 5.6*k`,
  `sourceReserved = 8.5*k`,`notesGap = 4.2*k`.
- 地名标注(`geo.labels`)打开时按 §5.1 一次性换算成纸张坐标铺上,**同分类统一字号**(见下条):
  颜色/斜体按 `role` 查 `config/text-style.ts` 的角色表,字重/字距/行高/描边取 `MAP_LABEL_STYLE`;
  `label.y` 是文字块垂直中心,按 `baseline_ratio` 换算回第一行基线后加回(见契约 §4),旋转默认 0.
  标题/副标题/注记/来源来自 `geo.suggestions`.
- **分类样式覆盖参与默认排版**:`defaultPageLayout` 仍接受 `options.text_style` 覆盖表,返回值的
  `text_style` 是它的深拷贝(缺省 `{}`);打开时的初始排版没有已有覆盖,传入缺省 `{}`.标题/副标题/
  注记/来源:字号 = 覆盖 `font_size_mm` ?? **固定默认字号**(`PAGE_TITLE_SIZE_MM=6.35` /
  `PAGE_SUBTITLE_SIZE_MM=3.175` / `PAGE_NOTE_SIZE_MM=2.646` / `PAGE_SOURCE_SIZE_MM=2.469`,
  不乘 `k`);颜色/斜体/字重/字距/行高/光晕 = 覆盖 ?? `PAGE_TEXT_STYLES[role]`(注记/来源无颜色
  覆盖时仍沿用 `style.color`);注记/来源的折行测量与块高必须用**解析后的**字号/字重/行高,否则
  覆盖后文字会溢出或压到下一块.注记与来源都把原始文案(手动换行保留)与**折行宽度**写进 item 的
  `text` / `wrap_width_mm`(注记 = 横向右栏宽 / 纵向一排的注记列宽;来源 = 左右内缩之间的内容宽,
  都取 3 位小数),之后改内容/字号/字距/宽度由 `enforceAutoWrap` 用同一口径重算,不再需要重新
  生成排版.来源折行后最后一行仍贴住 `paper.height_mm - inset`(块向上长),与默认排版的页底
  基线口径一致.
  地名:按 `label.role` 解析覆盖(颜色/斜体/字重/字距/行高/光晕),字号 = 覆盖
  `font_size_mm` ?? **分类默认统一字号**(该分类底图字号中位数 × `s`,夹到 1.5..15mm 并保留
  1 位小数;分类没有地名时回退 3.5mm),同一分类全部地名同字号;`geo_label_id = label.id`.默认
  排版只用于打开时的初始生成;之后改纸张尺寸/方向不会重新生成版式,既有 item 的字号保持不变
  (§5.3).
- **可选块降级**:`hasLegend = geo.legend.entries.length > 0`,
  `hasNotes = suggestions.notes 有非空行`,`hasColorbar = geo.relief !== null`.
  - `hasLegend` 为假 -> 不生成 legend item,也不留空图例框;
  - `hasColorbar` 为假 -> 不生成 colorbar item;
  - `title`/`subtitle`/`source` 只在 `suggestions` 对应字段非空时生成;`notes` 折行后为空也不生成;
  - 右栏(横向)/下方一排(纵向)只在 `hasLegend || hasNotes || hasColorbar` 时存在:
    **有图例**时右栏沿用图例列宽(横向按文字测量夹在 `PAGE_DEFAULT_RIGHT_COLUMN_MIN_MM=53` ..
    `MAX_MM=92`;纵向再乘 k),既有布局/数值不变(回归 demo);**无图例但有注记/色标**时横向右栏
    改用窄列 `0.7 × 53 × k`(A4 横向约 37.1mm,只容纳折行注记与色标),地图相应加宽;纵向注记从
    左内缩开始,色标仍贴右,空块不占列;三块都没有时整栏/整排不存在,地图用满内容宽.
- 图例/色标默认尺寸来自 `config/page.ts`:`PAGE_LEGEND_DEFAULTS`(字号 3.2mm / 标题 4.2mm /
  行高 4.9mm / padding 2.5mm / swatch 8.5mm / 间距 2.1mm,均乘 k),`PAGE_COLORBAR_WIDTH_MM=5`
  / `HEIGHT_MM=63.5` / `GAP_MM=6.5`(乘 k),色标最小高度 `PAGE_MIN_COLORBAR_HEIGHT_MM=14`.
- **标题/副标题/来源默认左右居中**:`center_h = true`,`x = paper.width_mm / 2`,`anchor = middle`
  (派生 x 按 page 的 3 位小数口径写,保证与 `enforceHorizontalCenter`/`normalizePage` 自洽);
  注记(默认排版里唯一的自由摆放页面文字)与全部地图地名 `center_h = false`;标注/手动地名不在默认
  排版里,由用户新增时按角色决定(默认关闭).纸张宽度/方向改变后由编辑器重新贴合,不需要重排.
- 返回完整合法的 `PageLayout`(含 `paper.locked`,四边 0 的 `margin`,`seq` > 所有 item id),由
  调用方标记为「未导出」.页边距不参与以上任何版式计算:它就是返回的版心参考字段(§4),只在
  自动折行回退宽度与来源页底兜底里被参考;改边距不会移动任何已放置元素.

### 5.7 item 几何框(选中框 / 命中盒,`itemBoundsMm`)

预览里的**选中框**与**点击命中盒**必须是同一个可核对的几何量,不允许手写虚框,也不允许从
DOM `getBBox()` 外扩:`getBBox()` 不含元素自身的 transform(旋转文字会画在锚点附近而错位),
且会把透明命中盒一起算进包围盒,使框变成没有依据的外扩装饰.

`itemBoundsMm(item, layout, measure?)` 从 `page` 块 + 本节 §5 公式推出纸张坐标(mm)里的
**未旋转声明框**(预览,导出,命中判定共用同一批函数;不再接收 geo,也没有 map 空间缩放):

```
text:    水平 = 锚点 anchor + 内容宽度
               内容宽度:自动折行的注记/来源 = `effectiveAutoWrapWidth`(折行宽度设置,先夹下限
               并收敛到 3 位小数);其它文字 = 各行前进宽度(measureText;CSS font 带
               font_size_mm/font-family/字重;字距按 letter_spacing_em × font_size_mm ×
               max(0, 字符数-1) 叠加)
         垂直 = 首行基线 − ascent − halfLeading .. 末行基线 + descent + halfLeading
                halfLeading = max(0, (font_size_mm × line_height − (ascent + descent)) / 2)
                ascent/descent 是 CSS font 的字体行盒:浏览器取 canvas
                fontBoundingBoxAscent/Descent;无 canvas(node 单测)按 0.8em/0.2em 回退
                (config PAGE_TEXT_FALLBACK_ASCENT_RATIO / DESCENT_RATIO)
                单行文字也随 line_height 变高:多行由 step = font_size_mm × line_height 展开行距,
                半行距把额外空间均分到首行上方与末行下方;行高小于字体行盒时 halfLeading = 0
         旋转 = §5.3 的 rotate(rotation_deg px py),pivot = 首行锚点 (px, py)
legend:  rect(x, y, width_mm, legendLayout().height)               // §5.4
colorbar:rect(x, y, width_mm, height_mm)                           // §5.5
```

- 所有 item 都只有纸张 mm 坐标(§4.1),几何框直接就是纸张坐标;不再有「map 空间缩放比 `s`」,
  图例/色标的框宽高就是 item 的 `width_mm`/`height_mm`,text 的字号与前进宽度也不乘任何缩放.
- **自动折行文字的横向框 = 折行宽度设置**:注记/来源的选中框宽度直接取
  `effectiveAutoWrapWidth`(与折行,侧栏读数同源),不从 `lines` 反推实际文字宽度.这样把
  「折行宽度(mm)」改大/改小,选中框立即跟着变宽/变窄,短文案也能看出可用的折行带宽;
  自动折行保证每行前进宽度 <= 该宽度,所以框始终包住文字.
- text 的垂直声明框按**行盒**计算:单行文字改大 `line_height` 时选中框随之变高,而不是只包住
  字体 ascent/descent;多行仍以 `step` 展开.
- **命中盒** = 声明框四周加 `PAGE_HIT_TOLERANCE_MM=0.7`(指针精度容差,只决定点击范围);
  **选中框** = 声明框原样,虚线/颜色/线宽只写在 `styles-page.css` 的 `.page-selection-box`.
- 两者都只在预览层出现,不进入成品;旋转 item 的框按同一 `rotate` 变换绘制,因此始终贴住
  文字块.

## 6. 最终 SVG(`render/compose-svg.ts` 输出)

```
<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="{paper.width_mm}mm" height="{paper.height_mm}mm"
     viewBox="0 0 {paper.width_mm} {paper.height_mm}" version="1.1">
<rect x="0" y="0" width="{paper.width_mm}" height="{paper.height_mm}" fill="{paper_color}"/>
<metadata id="mapdoc-source"><base64(canonicalJson({format,version,document,base}))></metadata>
<defs>
[<style type="text/css"><![CDATA[@font-face{...}]]></style>]   # 仅当导出时裁出了字体子集(§6.3)
<clipPath id="mapdoc-map-clip"><rect x="{vb[0]}" y="{vb[1]}" width="{vb[2]}" height="{vb[3]}"/></clipPath>
[<linearGradient id="mapdoc-cbar-{id}" ...>...stops...</linearGradient>]   # 仅当 page 块有 colorbar
</defs>
<g id="mapdoc-map" clip-path="url(#mapdoc-map-clip)" transform="translate({tx},{ty}) scale({s})">BASE_INNER</g>
<g id="mapdoc-frame"> rect + ticks + tick texts </g>
<g id="mapdoc-overlay"> items 按数组序 </g>
<!-- mapdoc-final:<base64(JSON)> -->\n
</svg>\n
```

- **根标签单位是 mm**:`width="<m>mm" height="<n>mm" viewBox="0 0 <m> <n>"`,其中 `<m>`/`<n>` 是
  纸张的 `width_mm`/`height_mm`(3 位小数去尾零);viewBox 不带单位,1 个用户单位 = 1mm.所有 item
  的坐标/字号/线宽直接写进用户单位(数值 = mm),不再有 pt 换算.
- `s = map.width_mm / geo.base.width_pt`(§5.1):map group 的 transform 把底图 viewBox 坐标映射到
  纸张 mm;`tx`/`ty` 让 `viewBox` 左上角对齐 `map.x`/`map.y`.

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
- **字体子集内嵌**(§6.3):导出时把成品里实际用到的字形从随包字体资产裁成子集,写成
  `<defs>` 开头的 `<style>@font-face</style>`;不传 `font_faces`(预览/测试/旧调用)时与旧口径
  一样只写 `font-family`,成品字节不变.自定义字体族没有可裁的资产,那部分只写 `font-family`.
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

### 6.3 字体子集内嵌(导出时按用到的字形裁字)

成品必须是「拿到别的机器上也不换字形」的:文字写成真 `<text>`(可复制/可再编辑),同时把用到的
字形裁成子集字体内嵌.载荷位置固定在 `<defs>` 的第一项:

```html
<style type="text/css">
  <![CDATA[
  /* 内嵌字体子集仅含本图用到的字形: JetBrains Mono Slashed (SIL OFL 1.1), Noto Sans Mono CJK SC (SIL OFL 1.1). */
  @font-face { font-family: "JetBrains Mono Slashed"; font-style: normal; font-weight: 400; src: url("data:font/ttf;base64,...") format("truetype"); }
  @font-face { font-family: "Noto Sans Mono CJK SC"; font-style: normal; font-weight: 400 700; src: url("data:font/otf;base64,...") format("opentype"); }
  ]]>
</style>
```

- **族名与 `font-family` 完全一致**:`@font-face` 的 `font-family` 必须逐字等于 `<text>` 属性里的
  族名(含引号写法归一),否则查看器按 CSS 字体匹配的语义会继续落到本机字体,内嵌白做.
- **字重**:拉丁侧三份静态面(400/600/700,与 miko_ui 随包 woff2 同源),按成品里出现的字重挑
  「最近的」一份;中文侧一份可变面(`wght` 400..700,`font-weight: 400 700`)通吃.`style.font_weight`
  允许 100..900,落在区间外时由查看器取最近的可用面.
- **斜体是合成倾斜**:两族都没有真斜体面,`font-style: italic` 由查看器倾斜合成(与旧 Python 实现
  同口径);内嵌只覆盖 regular 面.
- **载荷是子集,不是整族**:每份只含成品里实际出现的码点,典型页面几十 KB 量级;应用随包的
  字体资产(`src/assets/fonts/`,约 3.3 MB)只分发一次,不随每份成品走.

导出流程(`app/page-editor.ts` 的 `exportFinal`,实现见 `app/font-embed.ts`):

1. `composeFinalSvg(document, layout)` 先合成一份**不嵌字体**的草稿;
2. `render/used-text.ts` 的 `collectUsedText` 扫草稿里的 `<text>`:字符集(去重排序),`font-family`
   族名,`font-weight` 字重.为什么扫成品而不是扫数据:文字来自 text item/地图地名/图例条目/
   色标刻度/图框刻度等多个来源,扫已画出来的字等于「以实际用到的字为准」,不漏也不多带;
3. `render/embedded-font.ts` 的 `selectFontAssets` / `customFamiliesOf` 决定要嵌哪些面,哪些族
   嵌不了(自定义字体串),后者计入告警;
4. `render/hb-subset.ts` 用 harfbuzz 的 `hb-subset`(wasm)逐个面裁字;资产是 sfnt(TrueType/OTF),
   不接受 woff/woff2 容器(harfbuzzjs 的 wasm 没编 brotli);
5. 带上 `font_faces` 再 `composeFinalSvg` 一次,写进 `<defs>` 开头.

**降级**:wasm/资产加载失败,裁字失败或没有任何可嵌资产时,返回空 `font_faces` + 中文告警,
成品退回「只写 `font-family`」的旧口径(用户看得到告警,失败不给坏字节).

**覆盖范围**(预裁资产的边界,见 `scripts/build_font_assets.py`):拉丁侧覆盖基本拉丁,拉丁补充/
扩展,常用标点,货币,字母式,数字形式,箭头,数学算符,带圈数字,几何图形,杂项符号,CJK 标点,
CJK 兼容形式,全角形式;中文侧覆盖 GB2312 全集(汉字 6763 + 符号 682).**覆盖不到的字符不内嵌**,
那些字在查看端仍按 `font-family` 栈落到本机字体(可能换字形,与 v2 行为一致);要扩覆盖就改
脚本里的字符区间并重跑(需要 fontTools 与系统安装的 Noto Sans Mono CJK VF).

**确定性**:同一份字体资产 + 同一 `harfbuzzjs` 版本 + 同一份字,子集字节可复现(测试断言两次裁字
完全相同).换 harfbuzz 版本不保证与旧成品逐字节相同--这是「字体内嵌」引入的新口径,§6.2 的
「成品 -> 重开 -> 再导出字节幂等」只在同一构建下成立;`marker`/`pageDigest`/内嵌可编辑源都不含
字体载荷,所以再编辑与摘要校验不受影响.

**相关文件**:`app/font-embed.ts`(浏览器侧编排),`render/hb-subset.ts`(wasm 绑定),
`render/used-text.ts`(字符集/族/字重扫描),`render/embedded-font.ts`(选面 + CSS),
`src/assets/fonts/`(预裁资产 + OFL 许可),`scripts/build_font_assets.py`(重建资产);
测试见 `tests/render/hb-subset.test.ts` / `used-text.test.ts` / `embedded-font.test.ts` /
`compose-fonts.test.ts`.

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
5. `page` 块(可选):`page` 键存在 -> 先看是不是**旧 pt 口径 page 块**(`paper` 用
   `width_pt`/`height_pt`,或 item 带 `space`/`*_pt` 字段):是 -> **静默**改用 `defaultPageLayout`
   (标脏,不告警:用户已确认不向后兼容,旧文件不迁移);否则 `validatePage(raw, geo)`,通过则
   `normalizePage` 作当前排版;不合法(缺 `paper.locked`/`margin`;text item 缺 `geo_label_id`/id 不在
   `geo.labels` 里,手动页面文字的 `geo_label_id` 不是 `null`,`center_h` 缺失/非布尔,地图地名的
   `center_h` 为 `true`,margin 有负值等)-> 告警并改用 `defaultPageLayout`;缺省 ->
   `defaultPageLayout`(后两者都标脏).**旧 pt page 块不迁移,不向后兼容**:没有「按旧字段补默认值再
   打开」的分支.**排版确定后统一按分类重建每条文字样式**(`core/text-style.ts` 的 `resyncTextStyles`):
   - 颜色/斜体/字重/字距/行高/光晕以分类覆盖为准;地图分类字号强制统一(覆盖 ?? 中位数 × `s`),
     页面分类字号按「覆盖 ?? 该分类现有 item 的字号 ?? 固定默认字号」回退--页面默认字号固定,
     不随纸张缩放;item 里已有的字号优先保留,重建不会误改;
   - 若文件里存的逐条样式与上述口径不一致:覆盖并标脏,并告警「旧排版中的逐条文字样式已按分类
     设置统一(N 条),导出后会写成新口径」;
   - 默认排版本身与分类口径一致,重建通常不产生改动.
     重建完成后执行 `enforceHorizontalCenter`(§4.1):手改过的 `center_h=true` item 的 `x`/`anchor`
     被纠回纸张中心;有改动则标脏并追加独立告警「排版中的左右居中约束已按纸张宽度重新贴合(N 条),
     导出后会写成新口径」(与样式重建分开,用户能分清是哪一步改了排版).最后统一 `normalizePage`,
     数值口径与导出/签名完全一致.底图身份只在 `geo.base`,不再有「排版记录的底图与本次上传不一致」
     的分支.
     另执行一次 `enforceAutoWrap`:注记/来源的 `text`/`wrap_width_mm` 缺省(例如手写的 page 块只
     给了 `lines`)时补默认换行宽度并按当前字号重算 `lines`,有改动标脏并告警;`text`/`wrap_width_mm`
     本身是可选字段,这条与「旧 pt page 块不兼容」无关.
6. 打开后状态:带合法 `page` 块 -> 干净(路径 1「已载入 geo.json 中的排版...」;路径 2
   「已从成品 SVG 恢复排版;Ctrl+S 导出 geo.json」);样式被分类设置重算过或居中约束被纠偏过
   -> 脏;否则默认排版 -> 脏(「已生成初始排版...」).

错误语义汇总(文案以 `core/open-map.ts` / `app/page-main.ts` 为准):没有收到文件 / 不识别的文件 /
缺少或重复的 SVG / 多于一个 geo / 文件不是 UTF-8 / 不是合法 JSON / `format` 不是 `mapdoc-geo` 或
`version` 不是 2(旧 v1 geo / 旧 `scene.json` 走这条)/ 底图不符合契约(列出前几条 C1–C4)/ geo 校验失败
(列出前几条)/ sha256 不一致 / viewBox 不一致 / 尺寸不一致 / 成品缺少内嵌可编辑源(旧版成品不再支持,
提示重新导入导出)/ 成品内嵌源不可用 / 成品与所选 geo 不配套(marker 摘要不一致)/ page 块不合法
(缺 `paper.locked`/`margin`;缺 `geo_label_id`,缺 `center_h` 或地图地名 `center_h=true`,改用默认排版
并告警;旧 pt page 块走单独分支:静默回退,不算错误).

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
                                #   每次排版修改后执行 enforceHorizontalCenter/enforceAutoWrap,
                                #   地图摆放变化时 remapMapLabelItems 整批搬移地图地名;
                                #   页边距输入聚焦时 setMarginGuide 打开内容框高亮;
                                #   exportGeo()/exportFinal()/destroy()
src/config/page.ts              # 格式标识,上传 accept,校验容差,纸张预设(mm),页边距默认值,
                                #   默认排版内缩/字号/间距常量(mm),长度范围,纸张比例系数 layoutScaleForPaper,
                                #   交互步长/命中容差(mm)
src/config/text-style.ts        # 文字样式常量与分类元信息(role 颜色表,页面文字默认字号(mm),
                                #   20 个分类 = 6 页面文字 + 14 地图地名 与两组顺序;样式唯一真源;
                                #   分类描述 description / 示例 example / 语义小标题 section)
src/core/base-svg.ts            # 底图契约 C1–C4 + 根标签内原文切片 inner/prefix/suffix(纯逻辑)
src/core/open-map.ts            # 两条打开路径:分栏 -> 校验 -> PageDocument + 初始排版(纯逻辑);
                                #   打开时按分类重建文字样式(resyncTextStyles)并贴合居中约束;
                                #   旧版成品(无内嵌可编辑源)直接拒绝
src/core/final-svg.ts           # 成品 SVG 再编辑:内嵌源读取,mapdoc-map 定位,底图逐字节还原(纯逻辑)
src/core/base64.ts              # 内嵌源 / marker 的 UTF-8 base64 编解码(纯逻辑)
src/core/document.ts            # PageDocument,createPageDocument,上传文件分类,导出文件名(纯逻辑)
src/core/page.ts                # geo/page 类型,normalize/validate,paper.locked/margin,text item 的
                                #   center_h 与 enforceHorizontalCenter,canonicalJson,sha256OfBytes,
                                #   serializeMapDocFile,geoDigest/pageDigest(纯逻辑,node 可测)
src/core/page-layout.ts         # §5 全部布局公式 + defaultPageLayout(可选块降级,按 text_style 出样式,
                                #   地图分类统一字号,title/subtitle/source 默认居中,页边距不参与版式),
                                #   mapTransform/remapMapLabelItems,itemBoundsMm
src/core/text-style.ts          # 分类文字样式:item->分类,分类有效样式与默认统一字号解析,
                                #   覆盖表批量写回 item,整分类/单字段恢复默认,打开时按分类重建逐条样式(resyncTextStyles)
src/render/page-svg.ts          # 预览 SVG DOM(纸张/底图 image/图框刻度/items/页边距高亮层)
src/render/compose-svg.ts       # 浏览器内合成 final.svg(纯函数:结构/marker/内嵌源/report;根标签 mm)
src/render/page-format.ts       # 数字格式化,颜色/转义,SVG 属性 helper
src/ui/page-open.ts             # 上传面板(SVG / JSON 两栏各自选择 + 打开按钮 + 错误文案)
src/ui/page-sidebar.ts          # 右侧属性面板编排:面板壳 / sync / 元素列表 / 选中项重建
src/ui/page-sidebar-context.ts  # 面板模块与侧栏状态的唯一契约(PageSidebarHandlers / SidebarContext,
                                #   含 onMarginGuideChange)
src/ui/page-sidebar-controls.ts # 控件登记表(数字/颜色/文本/开关/分段 + 未聚焦控件回写)
src/ui/page-panel-paper.ts      # 「页面」面板:纸张锁 + 预设/方向/宽高 + 页边距(聚焦边距输入时高亮
                                #   内容框);改纸张不移动已放置元素
src/ui/page-panel-map.ts        # 「地图」面板:摆放(mm)/派生高度/图框/刻度样式
src/ui/page-fields-common.ts    # 元素公共字段:x/y(mm)+ 页面文字「左右居中」开关(x/y 正下方;
                                #   开启时 x 冻结并置灰);没有「坐标空间」控件
src/ui/page-fields-text.ts      # 文字字段:内容/角色(仅页面文字)/对齐/旋转 + 「打开样式设置」入口
                                #   (带当前分类);地图地名 item 显示指向地图分类的只读样式说明;
                                #   左右居中开启时对齐分段禁用
src/ui/page-fields-legend.ts    # 图例字段 + 条目增删/显隐(隐藏 = 移出 layout,会话内记住)
src/ui/page-fields-colorbar.ts  # 色标字段:标题/单位/宽高/字号/显示开关
src/ui/page-toolbar.ts          # 顶部工具条(文件/添加/样式/视图四组;「样式设置」按钮;1:1 = 1mm/px)
src/ui/page-style-window.ts     # 「样式设置」模态窗口:头部总说明 + 左列两组分类(语义小标题/数量徽标/
                                #   已改标记/地图 0 项置灰)+ 右列分类头(影响数量/默认·已改·排版值/
                                #   示例/恢复默认(有覆盖或排版值时可用)/实时预览)+ 四组字段
                                #   (字号/颜色与字形/行距与字距/描边光晕);字号/行高/字距/光晕宽度旁
                                #   各有字段级 reset(删该字段覆盖回默认,已是默认时禁用)
src/ui/page-notify.ts           # 消息区(miko_ui MessageArea + 简单确认框)
src/ui/download.ts              # downloadText(保存对话框优先,<a download> 回退)/ downloadSvg
src/styles-page.css             # 本页样式(.page-*;含 .page-margin-box/.page-margin-band;token 复用
                                #   miko_ui/styles.css 与 styles.css)
tests/core/page.test.ts         # codec/校验/布局公式,paper.locked/margin,center_h 与 enforceHorizontalCenter
tests/core/page-bounds.test.ts  # itemBoundsMm 几何框(纸张 mm,无 map 空间缩放)
tests/core/text-autowrap.test.ts # enforceAutoWrap/effectiveAutoWrapWidth(页边距回退宽度)
tests/core/fonts.test.ts        # 全项目字体栈:TS 常量与 styles.css 的 --font-family-base 一致
tests/core/text-style.test.ts   # 分类映射,覆盖解析,批量应用/恢复默认,resyncTextStyles
tests/core/base-svg.test.ts     # 底图 C1–C4 与 inner/prefix/suffix 切片
tests/core/base64.test.ts       # UTF-8 base64 往返与坏数据
tests/core/final-svg.test.ts    # 内嵌源读取,底图逐字节还原
tests/core/open-map.test.ts     # 两条打开路径,成品往返字节幂等,旧版成品拒绝,旧 pt page 块回退默认,错误文案
tests/core/page-geo.test.ts     # normalizeGeo / digest / serializeMapDocFile
tests/render/compose-svg.test.ts # 合成结构(mm 根标签),marker,内嵌源,确定性,越界 report
```

`core`/`render` 不碰 DOM;`ui` 只用 miko_ui 与标准 DOM;组合与事件只在 `app`.新文件都按仓库
中文注释三分类(是什么/为什么/元信息)写注释.

**交互(基础可用即可,不做撤销/多文档)**

- **打开**:初始显示上传面板;在 SVG 栏与 JSON 栏里分别选/拖 `base.svg`,`geo.json`(JSON 可省略),
  或只选一份本编辑器导出的成品 SVG,点「打开地图」-> §8.2 校验 -> 生成 `PageDocument` -> 装配界面.
  带合法 `page` 块(或成品内嵌源)则恢复排版,并按分类重建每条文字样式,贴合左右居中约束,
  再执行一次注记/来源自动折行(缺
  `text`/`wrap_width_mm`(可选字段)时补齐并告警,§4.1)
  (颜色等与分类不一致会覆盖;页面分类字号保留排版里的现值;有改动则标脏,告警);否则用
  `defaultPageLayout` 生成初始排版(标脏).没有内嵌可编辑源的旧版成品直接拒绝;旧 pt page 块
  校验失败后同样回退默认排版.
- **画布**:一个 SVG(viewBox 随缩放/平移变化).纸张白底 + 底图 `<image href=objectURL>`
  (放在 map 矩形)+ 图框/刻度 + items.滚轮以指针为中心缩放,空格/中键拖动平移,
  「适应页面」/「1:1」按钮;「1:1」= 1mm 纸张对应 1 屏幕像素(不是 1pt).
- **选择与编辑**:点 item 选中(选中框 = §5.7 的声明几何框,随 `rotation_deg` 旋转;注记/来源
  的横向框显示「折行宽度(mm)」;外观在 `styles-page.css`);拖拽移动直接写回纸张 mm(`x`/`y`),
  按住 Shift 锁定到位移更大的轴;
  方向键 0.5mm 微移(Shift 5mm);Delete 删除(title 等也允许删);双击文字 item -> 侧栏内容框聚焦.
  **左右居中约束**:页面文字的「左右居中」开关在侧栏 x/y 正下方(`center_h`);开启时 x 数字框
  冻结并置灰,x 行变灰,显示说明「水平位置由纸张宽度决定(拖拽只改垂直位置)」,对齐分段也禁用;
  拖拽/方向键只改 y.关闭开关后 x 恢复可编辑并保持当前 x/anchor,重新可水平移动.地图地名 item
  不显示该开关(地图地名 `center_h` 恒 `false`).
  选中文字时侧栏显示**x/y(含居中开关)/ 内容 / 角色(仅页面文字)/ 自动换行(注记/来源)/
  对齐 / 旋转**:注记与来源多一组「自动换行」--文本域编辑原始内容,数字字段「折行宽度(mm)」改宽度后
  立即按新宽度重排(最小 7mm);文本域里的手动换行保留为强制分段.
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
    该分类全部 item;地图分类只有一个「字号(mm)」数字,改任意字段(哪怕只改颜色)都会把该分类
    全部地名统一到窗口值.字号/行高/字距/光晕宽度四个数字字段旁各有 reset 按钮:点它删除该字段
    覆盖,恢复代码默认值(不是把默认值写成覆盖),字段值已是默认时禁用;页面分类字号写回固定
    默认值,地图分类字号回到分类默认统一字号(该分类地名原始字号中位数 × 地图缩放),光晕宽度
    只重置宽度,保留当前颜色.分类头「恢复「X」默认值」仍保留,用于整分类恢复.
  - 关闭方式:头部「关闭」按钮,`Esc`,点遮罩(窗口不设底部操作条);窗口打开时焦点进面板,关闭后归还打开前的
    焦点.窗口读写最新 layout/geo,与当前文档同生命周期(换文档时销毁);外部 `sync` 就地刷新数值,
    分类头,左列徽标与预览,跳过聚焦中的控件(数字输入不被打断),光晕开关只切换颜色/宽度的
    可用性而不重建字段.
- **侧栏**:页面(纸张锁开关;预设/方向/宽高,锁上后这三项禁用灰显,只留锁开关可解锁;页边距
  上/右/下/左(mm),边距输入框聚焦时预览画布显示内容框虚线与外侧边距带,失焦隐藏;底部说明
  「纸张尺寸与元素位置都以 mm 落盘;页边距只是版心参考(编辑时高亮内容框),不会移动已放置元素」;
  改纸张不移动已放置元素,状态行提示「纸张已改变:已放置元素位置不变,可拖拽或改 x/y 调整」),
  地图(x/y/宽(mm),图框开关/刻度开关/线宽/颜色/刻度字号),
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
3. `final.svg` 不变量:根标签 `width="<m>mm" height="<n>mm" viewBox="0 0 <m> <n>"`(1 用户单位 =
   1mm),`<m>`/`<n>` 等于纸张 mm;`<g id="mapdoc-map">` 内是底图内容
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
   统一字号,`page.text_style` 里该分类的 `font_size_mm` 覆盖键消失;行高/字距/光晕宽度同理
   (光晕宽度只重置宽度,保留颜色),字段值已是默认时按钮禁用.导出 `geo.json` 含
   `page.text_style`(只出现用户设过的分类/字段);重新打开该 geo.json 样式原样恢复;改纸张尺寸/
   方向不会丢掉分类样式.侧栏选中单条文字显示 x/y(mm)(含「左右居中」开关)/内容/角色/
   对齐/旋转,没有字号/颜色等字段;注记/来源另显示「折行宽度(mm)」;切换页面文字角色后该条立即套用
   新分类样式.**反例**:旧 pt page
   块(缺 `paper.locked`/`margin`,或仍用 `*_pt` 字段)校验不合法 -> 告警并回退默认排版;带合法
   page 块但逐条样式与分类覆盖不一致 -> 打开时按分类覆盖,标脏并告警「旧排版中的逐条文字样式已按
   分类设置统一(N 条)」.
10. **左右居中约束**:默认排版里标题/副标题/来源 `center_h = true` 且 x = 纸张中心;改大/改小
    纸张宽度或切换方向 -> 三条仍水平居中(x 跟随纸张中心,anchor=middle),不需要重排.单条
    选中标题:开启「左右居中」时侧栏 x 输入框冻结并置灰,对齐分段禁用,只能上下移动;关掉开关
    后 x 恢复可编辑,对齐分段恢复可用,可水平拖动/方向键移动;再打开开关 -> 立即回到中心.地图
    地名 item 不显示该开关.导出的 geo.json 里 `page.items[]` 带 `center_h` 与居中 x;手改该
    标题的 `x`/`anchor` 后重新打开 -> 纠回纸张中心,标脏并告警「排版中的左右居中约束已按纸张宽度
    重新贴合(N 条)」;再导出并重新打开 -> 干净(幂等).
11. **页面字号固定与旧排版「排版值」**:页面文字(标题/副标题/注记/来源)默认字号固定为
    6.35/3.175/2.646/2.469mm,改变纸张宽/方向不会改变它们;导出 -> 重新打开字号一致,状态干净
    (不标脏,不出现「逐条文字样式已按分类设置统一」告警),再次导出字节一致.打开保留了非固定
    字号的 page 块(例如 4mm 标题)时:样式设置分类头显示「排版值」,恢复默认可用;
    点击后状态回到「默认」,字号写回当前固定默认值(标题 6.35mm),画布字号随之变化.地图分类字号
    仍恒为「覆盖 ?? 中位数 × `s`」.
12. **排版值状态**:页面分类无覆盖,当前字号与固定默认字号不同 -> 分类头状态显示「排版值」,
    「恢复「X」默认值」可用;点击后状态回到「默认」,字号变为固定默认值.地图分类无覆盖时仍显示
    「默认」且恢复按钮禁用;「排版值」不会点亮左列的「已改」标记.
13. **选中框行盒**:选中单行文字,把「行高」从 1 改到 2 -> 选中框上下沿随行高变高(半行距
    `halfLeading` 均分到上下),命中框同步变化;旋转文字的框仍按同一 `rotate` 变换贴住文字块.
14. **注记/来源自动折行**:选中注记,把内容改成一长段(不敲回车)-> 超出「折行宽度(mm)」后自动拆成
    多行,画布/导出都在该宽度内折行,侧栏文本域仍显示原始一长段;把折行宽度改小 -> 行数变多,
    改回原值 -> 恢复原分行(原始内容没被拆断).内容里敲回车 -> 保留为强制分段.改注记分类字号/
    字距 -> 自动重排.导出 geo.json 带 `text`/`wrap_width_mm`;重新打开 -> 状态干净,字节一致.
    **选中框宽度 = 折行宽度**:选中注记/来源,把「折行宽度(mm)」从 50 改到 100 -> 选中虚线框
    立即变宽到 100(左/中/右锚点分别从锚点向右/居中/向左展开),与内容长短无关;把内容改短
    (如「注:短文案」)-> 框仍按 100 显示,不缩回文字宽度.`wrap_width_mm` 缺省时(例如手写的
    page 块只给出 `lines`),框与面板读数都按同一回退宽度(`effectiveAutoWrapWidth`)显示.
    选中页底来源(默认居中)把内容改长 -> 同样按内容宽折行,最后一行仍贴住页底边距(块向上长),
    不会画到纸面外;改折行宽度/字号也重排.反例:手改 `lines` 与原始内容不一致 -> 打开时按宽度
    重排,标脏并告警「排版中的注记/来源已按折行宽度自动重排(N 条)」;把 `wrap_width_mm` 放到
    标题/地图地名上 -> page 块校验不合法并回退默认排版.
15. **页边距**:页面面板的页边距上/右/下/左(mm)都可编辑;聚焦任一输入框时预览画布出现内容框虚线
    与外侧边距带(`.page-margin-box`/`.page-margin-band`),失焦隐藏;四边值写进导出的
    `page.margin`,重新打开原样恢复.改页边距**不移动已放置元素**:元素位置只由各自 x/y 决定;
    页边距只影响两处次要计算--自动折行回退宽度(按 `margin.left/right` 推可用宽度)与来源折行时
    的页底兜底(`margin.bottom`).负值/非有限值被校验拒绝,超纸张的值由 `normalizePage` 夹到纸张内.
16. **纸张锁**:勾选「锁定纸张尺寸」后,页面面板的预设/方向/宽高全部禁用灰显,只留锁开关可解锁;
    页边距不受锁影响,仍可编辑.导出 geo.json 里 `paper.locked: true`;重新打开该 geo.json(或成品
    SVG)仍保持锁定与冻结状态;解锁后三项恢复可编辑.锁定时拖拽/方向键仍可移动元素,改纸张尺寸
    仍不移动已放置元素.
17. **单坐标空间**:导出的 `page.items[]` 没有 `space` 字段;侧栏没有「坐标空间」分段控件;所有
    item 的 x/y 都是纸张坐标(mm,原点 = 纸张左上角).移动/缩放地图时,`geo_label_id` 非 null 的
    地图地名按新旧地图变换整批跟随,手动页面文字不动;`geo_label_id` 仍是地图分类/样式归属真值.
18. **mm 输出**:导出的 `final.svg` 根标签是 `width="<m>mm" height="<n>mm" viewBox="0 0 <m> <n>"`;
    预览与成品的坐标/字体大小/线宽数值都按 mm 写进用户单位(同一套 §5 公式),预览画面与成品
    几何一致.

## 11. 非目标与已知限制

- **字体内嵌覆盖有限**:成品按用到字形裁子集内嵌(§6.3),但预裁资产只覆盖 GB2312 + 拉丁/符号
  区间,覆盖不到的字符与自定义字体族仍按 `font-family` 落到本机字体(可能换字形,印刷前仍建议在
  Inkscape/AI 里转曲);斜体是查看器合成倾斜,不是真斜体;中文可变面只到 700 字重,更粗的字重按
  最近面渲染.
- **字体栈是项目级设置**:界面,预览与成品统一用 `'JetBrains Mono Slashed'`(拉丁)+
  `'Noto Sans Mono CJK SC'`(中文兜底),唯一真源 `config/fonts.ts` 的 `FONT_FAMILY_STACK`
  (界面侧由 `styles.css` 的 `--font-family-base` 覆盖 miko_ui 默认值).本编辑器不提供逐文档
  字体选择:文件里的 `font_family` 原样沿用,手改的自定义字体串保留但不参与界面口径.
- **自动换行覆盖页面注记与来源**:标题/副标题/标注/地名(手动)仍只在默认排版时按宽度折一次
  写进 `lines`,之后改内容/字号不会重排;地图地名按底图给的分行渲染.来源的折行按「页底说明」
  口径:最后一行保持贴住页底边距.**不做两端对齐**;字距按 item 的 `letter_spacing_em` 渲染并
  参与注记/来源折行测量.
- **文字样式按分类统一覆盖**:单条 item 没有独立样式字段(侧栏只留内容/角色/对齐/旋转),改样式
  只能在「样式设置」窗口按分类改,一次应用到该分类全部 item;要单条不同只能换角色/分类.
  **分类样式是唯一真源**:打开带 `page` 块的排版后会按分类重算每条 text item 的样式
  (`resyncTextStyles`);颜色/斜体/字重/字距/行高/光晕以分类覆盖为准,地图分类字号强制统一,
  页面分类字号按「覆盖 ?? item 现值 ?? 固定默认」保留(固定默认字号不会覆盖 item 里已有的字号).
  逐条样式与分类口径不一致会被覆盖,标脏并告警「旧排版中的逐条文字样式已按分类设置统一(N 条)」;
  **旧 pt page 块不再兼容**:仍用 `*_pt`/`space` 字段的排版被静默忽略并回退默认排版(不迁移,
  不补默认值,不告警);缺 `paper.locked`/`margin` 但无旧字段的排版校验不合法,会告警并回退.
  **地图标注按分类强制统一字号**,不能逐条保留底图字号层级.
- **页面文字字号固定**:标题/副标题/注记/来源默认 6.35/3.175/2.646/2.469mm,不随纸张尺寸缩放;
  排版里已有的其它字号显示为「排版值」,点「恢复默认」写回固定默认值.
- **页边距只是版心参考**:`page.margin` 四边(mm)不参与排版计算,不移动已放置元素,只用于编辑时
  高亮内容框与两处次要计算(自动折行回退宽度,来源折行页底兜底).默认四边 0.
- **纸张锁**:`paper.locked` 冻结「页面」面板的预设/方向/宽高(落盘,重新打开仍锁定);页边距
  不受锁影响.锁不是排版约束,只是防止排版过程中误改纸张.
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
