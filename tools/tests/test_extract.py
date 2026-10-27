"""``mapdoc.extract`` 与 ``mapdoc.contract`` 的单元测试.

是什么: 用 ``fixtures/cartopy_figure.svg``(缩小但结构同构的 matplotlib 成品)验证
「成品 → 纯底图 + geo」的抽取契约, 以及 contract.py 的 C1..C4 与 final marker 编解码.

为什么不用真实 10 MB 产物: 单测必须秒级且不依赖仓库外的 Cartopy 仓; fixture 保留了
同样的结构要素(图外文字/图例/色标/图框/纸白底/@font-face/地名组/经纬网裁剪区),
能覆盖抽取规则里所有与真实产物相关的分支.

元信息: 2026-10, 契约见 docs/PAGE-EDITOR.md §3/§6.1/§7.
"""

from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

from mapdoc import contract, extract

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "cartopy_figure.svg"


class ExtractFixtureTest(unittest.TestCase):
    """对合成 fixture 做完整的抽取与 geo 断言."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.source = FIXTURE.read_bytes()
        cls.base, cls.geo = extract.extract(cls.source)
        cls.info = contract.read_base(cls.base)

    def test_base_contract_passes(self) -> None:
        self.assertEqual(self.info.errors, ())
        self.assertIsNotNone(self.info.view_box)
        self.assertEqual(self.info.view_box, (10.5, 10.0, 179.7, 130.0))
        self.assertAlmostEqual(self.info.width_pt, 179.7, places=9)
        self.assertAlmostEqual(self.info.height_pt, 130.0, places=9)

    def test_base_inner_offsets_are_exact(self) -> None:
        """compose 依赖这对偏移做内联; 它们必须刚好夹住内容, 不含 XML 声明/根标签."""
        self.assertGreater(self.info.inner_start, 0)
        self.assertGreater(self.info.inner_end, self.info.inner_start)
        inner = self.base[self.info.inner_start : self.info.inner_end]
        self.assertNotIn(b"<?xml", inner)
        self.assertNotIn(b"<svg", inner)
        self.assertTrue(self.base.endswith(b"</svg>\n"))
        self.assertEqual(self.base[self.info.inner_end :], b"</svg>\n")
        self.assertIn(b'width="179.7pt"', self.base[: self.info.inner_start])
        self.assertIn(b'viewBox="10.5 10 179.7 130"', self.base[: self.info.inner_start])

    def test_base_has_no_non_geographic_content(self) -> None:
        for forbidden in (
            b"<text",
            b"@font-face",
            b"label-",
            b'id="axes_2"',
            b'id="axes_3"',
            b'id="patch_1"',
            b'id="patch_3"',
            b"mapdoc-overlay",
            b"mapdoc-final",
        ):
            self.assertNotIn(forbidden, self.base, msg=f"底图不应包含 {forbidden!r}")

    def test_base_keeps_geographic_layers(self) -> None:
        for needed in (
            b'id="axes_1"',
            b'id="FeatureArtist_1"',
            b'id="LineCollection_1"',
            b'id="line2d_1"',
            b"clipmap",
            b"stroke-linejoin: round",
        ):
            self.assertIn(needed, self.base, msg=f"底图应保留 {needed!r}")
        # 山体阴影 image 保留; 色标与图例里的图片随 axes 删除.
        self.assertEqual(self.base.count(b"<image"), 1)

    def test_geo_base_matches_base_bytes(self) -> None:
        self.assertEqual(self.geo["format"], "mapdoc-geo")
        self.assertEqual(self.geo["version"], 1)
        declared = self.geo["base"]
        self.assertEqual(declared["sha256"], contract.sha256(self.base))
        self.assertEqual(declared["view_box"], [10.5, 10, 179.7, 130])
        self.assertEqual(declared["width_pt"], 179.7)
        self.assertEqual(declared["height_pt"], 130)

    def test_graticule_ticks_and_style(self) -> None:
        graticule = self.geo["graticule"]
        self.assertEqual([tick["value"] for tick in graticule["lon"]], [35, 40])
        self.assertEqual([tick["label"] for tick in graticule["lon"]], ["35°E", "40°E"])
        self.assertEqual({tick["side"] for tick in graticule["lon"]}, {"bottom"})
        self.assertAlmostEqual(graticule["lon"][0]["x"], 40.0)
        self.assertAlmostEqual(graticule["lon"][0]["y"], 144.2)
        self.assertEqual([tick["value"] for tick in graticule["lat"]], [46, 48])
        self.assertEqual({tick["side"] for tick in graticule["lat"]}, {"left"})
        self.assertAlmostEqual(graticule["lat"][0]["x"], 5.5)
        self.assertAlmostEqual(graticule["lat"][0]["y"], 110.0)
        self.assertEqual(
            graticule["style"],
            {"stroke": "#808080", "width_pt": 0.5, "dash": [0.5, 0.825], "opacity": 0.4},
        )

    def test_labels(self) -> None:
        labels = self.geo["labels"]
        self.assertEqual([label["id"] for label in labels], [
            "label-country-俄罗斯",
            "label-river-伏尔加河",
            "label-city-莫斯科",
        ])
        self.assertEqual([label["kind"] for label in labels], ["country", "river", "city"])
        self.assertEqual([label["order"] for label in labels], [0, 1, 2])
        country, river, city = labels
        self.assertEqual(country["text"], "俄罗斯")
        self.assertEqual(country["lines"], ["俄罗斯"])
        self.assertEqual(country["anchor"], "middle")
        self.assertEqual(country["color"], "#3a3a3a")
        self.assertFalse(country["italic"])
        self.assertEqual(country["halo"], {"color": "#ffffff", "width_pt": 2.5})
        self.assertEqual(country["font_size_pt"], 10)
        self.assertAlmostEqual(country["x"], 120.0)
        self.assertAlmostEqual(country["y"], 90.0)
        self.assertAlmostEqual(river["rotation_deg"], 9.5)
        self.assertTrue(river["italic"])
        self.assertEqual(river["color"], "#2d6ea6")
        self.assertEqual(city["anchor"], "start")
        self.assertEqual(city["color"], "#000000")

    def test_relief_and_stops(self) -> None:
        relief = self.geo["relief"]
        self.assertEqual(relief["title"], "高程 / 水深")
        self.assertEqual(relief["unit"], "m")
        self.assertEqual(relief["vmin"], -100)
        self.assertEqual(relief["vmax"], 100)
        self.assertEqual(relief["ticks"], [-100, 0, 100])
        stops = relief["stops"]
        self.assertEqual(len(stops), 21)
        offsets = [stop["offset"] for stop in stops]
        self.assertEqual(offsets[0], 0)
        self.assertEqual(offsets[-1], 1)
        self.assertEqual(offsets, sorted(offsets))
        self.assertEqual(stops[0]["color"], "#0000ff")
        self.assertEqual(stops[-1]["color"], "#ff0000")
        for stop in stops:
            self.assertRegex(stop["color"], r"^#[0-9a-f]{6}$")

    def test_legend_entries(self) -> None:
        legend = self.geo["legend"]
        self.assertEqual(legend["title"], "图例")
        entries = legend["entries"]
        self.assertEqual(
            [entry["label"] for entry in entries],
            ["伏尔加河流域", "国界", "首都", "共和国首府", "城市"],
        )
        self.assertEqual(
            [entry["shape"] for entry in entries],
            ["rect", "line", "point", "point", "point"],
        )
        self.assertEqual(
            [entry["marker"] for entry in entries],
            [None, None, "star", "square", "circle"],
        )
        area = entries[0]
        self.assertEqual(area["fill"], "#3f8fc4")
        self.assertEqual(area["stroke"], "#1b5c8c")
        self.assertAlmostEqual(area["opacity"], 0.45)
        self.assertAlmostEqual(area["width_pt"], 1.5)
        border = entries[1]
        self.assertEqual(border["stroke"], "#4a4a4a")
        self.assertAlmostEqual(border["width_pt"], 1.4)
        self.assertIsNone(border["fill"])
        self.assertEqual(entries[2]["fill"], "#ffd200")

    def test_suggestions(self) -> None:
        self.assertEqual(
            self.geo["suggestions"],
            {
                "title": "测试地形图",
                "subtitle": "副标题 | 数据源",
                "notes": ["注 1：测试注记第一行", "注 2：测试注记第二行"],
                "source": "来源: 测试数据",
                "area_annotation": ["测试流域", "约 100 万 km²"],
                "legend_title": "图例",
                "colorbar_title": "高程 / 水深",
            },
        )

    def test_extract_is_deterministic(self) -> None:
        base_again, geo_again = extract.extract(self.source)
        self.assertEqual(base_again, self.base)
        self.assertEqual(
            json.dumps(geo_again, ensure_ascii=False, sort_keys=True),
            json.dumps(self.geo, ensure_ascii=False, sort_keys=True),
        )

    def test_extract_file_matches_bytes(self) -> None:
        base_again, geo_again = extract.extract_file(FIXTURE)
        self.assertEqual(base_again, self.base)
        self.assertEqual(geo_again["base"]["sha256"], self.geo["base"]["sha256"])


class ExtractErrorTest(unittest.TestCase):
    """结构不识别时应当抛 ExtractError, 而不是返回半成品."""

    def test_invalid_xml(self) -> None:
        with self.assertRaises(extract.ExtractError):
            extract.extract(b"<svg><g></svg>")

    def test_no_figure_group(self) -> None:
        source = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>'
        with self.assertRaises(extract.ExtractError):
            extract.extract(source)

    def test_no_axes_group(self) -> None:
        source = (
            b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
            b'<g id="figure_1"><g id="patch_1"><path d="M 0 0 L 10 0 L 10 10 L 0 10 z"/></g></g>'
            b"</svg>"
        )
        with self.assertRaises(extract.ExtractError):
            extract.extract(source)


class ContractTest(unittest.TestCase):
    """contract.read_base 的 C1..C4 与 final marker 编解码."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.base, _geo = extract.extract(FIXTURE.read_bytes())
        cls.info = contract.read_base(cls.base)

    def test_read_base_accepts_good_base(self) -> None:
        self.assertTrue(self.info.ok)
        self.assertEqual(self.info.errors, ())

    def test_c1_requires_root_and_viewbox(self) -> None:
        no_root = contract.read_base(b"<html></html>")
        self.assertTrue(any(error.startswith("C1") for error in no_root.errors))
        broken = re.sub(rb'viewBox="[^"]*"', b'viewBox="1 2 3"', self.base, count=1)
        info = contract.read_base(broken)
        self.assertTrue(any(error.startswith("C1") for error in info.errors))
        # C1 失败但根标签存在时, 偏移仍然给出(studio 读坏图时也能定位).
        self.assertGreater(info.inner_start, 0)

    def test_c2_rejects_text(self) -> None:
        marked = self.base[: self.info.inner_start] + b"<text>x</text>" + self.base[self.info.inner_start :]
        info = contract.read_base(marked)
        self.assertTrue(any(error.startswith("C2") for error in info.errors))
        # 即使 C2 失败, viewBox/尺寸/偏移也必须可用.
        self.assertEqual(info.view_box, (10.5, 10.0, 179.7, 130.0))
        self.assertAlmostEqual(info.width_pt, 179.7)
        self.assertGreater(info.inner_end, info.inner_start)

    def test_c3_requires_single_trailing_close(self) -> None:
        doubled = self.base + b"</svg>\n"
        info = contract.read_base(doubled)
        self.assertTrue(any(error.startswith("C3") for error in info.errors))
        trailing_junk = self.base + b"junk\n"
        info = contract.read_base(trailing_junk)
        self.assertTrue(any(error.startswith("C3") for error in info.errors))
        # 允许末尾完全没有换行.
        no_newline = self.base.rstrip(b"\r\n")
        self.assertEqual(contract.read_base(no_newline).errors, ())

    def test_c4_rejects_overlay_and_marker_traces(self) -> None:
        for trace in (b"<g id=\"mapdoc-overlay\"/>", b"<!-- mapdoc-final:AAAA -->"):
            marked = (
                self.base[: self.info.inner_start]
                + trace
                + self.base[self.info.inner_start :]
            )
            info = contract.read_base(marked)
            self.assertTrue(any(error.startswith("C4") for error in info.errors))

    def test_inner_offsets_support_inlining(self) -> None:
        """§6 的内联方式: prefix + 排版层(内含 BASE_INNER) + suffix 必须保持字节可解析."""
        inner = self.base[self.info.inner_start : self.info.inner_end]
        self.assertIn(b'id="FeatureArtist_1"', inner)
        overlay = b'<g id="mapdoc-overlay"/>'
        composed = (
            self.base[: self.info.inner_start]
            + overlay
            + inner
            + self.base[self.info.inner_end :]
        )
        self.assertEqual(len(composed), len(self.base) + len(overlay))
        self.assertIn(overlay, composed)
        self.assertTrue(composed.startswith(b"<?xml"))
        self.assertTrue(composed.endswith(b"</svg>\n"))
        info = contract.read_base(composed)
        self.assertTrue(any(error.startswith("C4") for error in info.errors))
        self.assertAlmostEqual(info.width_pt, 179.7)

    def test_check_base_file_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            info = contract.check_base_file(Path(directory) / "missing.svg")
        self.assertTrue(info.errors)
        self.assertEqual(info.view_box, None)

    def test_sha256_helpers(self) -> None:
        self.assertEqual(
            contract.sha256(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        )
        self.assertTrue(contract.is_sha256(contract.sha256(b"abc")))
        self.assertFalse(contract.is_sha256("ABC"))
        self.assertFalse(contract.is_sha256("a" * 63))
        self.assertFalse(contract.is_sha256(123))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "blob.bin"
            path.write_bytes(b"payload")
            self.assertEqual(contract.sha256_file(path), contract.sha256(b"payload"))

    def test_marker_roundtrip(self) -> None:
        payload = {
            "counts": {"colorbar": 1, "legend": 1, "text": 3, "total": 5},
            "geo": contract.sha256(b"geo"),
            "scene": contract.sha256(b"scene"),
            "version": 1,
        }
        marker = contract.make_marker(payload)
        self.assertIsInstance(marker, bytes)
        self.assertTrue(marker.startswith(b"<!-- mapdoc-final:"))
        self.assertTrue(marker.endswith(b" -->"))
        self.assertEqual(contract.read_marker(marker), payload)
        embedded = self.base[: self.info.inner_start] + marker + b"\n" + self.base[self.info.inner_start :]
        self.assertEqual(contract.read_marker(embedded), payload)

    def test_marker_rejects_bad_payload(self) -> None:
        with self.assertRaises(ValueError):
            contract.make_marker({"geo": "a" * 64, "scene": "b" * 64, "counts": {}, "version": 2})
        with self.assertRaises(ValueError):
            contract.make_marker({"geo": "not-a-hash", "scene": "b" * 64, "counts": {}})

    def test_read_marker_returns_none_for_garbage(self) -> None:
        self.assertIsNone(contract.read_marker(b""))
        self.assertIsNone(contract.read_marker(b"<!-- mapdoc-final:!!!! -->"))
        self.assertIsNone(contract.read_marker(b"<!-- mapdoc-final:AAAA -->"))
        self.assertIsNone(contract.read_marker(b"<!-- mapdoc-final:eyJ2ZXJzaW9uIjoyfQ== -->"))


if __name__ == "__main__":
    unittest.main()
