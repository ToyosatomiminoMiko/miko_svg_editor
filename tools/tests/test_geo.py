"""geo.py 单测: §3 校验、typed 访问、digest.

覆盖: 合法 geo 解析成 typed dataclass（graticule/labels/relief/legend/suggestions）;
缺省的可选块; 各类结构错误的拒绝样例; read_geo 的文件缺失/JSON 坏/不合法的 GeoError 语义;
geo_digest 与键序无关、与内容有关, 且接受 raw dict.
"""

from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from mapdoc import geo

BASE_SHA = "a" * 64


def make_geo_doc() -> dict:
    """合法 mapdoc-geo v1 文档（数值刻意保留多位小数, 验证 typed 访问不丢精度）."""
    return {
        "format": geo.FORMAT,
        "version": geo.VERSION,
        "base": {
            "sha256": BASE_SHA,
            "view_box": [0, 0, 200, 100],
            "width_pt": 200.0,
            "height_pt": 100.0,
        },
        "graticule": {
            "lon": [
                {"value": 10, "label": "10°E", "x": 50.0, "y": 100.0, "side": "bottom"},
                {"value": 20, "label": "20°E", "x": 150.0, "y": 100.0, "side": "bottom"},
            ],
            "lat": [
                {"value": 40, "label": "40°N", "x": 0.0, "y": 25.0, "side": "left"},
                {"value": 50, "label": "50°N", "x": 200.0, "y": 75.0, "side": "right"},
            ],
            "style": {
                "stroke": "#808080",
                "width_pt": 0.5,
                "dash": [0.5, 0.825],
                "opacity": 0.4,
            },
        },
        "labels": [
            {
                "id": "label-country-哈萨克斯坦",
                "kind": "country",
                "text": "哈萨克斯坦",
                "lines": ["哈萨克斯坦"],
                "x": 719.381081,
                "y": 703.365097,
                "rotation_deg": 0,
                "anchor": "middle",
                "font_size_pt": 12,
                "color": "#3a3a3a",
                "italic": False,
                "halo": {"color": "#ffffff", "width_pt": 3},
                "order": 0,
            },
            {
                # 最小写法: lines/anchor/font_size/color/order 全缺省, parse 时补默认.
                "id": "label-sea-里海",
                "kind": "sea",
                "text": "里海",
                "x": 500.0,
                "y": 600.0,
            },
        ],
        "relief": {
            "title": "高程 / 水深",
            "unit": "m",
            "vmin": -2500,
            "vmax": 2500,
            "stops": [
                {"offset": 0, "color": "#08306b"},
                {"offset": 1, "color": "#ffffff"},
            ],
            "ticks": [-2000, -1000, 0, 500, 1000, 1500, 2000],
        },
        "legend": {
            "title": "图例",
            "entries": [
                {
                    "label": "国界",
                    "shape": "line",
                    "stroke": "#4a4a4a",
                    "width_pt": 1.4,
                    "dash": None,
                    "fill": None,
                    "opacity": 1,
                    "marker": None,
                },
                {
                    "label": "城市",
                    "shape": "point",
                    "stroke": "#000000",
                    "width_pt": 0.5,
                    "dash": None,
                    "fill": "#ff0000",
                    "opacity": 1,
                    "marker": "circle",
                },
            ],
        },
        "suggestions": {
            "title": "伏尔加河流域地形图",
            "subtitle": "ETOPO 2022",
            "notes": ["注 1：…"],
            "source": "地形: NOAA NCEI ETOPO 2022",
            "area_annotation": ["伏尔加河流域", "约 141 万 km²"],
            "legend_title": "图例",
            "colorbar_title": "高程 / 水深",
        },
    }


