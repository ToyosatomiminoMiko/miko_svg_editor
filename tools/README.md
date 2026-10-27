# tools/ —— mapdoc Python 侧（scene / overlay / compose / studio）

本目录只依赖系统 `python3`（3.14，标准库），不需要虚拟环境、不联网、不装包。

## 跑法

```bash
# 0) 准备 demo：从只读的 Cartopy 仓复制 Volga 成品 SVG，生成冻结底图
python3 tools/prepare_demo.py

# 1) 单测（unittest；从仓库根目录执行）
python3 -m unittest discover -s tools/tests -t tools

# 2) 契约自检（底图 C1/C3/C6/C8 + 空场景 compose 的 I1/I2 + 已有 final 的 marker）
python3 tools/check_contract.py

# 3) 起服务（配置读 tools/studio.toml，不接受命令行参数；只监听 127.0.0.1:8791）
python3 tools/studio.py
```

浏览器打开 `http://127.0.0.1:8791/`（studio 自己服务 `dist/`）。

开发期不用开两个终端：`npm run dev` / `npx vite` 启动时会先探活，已有 studio 就直接复用，
没有就用 `python3 tools/studio.py` 拉起一个，Vite 退出时一起结束；页面在 Vite 上，
`/api`、`/base.svg`、`/final.svg`、`/overlay.svg` 由 Vite 代理到 studio。
`MAPDOC_PYTHON` 可以指定解释器（默认 `python3`）。

两项启动期覆盖（环境变量优先于 TOML，只在进程启动时读，不是配置文件的替代）：

- `MAPDOC_STUDIO_PORT`：覆盖 `[studio].port`（`0` 表示系统分配）；Vite 的代理目标也读它，
  所以用这个改端口时前后端仍然对齐。
- `MAPDOC_OPEN_BROWSER`：`1`/`true` 或 `0`/`false` 覆盖 `[studio].open_browser`；Vite 插件会传
  `0`，避免开发期再弹一个 8791 的旧 `dist` 页面。

## 产物布局（`demo/` 整个目录被 gitignore）

```
demo/figures/Volga/
  volga_basin_topography_etopo2022_lambert_conformal.svg        # final：compose 覆盖写
  volga_basin_topography_etopo2022_lambert_conformal.scene.json # scene：studio 规范化写
  .build/volga_basin_topography_etopo2022_lambert_conformal.base.svg  # 冻结底图
  .build/volga_basin_topography_etopo2022_lambert_conformal.lock     # fcntl.flock
```

- `final = figure_svg`；`scene = figure_svg` 去掉 `.svg` 加 `.scene.json`；
  `base = figure_svg.parent / base_dir / (stem + ".base.svg")`，全部由 `tools/studio.toml` 的图路径派生。
- `prepare_demo.py` 幂等：final 已存在时不覆盖（可能已含 marker/叠加层），base 永远由只读源字节原子重写。

## 模块

| 文件                 | 职责                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `mapdoc/contract.py` | 底图 C1/C3/C6/C8 检查、viewBox 解析、sha256、final marker 编解码                          |
| `mapdoc/scene.py`    | scene v1 数据类/校验/规范化字节/digest/引用检查/空场景                                    |
| `mapdoc/overlay.py`  | scene → 叠加层字符串（单 `<g>`、3 位小数去尾零、整圆弧→`<circle>`、BUG-1 跳过、越界报告） |
| `mapdoc/compose.py`  | flock + 读 base + 校验 + 字符串拼接 + marker + 原子写 + report                            |
| `mapdoc/fsutil.py`   | 非阻塞 `fcntl.flock` 与 `.tmp + os.replace` 原子写                                        |
| `studio.py`          | 127.0.0.1 HTTP 服务：API、静态白名单、请求体 ≤2 MB、no-store                              |
| `prepare_demo.py`    | 只读源 → `demo/`（final 初始字节 + 冻结 base）                                            |
| `check_contract.py`  | 契约自检 CLI（含真实 compose 的 I2 实测）                                                 |

## HTTP 端点速查

```bash
curl -s 'http://127.0.0.1:8791/api/doc?figure=volga' | python3 -m json.tool
curl -s 'http://127.0.0.1:8791/api/scene?figure=volga'
curl -s 'http://127.0.0.1:8791/api/health'
curl -s -X POST 'http://127.0.0.1:8791/api/compose?figure=volga'
curl -s 'http://127.0.0.1:8791/final.svg' | head -c 200
curl -s 'http://127.0.0.1:8791/overlay.svg' | head -c 200
```

`PUT /api/scene` 的语义体见 `docs/merge/.work/impl-contract.md` §2：顶层只接受
`base`（声明）、`ack_base_change`（可选）、`style`、`seq`、`points`、`entities`、`constraints`；
`figure/format/version` 由服务器补齐。锁竞争时返回 200 `{saved:true,composed:false,code:"rendering"}`。

## 本轮已知偏离

- 文字注记/字体子集缺席（本机无 fontTools）：解析到 `type: "text"` 报 `invalid_scene`，
  `overlay.py` 只留 `defs_style` 挂点。
- Cartopy 仓只读：产物只写本仓库 `demo/`；底图直接取现有 Volga 产物，不重跑 render。
- 只接 Volga 一张图；`/api/render` 未实现。
