"""mapdoc: 冻结地理底图 + 草图叠加层的 Python 侧实现.

是什么: 本包只做四件事——底图契约检查(contract.py)、scene 校验/规范化(scene.py)、
叠加层字符串生成(overlay.py)、追加式合成(compose.py); fsutil.py 提供跨进程文件锁与原子写.
为什么: compose 必须"字符串拼接"而不是 XML 解析后重写(I5), 所以生产路径全部按字节操作,
ElementTree 只在测试里用于校验生成结果; 派生几何与前端 src/core/entities.ts /
src/config/angle.ts / src/render/export-svg.ts 逐条镜像, 两边只有一种解释.
元信息: 2026-10, mapdoc 垂直切片 P0–P2.
"""

from __future__ import annotations

__all__ = ["compose", "contract", "fsutil", "overlay", "scene"]