class ValidateGeoTest(unittest.TestCase):
    def test_valid_geo_passes(self) -> None:
        self.assertEqual(geo.validate_geo(make_geo_doc()), [])

    def test_not_a_mapping(self) -> None:
        self.assertEqual(geo.validate_geo(None), ["geo 必须是 JSON 对象"])

    def test_format_and_version(self) -> None:
        doc = make_geo_doc()
        doc["format"] = "mapdoc-page"
        doc["version"] = 2
        errors = geo.validate_geo(doc)
        self.assertTrue(any("geo.format" in error for error in errors), errors)
        self.assertTrue(any("geo.version" in error for error in errors), errors)

    def test_view_box_shape(self) -> None:
        doc = make_geo_doc()
        doc["base"]["view_box"] = [0, 0, 200]
        errors = geo.validate_geo(doc)
        self.assertTrue(any("view_box" in error for error in errors), errors)

    def test_view_box_size_must_match_width_pt(self) -> None:
        doc = make_geo_doc()
        doc["base"]["width_pt"] = 201.0
        errors = geo.validate_geo(doc)
        self.assertTrue(any("width_pt 必须等于 view_box" in error for error in errors), errors)

    def test_tick_side_depends_on_axis(self) -> None:
        doc = make_geo_doc()
        doc["graticule"]["lat"][0]["side"] = "bottom"
        errors = geo.validate_geo(doc)
        self.assertTrue(any("geo.graticule.lat[0].side" in error for error in errors), errors)

    def test_tick_requires_label_and_coordinates(self) -> None:
        doc = make_geo_doc()
        del doc["graticule"]["lon"][0]["label"]
        doc["graticule"]["lon"][0]["x"] = "50"
        errors = geo.validate_geo(doc)
        self.assertTrue(any("缺少字段 label" in error for error in errors), errors)
        self.assertTrue(any(".x 必须是数字" in error for error in errors), errors)

    def test_graticule_style_colors(self) -> None:
        doc = make_geo_doc()
        doc["graticule"]["style"]["stroke"] = "gray"
        doc["graticule"]["style"]["opacity"] = 1.5
        errors = geo.validate_geo(doc)
        self.assertTrue(any("style.stroke" in error for error in errors), errors)
        self.assertTrue(any("style.opacity" in error for error in errors), errors)

    def test_label_kind_enum_and_halo(self) -> None:
        doc = make_geo_doc()
        doc["labels"][0]["kind"] = "nation"
        doc["labels"][0]["halo"]["width_pt"] = 0
        errors = geo.validate_geo(doc)
        self.assertTrue(any("labels[0].kind" in error for error in errors), errors)
        self.assertTrue(any("labels[0].halo.width_pt" in error for error in errors), errors)

    def test_relief_range_and_stops(self) -> None:
        doc = make_geo_doc()
        doc["relief"]["vmin"] = 2500
        doc["relief"]["stops"] = [{"offset": 0, "color": "#08306b"}]
        errors = geo.validate_geo(doc)
        self.assertTrue(any("vmin 必须 < vmax" in error for error in errors), errors)
        self.assertTrue(any("stops 至少需要 2 项" in error for error in errors), errors)

    def test_legend_point_requires_marker(self) -> None:
        doc = make_geo_doc()
        doc["legend"]["entries"][1]["marker"] = None
        errors = geo.validate_geo(doc)
        self.assertTrue(any("marker" in error for error in errors), errors)

    def test_optional_blocks_may_be_absent(self) -> None:
        doc = make_geo_doc()
        for key in ("labels", "relief", "legend", "suggestions"):
            doc.pop(key)
        self.assertEqual(geo.validate_geo(doc), [])


