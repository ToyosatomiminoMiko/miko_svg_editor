#!/usr/bin/env python3
"""重建 `src/assets/fonts/` 里的字体资产(开发期一次性脚本, 不参与构建).

是什么: 从本机安装的字体裁出「项目字体资产」, 供浏览器端 hb-subset 再做逐文档子集:

- `JetBrainsMonoSlashed-{Regular,SemiBold,Bold}.ttf`:JetBrains Mono Slashed 的 400/600/700,
  预裁到拉丁/标点/数学/箭头/CJK 标点/全角区间(miko_ui 随包字体是 woff2, 浏览器没法解 brotli,
  这里落成未压缩 TrueType);
- `NotoSansMonoCJKsc-VF.otf`:Noto Sans Mono CJK SC 的可变字体(wght 400..700), 预裁到
  GB2312 全集 + 上述拉丁区间(CFF2 可变面, 整份约 3 MB; 产物里每份只带用到的字形);
- 两份 OFL 许可证原文.

为什么要有预裁:浏览器拿不到系统字体字节, 只能读随包资产; 整份 Noto CJK 33 MB 显然不能入库,
而 GB2312 覆盖地图地名里出现的常用汉字与全部常用标点. 未覆盖的字符在导出时会被跳过并告警.

为什么用 Python + fontTools: 这是唯一在开发机上现成的字体工具链; 产物入库, 构建/运行时不需要
Python. 重新生成需要 `pip install fonttools brotli`(brotli 用于读 woff2)与系统安装的
Noto Sans Mono CJK VF(包名 `google-noto-sans-mono-cjk-vf-fonts`).

用法:
    PYTHONPATH=<fonttools 安装目录> python3 scripts/build_font_assets.py

元信息: 作者 ToyosatomiminoMiko, 2026-11-07.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTCollection, TTFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "assets" / "fonts"
MIKO_FONTS = ROOT / "node_modules" / "miko_ui" / "styles" / "fonts" / "jetbrains_mono_slashed"
NOTO_VF = Path(
    os.environ.get(
        "NOTO_CJK_VF",
        "/usr/share/fonts/google-noto-sans-mono-cjk-vf-fonts/NotoSansMonoCJK-VF.ttc",
    )
)

# 引擎侧会用到的拉丁区间:基本拉丁, 拉丁补充/扩展 A-B, 常用标点, 货币, 字母式, 数字形式,
# 箭头, 数学算符, 带圈数字, 几何图形, 杂项符号, CJK 标点, CJK 兼容形式, 全角形式.
LATIN_RANGES = (
    (0x0020, 0x007E),
    (0x00A0, 0x024F),
    (0x2010, 0x2027),
    (0x2030, 0x206F),
    (0x20A0, 0x20CF),
    (0x2100, 0x214F),
    (0x2150, 0x218F),
    (0x2190, 0x21FF),
    (0x2200, 0x22FF),
    (0x2460, 0x24FF),
    (0x25A0, 0x25FF),
    (0x2600, 0x26FF),
    (0x3000, 0x303F),
    (0xFE30, 0xFE4F),
    (0xFF00, 0xFFEF),
)

# 丢弃的表:竖排(vhea/vmtx/VORG/VVAR)与排版特性(GSUB/GPOS/GDEF/BASE)对单行地名/页面文字无用.
DROP_TABLES = ("DSIG", "vhea", "vmtx", "VORG", "VVAR", "GSUB", "GPOS", "GDEF", "BASE")


def latin_chars() -> set[int]:
    return {code for low, high in LATIN_RANGES for code in range(low, high + 1)}


def gb2312_chars() -> set[int]:
    """GB2312 双字节区的全部字符(汉字 6763 + 符号 682)."""
    chars: set[int] = set()
    for lead in range(0xA1, 0xF8):
        for trail in range(0xA1, 0xFF):
            try:
                chars.add(ord(bytes((lead, trail)).decode("gb2312")))
            except UnicodeDecodeError:
                continue
    return chars


def subset_font(font: TTFont, unicodes: set[int]) -> None:
    cmap = set(font.getBestCmap())
    keep = sorted(code for code in unicodes if code in cmap)
    if not keep:
        raise SystemExit("裁字集与字体 cmap 没有交集, 检查字体文件是否选错")
    options = subset.Options()
    options.layout_features = []
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.notdef_outline = True
    options.drop_tables += list(DROP_TABLES)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=keep)
    subsetter.subset(font)


def save_font(font: TTFont, name: str) -> None:
    font.flavor = None
    path = OUT / name
    font.save(path)
    font.close()
    print(f"  {name}: {path.stat().st_size} 字节")


def build_jetbrains() -> None:
    print("JetBrains Mono Slashed(预裁拉丁区间):")
    latin = latin_chars()
    for source, name in (
        ("JetBrainsMonoSlashed-Regular.woff2", "JetBrainsMonoSlashed-Regular.ttf"),
        ("JetBrainsMonoSlashed-SemiBold.woff2", "JetBrainsMonoSlashed-SemiBold.ttf"),
        ("JetBrainsMonoSlashed-Bold.woff2", "JetBrainsMonoSlashed-Bold.ttf"),
    ):
        src = MIKO_FONTS / source
        if not src.exists():
            raise SystemExit(f"找不到 {src}; 先 npm install 让 miko_ui 的字体就位")
        font = TTFont(src, recalcTimestamp=False)
        subset_font(font, latin)
        save_font(font, name)


def build_noto() -> None:
    print("Noto Sans Mono CJK SC(预裁 GB2312 + 拉丁区间, 保留可变轴):")
    if not NOTO_VF.exists():
        raise SystemExit(f"找不到 {NOTO_VF}; 设 NOTO_CJK_VF 指向 NotoSansMonoCJK-VF.ttc")
    collection = TTCollection(NOTO_VF, lazy=True)
    index = next(
        (
            i
            for i, font in enumerate(collection.fonts)
            if font["name"].getDebugName(1) == "Noto Sans Mono CJK SC"
        ),
        None,
    )
    if index is None:
        raise SystemExit(f"{NOTO_VF} 里没有 Noto Sans Mono CJK SC 面")
    font = TTFont(NOTO_VF, fontNumber=index, recalcTimestamp=False)
    subset_font(font, gb2312_chars() | latin_chars())
    save_font(font, "NotoSansMonoCJKsc-VF.otf")


def copy_licenses() -> None:
    """JetBrains 的 OFL 原文从 miko_ui 随包文件复制;Noto 的分发版不在本机, 那份原文随资产
    一起提交(取自 https://github.com/notofonts/noto-cjk 的 Sans/LICENSE), 这里不再覆盖."""
    print("许可证:")
    source = MIKO_FONTS / "LICENSE.txt"
    if not source.exists():
        print(f"  跳过 {source}(不存在)")
        return
    shutil.copyfile(source, OUT / "LICENSE-JetBrainsMono.txt")
    print("  LICENSE-JetBrainsMono.txt")
    print("  LICENSE-NotoSansMonoCJK.txt(随仓库提交, 不由本脚本生成)")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    build_jetbrains()
    build_noto()
    copy_licenses()


if __name__ == "__main__":
    sys.exit(main())
