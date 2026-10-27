"""scene 校验/规范化/摘要的单测.

覆盖: 规范化键序与紧凑分隔符、3 位小数去尾零、digest 稳定、未知字段拒绝、
text(P3)拒绝、引用校验、seq 校验、数量上限、16 种约束全字段往返、空场景、load 往返.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from mapdoc import contract, scene

from . import helpers


class CanonicalFormTest(unittest.TestCase):
    def test_key_order_separators_and_no_trailing_newline(self) -> None:
        points, entities = helpers.full_geometry_entities()
        scan = helpers.make_scene(
            helpers.payload(seq=200, points=points, entities=entities)
        )
        data = scene.canonical_bytes(scan)
        self.assertFalse(data.endswith(b"\n"))
        text = data.decode("utf-8")
        self.assertNotIn(": ", text)
        self.assertNotIn(", ", text)
        document = json.loads(text)
        # 键排序: 顶层与嵌套对象都按字典序写盘, 保证 diff 稳定.
        self.assertEqual(list(document), sorted(document))
        self.assertEqual(list(document["base"]), sorted(document["base"]))
        self.assertEqual(list(document["style"]), sorted(document["style"]))
        self.assertEqual(list(document["points"][0]), sorted(document["points"][0]))
        self.assertEqual(document["format"], "mapdoc-scene")
        self.assertEqual(document["version"], 1)
        self.assertEqual(document["figure"], "demo/figures/Volga/map.svg")

    def test_three_decimal_rounding_and_negative_zero(self) -> None:
        scan = helpers.make_scene(
            helpers.payload(
                points=[helpers.point(1, 1.23456, -0.0004)],
                seq=2,
            )
        )
        document = helpers.canonical_json(scan)
        self.assertEqual(document["points"][0]["x"], 1.235)
        self.assertEqual(document["points"][0]["y"], 0.0)
        self.assertNotIn("-0.0", scene.canonical_bytes(scan).decode("utf-8"))
        self.assertEqual(scene.round3(-0.0), 0.0)
        self.assertEqual(scene.round3(12.34567), 12.346)

    def test_style_values_are_rounded_and_lowercased(self) -> None:
        scan = helpers.make_scene(
            helpers.payload(
                style_body=helpers.style(
                    stroke="#C62828",
                    stroke_width_pt=1.23456,
                    construction_dash_pt=[4.0004, 4.0],
                    point_radius_pt=1.60004,
                    font_size_pt=9.00004,
                    text_color="#ABCDEF",
                )
            )
        )
        document = helpers.canonical_json(scan)
        self.assertEqual(document["style"]["stroke"], "#c62828")
        self.assertEqual(document["style"]["text_color"], "#abcdef")
        self.assertEqual(document["style"]["stroke_width_pt"], 1.235)
        self.assertEqual(document["style"]["construction_dash_pt"], [4.0, 4.0])
        self.assertEqual(document["style"]["point_radius_pt"], 1.6)

    def test_digest_stable_and_ignores_claim_and_ack(self) -> None:
        base = helpers.base_info()
        first = helpers.make_scene(
            helpers.payload(
                base=helpers.base_claim(base),
                points=[helpers.point(1, 10.0, 20.0)],
                seq=2,
            )
        )
        other_claim = {"sha256": "f" * 64, "width_pt": 200.0, "height_pt": 100.0}
        second = helpers.make_scene(
            helpers.payload(
                base=other_claim,
                ack_base_change=True,
                points=[helpers.point(1, 10.0, 20.0)],
                seq=2,
            )
        )
        self.assertEqual(scene.canonical_bytes(first), scene.canonical_bytes(second))
        self.assertEqual(scene.digest(first), scene.digest(second))
        self.assertEqual(
            scene.digest(first), contract.sha256(scene.canonical_bytes(first))
        )

    def test_empty_scene_has_no_arrays(self) -> None:
        scan = scene.empty_scene("demo/figures/Volga/map.svg", helpers.base_info())
        document = helpers.canonical_json(scan)
        self.assertEqual(document["seq"], 1)
        self.assertEqual(document["points"], [])
        self.assertEqual(document["entities"], [])
        self.assertEqual(document["constraints"], [])
        self.assertEqual(document["base"]["sha256"], helpers.base_info().sha256)


class PayloadValidationTest(unittest.TestCase):
    def test_unknown_top_level_field_rejected(self) -> None:
        body = helpers.payload()
        body["mystery"] = 1
        with self.assertRaises(scene.SceneError) as raised:
            scene.parse_payload(body)
        self.assertIn("未知字段", str(raised.exception))
        self.assertEqual(raised.exception.code, "invalid_scene")

    def test_unknown_style_field_rejected(self) -> None:
        body = helpers.payload(style_body=helpers.style(unknown=1))
        with self.assertRaises(scene.SceneError):
            scene.parse_payload(body)

    def test_unknown_entity_field_rejected(self) -> None:
        body = helpers.payload(
            points=[helpers.point(1, 1.0, 2.0), helpers.point(2, 3.0, 4.0)],
            entities=[
                {"id": 3, "type": "line", "a": 1, "b": 2, "construction": False, "x": 1}
            ],
            seq=4,
        )
        with self.assertRaises(scene.SceneError):
            scene.parse_payload(body)

    def test_text_rejected_as_p3(self) -> None:
        body = helpers.payload(
            points=[helpers.point(1, 1.0, 2.0)],
            entities=[
                {
                    "id": 2,
                    "type": "text",
                    "p": 1,
                    "text": "伏尔加格勒",
                    "angle": 0.0,
                    "font_size_pt": 9.0,
                    "fill": "#111111",
                    "anchor": "start",
                }
            ],
            seq=3,
        )
        with self.assertRaises(scene.SceneError) as raised:
            scene.parse_payload(body)
        self.assertIn("P3", str(raised.exception))
        self.assertIn("text 注记未实现", str(raised.exception))

    def test_bad_color_and_non_finite_number(self) -> None:
        with self.assertRaises(scene.SceneError):
            scene.parse_payload(helpers.payload(style_body=helpers.style(stroke="#12345")))
        body = helpers.payload(points=[helpers.point(1, float("nan"), 0.0)])
        with self.assertRaises(scene.SceneError):
            scene.parse_payload(body)

    def test_missing_required_fields(self) -> None:
        for missing in ("base", "style", "seq", "points", "entities", "constraints"):
            body = helpers.payload()
            del body[missing]
            with self.assertRaises(scene.SceneError, msg=missing):
                scene.parse_payload(body)


class ReferenceValidationTest(unittest.TestCase):
    def test_entity_reference_must_exist(self) -> None:
        body = helpers.payload(
            points=[helpers.point(1, 0.0, 0.0)],
            entities=[
                {"id": 2, "type": "line", "a": 1, "b": 99, "construction": False}
            ],
            seq=3,
        )
        with self.assertRaises(scene.SceneError) as raised:
            scene.parse_payload(body)
        self.assertIn("不存在的点", str(raised.exception))

    def test_constraint_entity_kind_checked(self) -> None:
        points, entities = helpers.full_geometry_entities()
        body = helpers.payload(
            seq=200,
            points=points,
            entities=entities,
            constraints=[{"id": 40, "type": "horizontal", "e": 8}],
        )
        with self.assertRaises(scene.SceneError) as raised:
            scene.parse_payload(body)
        self.assertIn("需要 line", str(raised.exception))

    def test_constraint_point_ref_must_be_point(self) -> None:
        points, entities = helpers.full_geometry_entities()
        body = helpers.payload(
            seq=200,
            points=points,
            entities=entities,
            constraints=[{"id": 40, "type": "coincident", "a": 6, "b": 1}],
        )
        with self.assertRaises(scene.SceneError) as raised:
            scene.parse_payload(body)
        self.assertIn("不存在的点", str(raised.exception))

    def test_arc_center_must_differ_from_endpoints(self) -> None:
        body = helpers.payload(
            points=[helpers.point(1, 0.0, 0.0), helpers.point(2, 5.0, 0.0)],
            entities=[{"id": 3, "type": "arc", "c": 1, "a": 1, "b": 2, "construction": False}],
            seq=4,
        )
        with self.assertRaises(scene.SceneError) as raised:
            scene.parse_payload(body)
        self.assertIn("半径必须 > 0", str(raised.exception))

    def test_constraint_numeric_field_not_allowed_for_kind(self) -> None:
        points, entities = helpers.full_geometry_entities()
        body = helpers.payload(
            seq=200,
            points=points,
            entities=entities,
            constraints=[{"id": 40, "type": "horizontal", "e": 6, "offset": 3.0}],
        )
        with self.assertRaises(scene.SceneError):
            scene.parse_payload(body)

    def test_angle_sector_out_of_range(self) -> None:
        points, entities = helpers.full_geometry_entities()
        body = helpers.payload(
            seq=200,
            points=points,
            entities=entities,
            constraints=[
                {
                    "id": 40,
                    "type": "angleLineLine",
                    "e1": 6,
                    "e2": 7,
                    "angle": 30.0,
                    "angleSector": 9,
                }
            ],
        )
        with self.assertRaises(scene.SceneError):
            scene.parse_payload(body)


class IdAndLimitTest(unittest.TestCase):
    def test_duplicate_id_across_containers_rejected(self) -> None:
        body = helpers.payload(
            points=[helpers.point(1, 0.0, 0.0), helpers.point(2, 1.0, 1.0)],
            entities=[{"id": 1, "type": "point", "p": 2, "construction": False}],
            seq=3,
        )
        with self.assertRaises(scene.SceneError) as raised:
            scene.parse_payload(body)
        self.assertIn("同时被", str(raised.exception))

    def test_seq_must_exceed_max_id(self) -> None:
        body = helpers.payload(
            points=[helpers.point(5, 0.0, 0.0)],
            seq=5,
        )
        with self.assertRaises(scene.SceneError) as raised:
            scene.parse_payload(body)
        self.assertIn("seq", str(raised.exception))

    def test_seq_must_be_positive(self) -> None:
        with self.assertRaises(scene.SceneError):
            scene.parse_payload(helpers.payload(seq=0))

    def test_count_limits(self) -> None:
        points = [helpers.point(index + 1, float(index), 0.0) for index in range(scene.MAX_COUNT + 1)]
        body = helpers.payload(points=points, seq=scene.MAX_COUNT + 2)
        with self.assertRaises(scene.SceneError) as raised:
            scene.parse_payload(body)
        self.assertIn("超过上限", str(raised.exception))

    def test_figure_path_rejects_parent_segments(self) -> None:
        with self.assertRaises(scene.SceneError):
            helpers.make_scene(figure="../escape.svg")
        with self.assertRaises(scene.SceneError):
            helpers.make_scene(figure="Volga/../../escape.svg")
        # 绝对路径只是元信息(图在仓库外时出现), 服务器不会按它做 IO.
        scan = helpers.make_scene(figure="/tmp/figures/map.svg")
        self.assertEqual(scan.figure, "/tmp/figures/map.svg")


class ConstraintRoundTripTest(unittest.TestCase):
    def test_all_16_constraint_kinds_full_field_roundtrip(self) -> None:
        body = helpers.full_constraint_payload()
        scan = helpers.make_scene(body)
        document = helpers.canonical_json(scan)
        self.assertEqual(len(document["constraints"]), 16)

        # 写盘字节 → 重新解析 → 再规范化, 字节与 digest 必须完全一致.
        reloaded = scene.scene_from_document(document)
        self.assertEqual(scene.canonical_bytes(reloaded), scene.canonical_bytes(scan))
        self.assertEqual(scene.digest(reloaded), scene.digest(scan))

        by_type = {item["type"]: item for item in document["constraints"]}
        self.assertEqual(set(by_type), set(scene.CONSTRAINT_META))
        # 作者态字段必须原样留存(角度用度; offset/leaderAngle 世界单位; angleSector 象限位).
        distance = by_type["distancePointPoint"]
        self.assertEqual(distance["distance"], 40.0)
        self.assertEqual(distance["offset"], -8.0)
        radius = by_type["radius"]
        self.assertEqual(radius["radius"], 12.5)
        self.assertEqual(radius["leaderAngle"], 0.7)
        angle = by_type["angleLineLine"]
        self.assertEqual(angle["angle"], 30.0)
        self.assertEqual(angle["offset"], 30.0)
        self.assertEqual(angle["angleSector"], 1)
        self.assertIsInstance(angle["angleSector"], int)
        # 引用字段镜像 constraints-meta: 逐条核对键集合.
        for item in document["constraints"]:
            meta = scene.CONSTRAINT_META[item["type"]]
            expected_keys = {"id", "type"} | {ref[0] for ref in meta}
            expected_keys |= set(scene.CONSTRAINT_REQUIRED_NUMBERS.get(item["type"], ()))
            expected_keys |= {
                key
                for key in scene.CONSTRAINT_OPTIONAL_NUMBERS.get(item["type"], ())
                if key in item
            }
            self.assertEqual(set(item), expected_keys)

    def test_construction_flag_roundtrip(self) -> None:
        points, entities = helpers.full_geometry_entities()
        scan = helpers.make_scene(
            helpers.payload(seq=200, points=points, entities=entities)
        )
        document = helpers.canonical_json(scan)
        flags = {item["id"]: item["construction"] for item in document["entities"]}
        self.assertFalse(flags[6])
        self.assertTrue(flags[7])
        self.assertTrue(flags[11])
        reloaded = scene.scene_from_document(helpers.scene_document(scan))
        self.assertEqual(scene.canonical_bytes(reloaded), scene.canonical_bytes(scan))


class LoadAndValidateTest(unittest.TestCase):
    def test_load_missing_returns_none(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(scene.load(Path(directory) / "missing.scene.json"))

    def test_load_corrupt_raises(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.scene.json"
            path.write_text("{not json", encoding="utf-8")
            with self.assertRaises(scene.SceneError):
                scene.load(path)

    def test_load_roundtrip_from_disk(self) -> None:
        scan = helpers.make_scene(helpers.full_constraint_payload())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.scene.json"
            path.write_bytes(scene.canonical_bytes(scan))
            reloaded = scene.load(path)
            assert reloaded is not None
            self.assertEqual(scene.canonical_bytes(reloaded), scene.canonical_bytes(scan))

    def test_validate_scene_detects_bad_reference(self) -> None:
        scan = helpers.make_scene()
        broken = scene.Scene(
            figure=scan.figure,
            base=scan.base,
            style=scan.style,
            seq=scan.seq,
            points=scan.points,
            entities=(scene.LineEntity(id=5, a=1, b=999, construction=False),),
            constraints=(),
        )
        errors = scene.check_refs(broken)
        self.assertTrue(errors)
        self.assertIn("不存在的点", errors[0])
        self.assertTrue(scene.validate_scene(broken))


if __name__ == "__main__":
    unittest.main()
