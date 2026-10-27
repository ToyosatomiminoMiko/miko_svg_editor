"""mapdoc: 出版排版数据链路的 Python 侧实现.

是什么: 本包做五件事——底图契约与 SVG 切分(contract.py)、成品 SVG 抽取(extract.py)、
geo.json 读写(geo.py)、scene 校验/规范化(page.py)、排版层渲染(render.py)与合成(compose.py);
fsutil.py 提供跨进程文件锁与原子写.
为什么: 成品必须只有一个 Python 作者(浏览器只写 scene.json), 所以生产路径按字节拼接底图
内容、只对排版层做确定性的字符串生成; 布局公式与前端 src/core/page-layout.ts /
src/render/page-svg.ts 逐条镜像, 两边只有一种解释.
元信息: 2026-10, 新数据流(纯底图 + geo + 排版层); 契约见 docs/PAGE-EDITOR.md.
"""

from __future__ import annotations

__all__ = ["compose", "contract", "extract", "fsutil", "geo", "page", "render"]