class ParseGeoTest(unittest.TestCase):
    def test_typed_access(self) -> None:
        typed = geo.parse_geo(make_geo_doc())
        self.assertIsInstance(typed, geo.Geo)
        self.assertEqual(typed.base.sha256, BASE_SHA)
        self.assertEqual(typed.base.view_box, (0.0, 0.0, 200.0, 100.0))
        self.assertEqual(typed.base.width_pt, 200.0)
        self.assertEqual(typed.graticule.lon[0].label, "10°E")
        self.assertEqual(typed.graticule.lon[0].side, "bottom")
        self.assertEqual(typed.graticule.lat[1].side, "right")
        self.assertIsNotNone(typed.graticule.style)
        self.assertAlmostEqual(typed.graticule.style.dash[1], 0.825)
        # 保留原始精度（12 位小数）, 渲染时才用 format_number 收敛.
        self.assertAlmostEqual(typed.labels[0].x, 719.381081, places=6)
        self.assertEqual(typed.labels[0].halo.color, "#ffffff")
        self.assertEqual(typed.labels[1].lines, ("里海",))
        self.assertEqual(typed.labels[1].anchor, "middle")
        self.assertEqual(typed.relief.ticks[-1], 2000.0)
        self.assertEqual(typed.relief.stops[0].offset, 0.0)
        self.assertEqual(typed.legend.entries[1].marker, "circle")
        self.assertEqual(typed.suggestions.area_annotation[0], "伏尔加河流域")

    def test_parse_invalid_raises_geo_error(self) -> None:
        doc = make_geo_doc()
        doc["base"]["sha256"] = "nope"
        with self.assertRaises(geo.GeoError) as caught:
            geo.parse_geo(doc)
        self.assertTrue(any("sha256" in message for message in caught.exception.errors))

    def test_parse_without_optional_blocks(self) -> None:
        doc = make_geo_doc()
        for key in ("labels", "relief", "legend", "suggestions"):
            doc.pop(key)
        typed = geo.parse_geo(doc)
        self.assertEqual(typed.labels, ())
        self.assertIsNone(typed.relief)
        self.assertIsNone(typed.legend)
        self.assertIsNone(typed.suggestions)


class ReadGeoTest(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.root = Path(self._directory.name)

    def tearDown(self) -> None:
        self._directory.cleanup()

    def test_reads_valid_file(self) -> None:
        path = self.root / "map.geo.json"
        path.write_text(json.dumps(make_geo_doc(), ensure_ascii=False), encoding="utf-8")
        typed = geo.read_geo(path)
        self.assertEqual(typed.base.width_pt, 200.0)
        self.assertEqual(typed.suggestions.title, "伏尔加河流域地形图")

    def test_missing_file_raises_geo_error(self) -> None:
        with self.assertRaises(geo.GeoError) as caught:
            geo.read_geo(self.root / "missing.geo.json")
        self.assertIn("读取 geo 失败", caught.exception.errors[0])

    def test_invalid_json_raises_geo_error(self) -> None:
        path = self.root / "broken.geo.json"
        path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(geo.GeoError) as caught:
            geo.read_geo(path)
        self.assertIn("不是合法 JSON", caught.exception.errors[0])

    def test_invalid_shape_raises_geo_error_with_filename(self) -> None:
        doc = make_geo_doc()
        doc["base"]["view_box"] = [0, 0]
        path = self.root / "bad.geo.json"
        path.write_text(json.dumps(doc), encoding="utf-8")
        with self.assertRaises(geo.GeoError) as caught:
            geo.read_geo(path)
        self.assertTrue(
            any("bad.geo.json" in message for message in caught.exception.errors),
            caught.exception.errors,
        )


class GeoDigestTest(unittest.TestCase):
    def test_digest_is_key_order_independent(self) -> None:
        first = geo.parse_geo(make_geo_doc())
        second_doc = copy.deepcopy(make_geo_doc())
        second_doc = {key: second_doc[key] for key in reversed(list(second_doc))}
        second = geo.parse_geo(second_doc)
        self.assertEqual(geo.geo_digest(first), geo.geo_digest(second))

    def test_digest_changes_with_content(self) -> None:
        first = geo.parse_geo(make_geo_doc())
        doc = make_geo_doc()
        doc["graticule"]["lon"][0]["x"] = 51.0
        second = geo.parse_geo(doc)
        self.assertNotEqual(geo.geo_digest(first), geo.geo_digest(second))

    def test_digest_accepts_raw_dict(self) -> None:
        typed = geo.parse_geo(make_geo_doc())
        self.assertEqual(geo.geo_digest(typed), geo.geo_digest(make_geo_doc()))

    def test_rounding_and_color_case_do_not_change_digest(self) -> None:
        first = geo.parse_geo(make_geo_doc())
        doc = make_geo_doc()
        # 第 4 位小数与颜色大小写不影响语义: digest 只认 3 位小数 + 小写颜色.
        doc["labels"][0]["x"] = 719.3810814
        doc["relief"]["stops"][0]["color"] = "#08306B"
        second = geo.parse_geo(doc)
        self.assertEqual(geo.geo_digest(first), geo.geo_digest(second))


if __name__ == "__main__":
    unittest.main()
