"""独立子进程合成 worker: 供 I3(两次独立进程字节一致)测试调用.

用法: python3 tools/tests/_compose_worker.py <base.svg> <scene.json> <out.svg>
输出: 一行 final 的 sha256(便于父测试断言).
为什么必须独立进程: 同进程内两次调用共享 Python 的字典/浮点环境, 证明不了跨进程确定性(I3).
"""

from __future__ import annotations

import sys
from pathlib import Path

# 本文件在 tools/tests/ 下; 把 tools/ 加进 sys.path 才能 import mapdoc.
TOOLS_DIR = Path(__file__).resolve().parents[1]
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from mapdoc import compose, contract  # noqa: E402 - 先加 sys.path 再导入


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("用法: _compose_worker.py <base.svg> <scene.json> <out.svg>", file=sys.stderr)
        return 2
    base_path, scene_path, final_path = (Path(part) for part in argv[1:])
    from mapdoc import scene as scene_mod  # noqa: E402 - 同上

    scan = scene_mod.load(scene_path)
    if scan is None:
        print(f"scene 不存在: {scene_path}", file=sys.stderr)
        return 1
    compose.compose(base_path, scan, final_path)
    print(contract.sha256(final_path.read_bytes()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
