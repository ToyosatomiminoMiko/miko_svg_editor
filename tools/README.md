# tools/ —— 出版排版数据链路（纯底图 / geo / scene / compose / studio）

本目录只依赖系统 `python3`（3.14，标准库），不需要虚拟环境、不联网、不装包。

契约唯一入口：[`docs/PAGE-EDITOR.md`](../docs/PAGE-EDITOR.md)。字段、布局公式、HTTP 端点都在那里；
本文件只讲怎么跑、模块怎么分工、产物落在哪。

## 跑法

```bash
# 0) 准备 demo：从只读的 Cartopy 成品 SVG 剥离出纯底图 + geo.json
python3 tools/prepare_demo.py

# 1) 单测（unittest；从仓库根目录执行）
python3 -m unittest discover -s tools/tests -t tools

# 2) 契约自检（纯底图 C1–C4 + geo + 真实 compose + marker/确定性）
python3 tools/check_contract.py

# 3) 起服务（配置读 tools/studio.toml，不接受命令行参数；监听 [studio].port）
python3 tools/studio.py
```

浏览器打开 `http://127.0.0.1:5173/`（studio 自己服务 `dist/` 的出版排版编辑器 `map.html`），
草图编辑器在 `http://127.0.0.1:5173/sketch`。

开发期不用开两个终端：`npm run dev` / `npx vite` 监听同一个站点端口（5173，值来自
`tools/studio.toml`，`strictPort`：被占就报错），并顺带用 `python3 tools/studio.py` 拉起 studio；
studio 自己改用 Vite 在回环上现取的一个内部空闲端口（通过 `MAPDOC_STUDIO_PORT` 注入，不写进
任何配置文件），`/api`、`/base.svg`、`/final.svg`、`/geo.json` 由 Vite 代理过去。页面在
`http://localhost:5173/map.html`。`MAPDOC_PYTHON` 可以指定解释器（默认 `python3`）。

两项启动期覆盖（环境变量优先于 TOML，只在进程启动时读，不是配置文件的替代）：

- `MAPDOC_STUDIO_PORT`：覆盖 `[studio].port`（`0` 表示系统分配），只对独立运行的 studio 有意义；
  开发期该变量由 Vite 注入内部端口，外部设置会被覆盖，否则代理目标会和后端错开。
- `MAPDOC_OPEN_BROWSER`：`1`/`true` 或 `0`/`false` 覆盖 `[studio].open_browser`；Vite 插件会传
  `0`，避免开发期再弹一个浏览器页。

## 产物布局（`demo/` 整个目录被 gitignore）

```
demo/figures/Volga/
  volga_basin_topography_etopo2022_lambert_conformal.svg         # final：compose 覆盖写
  volga_basin_topography_etopo2022_lambert_conformal.geo.json    # geo：prepare 写，只读
  volga_basin_topography_etopo2022_lambert_conformal.scene.json  # scene：studio 写（前端真值）
  .build/volga_basin_topography_etopo2022_lambert_conformal.base.svg  # 纯底图（冻结）
  .build/volga_basin_topography_etopo2022_lambert_conformal.lock      # fcntl.flock
```

- `final = figure_svg`；`scene = final 去后缀 + .scene.json`；`geo = final 去后缀 + .geo.json`；
  `base = final.parent / base_dir / (stem + ".base.svg")`，全部由 `tools/studio.toml` 的图路径派生。
- `prepare_demo.py` 幂等：base/geo 永远由只读源 SVG 重新派生（内容相同则磁盘字节不变）；
  不碰 scene/final。
- 底图是**纯地图**：没有任何 `<text>`、标题/图例/色标/图框/画布白底；viewBox 裁到地图框。
  所有文字与图例都在 `scene.json` 里，由前端编辑、Python 合成。

## 模块

| 文件                 | 职责                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- |
| `mapdoc/contract.py` | 底图契约 C1–C4、SVG 切分（inner 字节区间）、sha256、final marker 编解码             |
| `mapdoc/extract.py`  | 成品 SVG → (纯底图 bytes, geo dict)；字符串手术删非地理层，ElementTree 只读抽 geo   |
| `mapdoc/geo.py`      | geo.json 读取/校验/typed 访问（地图框、经纬网刻度、标注候选、配色、图例样式）       |
| `mapdoc/page.py`     | scene.json v1 的数据类/校验/规范化/digest/派生地图高度                              |
| `mapdoc/render.py`   | scene + geo → 排版层 SVG 字符串（文字/图框/刻度/图例/色标；与前端布局公式逐条镜像） |
| `mapdoc/compose.py`  | base + 排版层 → final SVG（加锁、原子写、marker、确定性字节）                       |
| `mapdoc/fsutil.py`   | 非阻塞 `fcntl.flock` 与 `.tmp + os.replace` 原子写                                  |
| `studio.py`          | 127.0.0.1 HTTP 服务：doc/geo/scene/compose、静态文件、请求体 ≤2 MB                  |
| `prepare_demo.py`    | 只读源 SVG → `.build/base.svg` + `geo.json`（一次性适配器）                         |
| `check_contract.py`  | 契约自检 CLI（含真实 compose 的确定性/内联/marker 实测）                            |

## Cartopy 侧的未来契约

当前轮不改 Cartopy 仓：`extract.py` 从现有成品 SVG 里按结构剥离（地图 axes 保留、图例/色标/
标题/记注/刻度文字/白底删除），并从原图抽取 `geo.json`。未来渲染侧只要直接输出：

1. `<stem>.base.svg`：满足 `contract.read_base` 的纯地图，viewBox 裁到地图框；
2. `<stem>.geo.json`：`docs/PAGE-EDITOR.md` §3 的字段（地图框、经纬度刻度、地名候选、
   relief 色标、legend 样式、文案建议）。

`prepare_demo.py` 就会退化成「复制 + 校验」，前端与合成侧无需改动。

## HTTP 端点速查

```bash
curl -s 'http://127.0.0.1:5173/api/doc' | python3 -m json.tool
curl -s 'http://127.0.0.1:5173/api/geo' | python3 -m json.tool
curl -s 'http://127.0.0.1:5173/api/scene'
curl -s -X POST 'http://127.0.0.1:5173/api/compose'
curl -s 'http://127.0.0.1:5173/final.svg' | head -c 200
```

`PUT /api/scene` 的语义体见 [`docs/PAGE-EDITOR.md`](../docs/PAGE-EDITOR.md) §4/§8；
锁竞争时返回 200 `{saved:true,composed:false,code:"rendering"}`。

## 已知限制（本轮）

- 文字字体不内嵌：`final.svg` 用 `font-family` 引用本机字体；跨机器字形可能变化，印刷前在
  Inkscape/AI 里转曲。
- `extract.py` 依赖 Cartopy 当前 matplotlib SVG 结构（`figure_1/axes_1` 等 id 与
  `label-*` 命名）；结构换了要同步改抽取规则。
- 不做换行/字距调整：换行由前端按宽度折好写进 `lines`。
