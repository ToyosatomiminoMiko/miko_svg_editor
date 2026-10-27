"""page.py 单测: §4 校验、规范化/摘要/派生.

覆盖: 合法 scene 全绿; 每个契约约束的拒绝样例（白名单/枚举/范围/颜色/id/seq/行数上限）;
normalize 的 3 位小数、整数值落成 int、颜色小写、补 figure、丢弃未知字段; canonical_bytes
末尾恰好一个换行; scene_digest 与键序无关、与内容有关; map_height 纵横比; item_counts.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import unittest

from mapdoc import page

SHA = "a" * 64


def make_text_item(identifier: int = 1) -> dict:
    """合法 text item（§4.1）."""
    return {
        "id": identifier,
        "kind": "text",
        "space": "page",
        "role": "title",
        "x": 100.0,
        "y": 20.0,
        "lines": ["标题"],
        "font_size_pt": 18.0,
        "font_family": None,
        "color": "#111111",
        "anchor": "middle",
        "rotation_deg": 0.0,
        "line_height": 1.35,
        "italic": False,
        "bold": False,
        "halo": None,
    }


def make_legend_entry(label: str = "国界", shape: str = "line") -> dict:
    """合法图例条目（line）."""
    return {
        "label": label,
        "shape": shape,
        "stroke": "#4a4a4a",
        "width_pt": 1.4,
        "dash": None,
        "fill": None,
        "opacity": 1.0,
        "marker": None,
    }


def make_legend_item(identifier: int = 2) -> dict:
    """合法 legend item（§4.1）."""
    return {
        "id": identifier,
        "kind": "legend",
        "space": "page",
        "x": 120.0,
        "y": 10.0,
        "width_pt": 70.0,
        "title": "图例",
        "entries": [make_legend_entry()],
        "font_size_pt": 9.0,
        "title_size_pt": 12.0,
        "row_height_pt": 14.0,
        "padding_pt": 7.0,
        "swatch_width_pt": 24.0,
        "swatch_gap_pt": 6.0,
        "frame": {
            "show": True,
            "stroke": "#bbbbbb",
            "width_pt": 0.8,
            "fill": "#ffffff",
            "opacity": 0.94,
        },
    }


def make_colorbar_item(identifier: int = 3) -> dict:
    """合法 colorbar item（§4.1）."""
    return {
        "id": identifier,
        "kind": "colorbar",
        "space": "page",
        "x": 20.0,
        "y": 60.0,
        "width_pt": 14.0,
        "height_pt": 30.0,
        "title": "高程 / 水深",
        "unit": "m",
        "show_title": True,
        "show_ticks": True,
        "title_size_pt": 8.0,
        "label_size_pt": 7.0,
    }


def make_scene() -> dict:
    """合法 mapdoc-page v1 scene（A4 横向 + 三个 item）."""
    return {
        "format": page.FORMAT,
        "version": page.VERSION,
        "figure": "demo/figures/Volga/volga.svg",
        "base": {"sha256": SHA, "width_pt": 200.0, "height_pt": 100.0},
        "paper": {
            "preset": "A4",
            "orientation": "landscape",
            "width_pt": 200.0,
            "height_pt": 100.0,
        },
        "map": {"x": 20.0, "y": 10.0, "width_pt": 100.0},
        "frame": {
            "show": True,
            "stroke": "#000000",
            "width_pt": 0.8,
            "ticks": True,
            "tick_length_pt": 5.0,
            "tick_font_size_pt": 7.0,
            "tick_color": "#444444",
            "tick_gap_pt": 2.0,
        },
        "style": {
            "paper_color": "#ffffff",
            "font_family": "Test Sans",
            "color": "#111111",
        },
        "items": [
            make_text_item(1),
            make_legend_item(2),
            make_colorbar_item(3),
        ],
        "seq": 4,
    }


class ValidateSceneTest(unittest.TestCase):
    def errors(self, doc: dict) -> list[str]:
        return page.validate_scene(doc)

    def test_valid_scene_passes(self) -> None:
        self.assertEqual(self.errors(make_scene()), [])

    def test_not_a_mapping(self) -> None:
        self.assertEqual(self.errors([]), ["scene 必须是 JSON 对象"])

    def test_unknown_top_level_key(self) -> None:
        doc = make_scene()
        doc["ack_base_change"] = True
        errors = self.errors(doc)
        self.assertTrue(any("未知字段 ack_base_change" in error for error in errors), errors)

    def test_missing_figure(self) -> None:
        doc = make_scene()
        del doc["figure"]
        errors = self.errors(doc)
        self.assertTrue(any("缺少字段 figure" in error for error in errors), errors)

    def test_format_and_version(self) -> None:
        doc = make_scene()
        doc["format"] = "mapdoc-overlay"
        doc["version"] = True
        errors = self.errors(doc)
        self.assertTrue(any("scene.format" in error for error in errors), errors)
        self.assertTrue(any("scene.version" in error for error in errors), errors)

    def test_base_claim_shape(self) -> None:
        doc = make_scene()
        doc["base"]["sha256"] = "ABC"
        doc["base"]["width_pt"] = 0
        errors = self.errors(doc)
        self.assertTrue(any("base.sha256" in error for error in errors), errors)
        self.assertTrue(any("base.width_pt" in error for error in errors), errors)

    def test_paper_range(self) -> None:
        for width in (page.PAPER_MIN_PT - 1, page.PAPER_MAX_PT + 1):
            doc = make_scene()
            doc["paper"]["width_pt"] = width
            errors = self.errors(doc)
            self.assertTrue(any("paper.width_pt" in error for error in errors), errors)

    def test_map_width_must_exceed_one(self) -> None:
        doc = make_scene()
        doc["map"]["width_pt"] = 1.0
        errors = self.errors(doc)
        self.assertTrue(any("map.width_pt" in error for error in errors), errors)

    def test_map_coordinate_must_be_finite(self) -> None:
        doc = make_scene()
        doc["map"]["x"] = math.inf
        errors = self.errors(doc)
        self.assertTrue(any("map.x" in error for error in errors), errors)

    def test_duplicate_item_id(self) -> None:
        doc = make_scene()
        doc["items"][1]["id"] = doc["items"][0]["id"]
        errors = self.errors(doc)
        self.assertTrue(any("重复" in error for error in errors), errors)

    def test_seq_must_exceed_item_ids(self) -> None:
        doc = make_scene()
        doc["seq"] = 2
        errors = self.errors(doc)
        self.assertTrue(any("seq 必须大于所有 item id" in error for error in errors), errors)

    def test_seq_must_be_positive_int(self) -> None:
        doc = make_scene()
        doc["seq"] = 0
        self.assertTrue(self.errors(doc))

    def test_item_kind_enum(self) -> None:
        doc = make_scene()
        doc["items"][0]["kind"] = "image"
        errors = self.errors(doc)
        self.assertTrue(any("items[0].kind" in error for error in errors), errors)

    def test_text_lines_bounds(self) -> None:
        doc = make_scene()
        doc["items"][0]["lines"] = []
        self.assertTrue(any("lines 行数" in error for error in self.errors(doc)))

        doc = make_scene()
        doc["items"][0]["lines"] = ["x"] * (page.MAX_TEXT_LINES + 1)
        self.assertTrue(any("lines 行数" in error for error in self.errors(doc)))

        doc = make_scene()
        doc["items"][0]["lines"] = ["字" * (page.MAX_LINE_CHARS + 1)]
        self.assertTrue(any("字符上限" in error for error in self.errors(doc)))

    def test_color_must_be_rrggbb(self) -> None:
        doc = make_scene()
        doc["items"][0]["color"] = "#fff"
        errors = self.errors(doc)
        self.assertTrue(any("items[0](text).color" in error for error in errors), errors)

    def test_legend_entries_limit_message(self) -> None:
        doc = make_scene()
        doc["items"][1]["entries"] = [
            make_legend_entry(f"e{index}") for index in range(page.MAX_LEGEND_ENTRIES + 1)
        ]
        errors = self.errors(doc)
        self.assertTrue(
            any(
                "items[1](legend).entries 超过上限 50" in error for error in errors
            ),
            errors,
        )

    def test_legend_point_requires_marker(self) -> None:
        doc = make_scene()
        doc["items"][1]["entries"] = [make_legend_entry(shape="point")]
        errors = self.errors(doc)
        self.assertTrue(any(".marker" in error for error in errors), errors)

    def test_legend_line_rejects_marker(self) -> None:
        doc = make_scene()
        doc["items"][1]["entries"][0]["marker"] = "star"
        errors = self.errors(doc)
        self.assertTrue(any(".marker" in error for error in errors), errors)

    def test_unknown_item_field(self) -> None:
        doc = make_scene()
        doc["items"][0]["opacity"] = 0.5
        errors = self.errors(doc)
        self.assertTrue(any("items[0](text) 未知字段 opacity" in error for error in errors), errors)

    def test_space_enum(self) -> None:
        doc = make_scene()
        doc["items"][0]["space"] = "viewport"
        errors = self.errors(doc)
        self.assertTrue(any("space" in error for error in errors), errors)

    def test_items_must_be_array(self) -> None:
        doc = make_scene()
        doc["items"] = {}
        self.assertTrue(self.errors(doc))


class NormalizeSceneTest(unittest.TestCase):
    def test_rounds_to_three_decimals(self) -> None:
        doc = make_scene()
        doc["paper"]["width_pt"] = 841.889764
        doc["paper"]["height_pt"] = 595.275591
        doc["map"]["x"] = 28.0004
        doc["map"]["width_pt"] = 597.7004
        doc["items"][0]["font_size_pt"] = 18.0
        doc["items"][0]["line_height"] = 1.3500
        scene = page.normalize_scene(doc, figure="x.svg")
        self.assertEqual(scene["paper"]["width_pt"], 841.89)
        self.assertEqual(scene["paper"]["height_pt"], 595.276)
        self.assertEqual(scene["map"]["x"], 28)
        self.assertIsInstance(scene["map"]["x"], int)
        self.assertEqual(scene["map"]["width_pt"], 597.7)
        self.assertEqual(scene["items"][0]["font_size_pt"], 18)
        self.assertEqual(scene["items"][0]["line_height"], 1.35)

    def test_drops_unknown_fields_and_injects_figure(self) -> None:
        doc = make_scene()
        doc["ack_base_change"] = True
        doc["items"][0]["unknown"] = 1
        scene = page.normalize_scene(doc, figure="demo/x.svg")
        self.assertEqual(scene["figure"], "demo/x.svg")
        self.assertNotIn("ack_base_change", scene)
        self.assertNotIn("unknown", scene["items"][0])
        self.assertEqual(
            set(scene),
            {
                "format",
                "version",
                "figure",
                "base",
                "paper",
                "map",
                "frame",
                "style",
                "items",
                "seq",
            },
        )

    def test_base_override_uses_server_truth(self) -> None:
        scene = page.normalize_scene(
            make_scene(),
            figure="x.svg",
            base={"sha256": "b" * 64, "width_pt": 200.4, "height_pt": 100.2},
        )
        self.assertEqual(scene["base"]["sha256"], "b" * 64)
        self.assertEqual(scene["base"]["width_pt"], 200.4)
        self.assertEqual(scene["base"]["height_pt"], 100.2)

    def test_colors_are_lowercased(self) -> None:
        doc = make_scene()
        doc["style"]["color"] = "#ABCDEF"
        doc["items"][0]["color"] = "#AABBCC"
        scene = page.normalize_scene(doc, figure="x.svg")
        self.assertEqual(scene["style"]["color"], "#abcdef")
        self.assertEqual(scene["items"][0]["color"], "#aabbcc")

    def test_canonical_bytes_has_single_trailing_newline(self) -> None:
        scene = page.normalize_scene(make_scene(), figure="x.svg")
        data = page.canonical_bytes(scene)
        self.assertTrue(data.endswith(b"\n"))
        self.assertFalse(data.endswith(b"\n\n"))
        text = data.decode("utf-8")
        self.assertNotIn(": ", text)
        self.assertNotIn(", ", text)
        self.assertEqual(json.loads(text), scene)

    def test_digest_is_key_order_independent(self) -> None:
        first = page.normalize_scene(make_scene(), figure="x.svg")
        second = copy.deepcopy(first)
        # 打乱顶层键序: digest 只认规范 JSON, 与插入顺序无关.
        shuffled = {key: second[key] for key in reversed(list(second))}
        self.assertEqual(page.scene_digest(first), page.scene_digest(shuffled))
        self.assertEqual(
            page.scene_digest(first),
            hashlib.sha256(page.canonical_json(first).encode("utf-8")).hexdigest(),
        )

    def test_digest_changes_with_content(self) -> None:
        doc = make_scene()
        first = page.normalize_scene(doc, figure="x.svg")
        doc["items"][0]["lines"] = ["另一个标题"]
        second = page.normalize_scene(doc, figure="x.svg")
        self.assertNotEqual(page.scene_digest(first), page.scene_digest(second))

    def test_normalize_is_idempotent(self) -> None:
        scene = page.normalize_scene(make_scene(), figure="x.svg")
        again = page.normalize_scene(scene, figure=scene["figure"])
        self.assertEqual(scene, again)
        self.assertEqual(page.scene_digest(scene), page.scene_digest(again))

    def test_round_number_matches_js_round(self) -> None:
        self.assertEqual(page.round_number(28.0), 28)
        self.assertEqual(page.round_number(-0.0), 0)
        self.assertEqual(page.round_number(0.3125), 0.313)
        self.assertEqual(page.round_number(-0.3125), -0.312)
        self.assertEqual(page.round_number(1.2346), 1.235)
        self.assertEqual(page.round_number(float("nan")), 0)


class DerivedValueTest(unittest.TestCase):
    def test_map_height_keeps_aspect_ratio(self) -> None:
        scene = page.normalize_scene(make_scene(), figure="x.svg")
        self.assertEqual(page.map_height(scene, {"width_pt": 200.0, "height_pt": 100.0}), 50.0)
        self.assertEqual(page.map_height(scene, {"width_pt": 400.0, "height_pt": 100.0}), 25.0)

    def test_map_height_rejects_zero_base_width(self) -> None:
        scene = page.normalize_scene(make_scene(), figure="x.svg")
        with self.assertRaises(page.SceneError):
            page.map_height(scene, {"width_pt": 0.0, "height_pt": 100.0})

    def test_item_counts(self) -> None:
        scene = page.normalize_scene(make_scene(), figure="x.svg")
        self.assertEqual(
            page.item_counts(scene),
            {"text": 1, "legend": 1, "colorbar": 1, "total": 3},
        )
        scene["items"] = []
        self.assertEqual(
            page.item_counts(scene),
            {"text": 0, "legend": 0, "colorbar": 0, "total": 0},
        )


if __name__ == "__main__":
    unittest.main()
