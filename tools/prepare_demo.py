#!/usr/bin/env python3
"""把只读 Cartopy 仓的 Volga 成品 SVG 复制成本仓库的 demo 底图.

是什么: 从 Cartopy_file 的 Volga 目录复制 "最终成品 SVG" 到 demo/figures/Volga/ 作为
交付物(final)的初始字节, 并用同一份字节生成 .build/<stem>.base.svg(冻结底图).
为什么: Cartopy 仓对本进程只读(EROFS), 产物只能落到本仓库; 本轮不重跑 render,
底图直接取现有产物, 但必须先通过 C1/C3/C6/C8 检查, 否则 compose 的 I1/I2 无从谈起.
幂等: final 已存在时不覆盖(它可能已经含 marker/叠加层); base 每次由源字节原子重写,
内容相同则磁盘字节不变.
用法: python3 tools/prepare_demo.py   (不接受命令行参数)
"""

from __future__ import annotations

import sys
from pathlib import Path

from mapdoc import contract, fsutil

# 本文件所在目录 = tools/; 仓库根 = 上一级.
TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parent

# 只读源: Cartopy 仓现有交付物. 本轮只接 Volga 一张图(DESIGN §8 已知偏离).
SOURCE_DIR = Path("/mnt/IVSTINIANVS/__projects_python/Cartopy_file/Volga")
FIGURE_STEM = "volga_basin_topography_etopo2022_lambert_conformal"
SOURCE_SVG = SOURCE_DIR / (FIGURE_STEM + ".svg")

# 产物落点: 与 studio.toml 的 figure 路径一致.
DEMO_DIR = REPO_ROOT / "demo" / "figures" / "Volga"
FINAL_SVG = DEMO_DIR / (FIGURE_STEM + ".svg")
BASE_DIR = DEMO_DIR / ".build"
BASE_SVG = BASE_DIR / (FIGURE_STEM + ".base.svg")


def main() -> int:
    if len(sys.argv) > 1:
        print(
            "错误: 这个脚本不接受命令行参数(源与落点写在脚本里)",
            file=sys.stderr,
        )
        return 2

    try:
        source_bytes = SOURCE_SVG.read_bytes()
    except OSError as exc:
        print(f"错误: 读不到源 SVG: {SOURCE_SVG}: {exc}", file=sys.stderr)
        return 1

    check = contract.read_base_check(source_bytes)
    if check.errors:
        print("错误: 源 SVG 不满足底图契约(C1/C3/C6/C8):", file=sys.stderr)
        for message in check.errors:
            print(f"  - {message}", file=sys.stderr)
        return 1

    source_sha = contract.sha256(source_bytes)
    print(f"源 SVG: {SOURCE_SVG} ({len(source_bytes)} 字节, sha256={source_sha})")
    print(f"viewBox 尺寸: {check.width_pt} x {check.height_pt} pt")

    DEMO_DIR.mkdir(parents=True, exist_ok=True)
    BASE_DIR.mkdir(parents=True, exist_ok=True)

    if FINAL_SVG.exists():
        print(f"保留已存在的 final(可能已含 marker/叠加层): {FINAL_SVG}")
    else:
        fsutil.atomic_write_bytes(FINAL_SVG, source_bytes)
        print(f"已写入 final 初始字节: {FINAL_SVG}")

    # base 永远由源字节派生: final 一旦被 compose 写过, 再从 final 复制就会把叠加层
    # 与 marker 烤进底图, 破坏 C6 与 I2.
    fsutil.atomic_write_bytes(BASE_SVG, source_bytes)
    print(f"已写入冻结底图: {BASE_SVG}")

    base_sha = contract.sha256_file(BASE_SVG)
    if base_sha != source_sha:
        print("错误: 底图写入后 sha256 与源不一致(磁盘异常)", file=sys.stderr)
        return 1
    print("底图与源字节一致, prepare 完成")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
