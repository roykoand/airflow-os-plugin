"""The kernel's pure helpers: PIDs, path grammar, naming. No database needed."""

from __future__ import annotations

import pytest
from airflow_os import kernel


class TestSyntheticPid:
    def test_is_stable_and_in_the_windows_95_range(self):
        pid = kernel.synthetic_pid("dag", "run", "task", -1)
        assert pid == kernel.synthetic_pid("dag", "run", "task", -1)
        assert 1024 <= pid < 1024 + 64512

    def test_map_index_and_run_change_the_pid(self):
        base = kernel.synthetic_pid("dag", "run", "task", -1)
        assert kernel.synthetic_pid("dag", "run", "task", 0) != base
        assert kernel.synthetic_pid("dag", "run2", "task", -1) != base

    def test_separator_cannot_be_forged_by_task_ids(self):
        # The key joins with NUL, so "a.b"/"c" and "a"/"b.c" never collide by concatenation.
        assert kernel.synthetic_pid("d", "r", "a.b", -1) != kernel.synthetic_pid("d", "r", "a", -1)


class TestNaming:
    @pytest.mark.parametrize(
        ("task_id", "map_index", "expected"),
        [
            ("parse_prices", -1, "parse_prices.exe"),
            ("group.inner_task", -1, "group_inner_task.exe"),
            ("poll_shard", 2, "poll_shard[2].exe"),
        ],
    )
    def test_image_name(self, task_id, map_index, expected):
        assert kernel._image_name(task_id, map_index) == expected

    def test_priority_classes_are_monotonic(self):
        labels = [kernel._priority_class(weight) for weight in (-5, 0, 1, 10, 50, 100, 10_000)]
        order = ["Low", "BelowNormal", "Normal", "AboveNormal", "High", "Realtime"]
        ranks = [order.index(label) for label in labels]
        assert ranks == sorted(ranks)
        assert kernel._priority_class(None) == "Normal"

    @pytest.mark.parametrize(
        ("seconds", "expected"),
        [(1, "1 second"), (30.0, "30 seconds"), (90, "1m 30s"), (120, "2m"), (5400, "1h 30m"), (7200, "2h")],
    )
    def test_humanise_seconds(self, seconds, expected):
        assert kernel._humanise_seconds(seconds) == expected


class TestPathGrammar:
    @pytest.mark.parametrize(
        ("path", "segments"),
        [
            ("C:", []),
            ("C:/", []),
            ("c:\\my_dag\\run_1", ["my_dag", "run_1"]),
            ("C:/my_dag/run_1/task.with.dots/xcom", ["my_dag", "run_1", "task.with.dots", "xcom"]),
            ("", []),
            ("//C://a//b//", ["a", "b"]),
        ],
    )
    def test_segments(self, path, segments):
        assert kernel.path_segments(path) == segments

    def test_join_and_parent_round_trip(self):
        path = kernel._join("dag", "run", "task")
        assert path == "C:/dag/run/task"
        assert kernel._parent(path) == "C:/dag/run"
        assert kernel._parent("C:/dag") == "C:"
        assert kernel._parent("C:") is None

    @pytest.mark.parametrize(
        ("task_id", "map_index", "folder"),
        [("extract", -1, "extract"), ("extract", 0, "extract.0"), ("a.b", 3, "a.b.3")],
    )
    def test_task_folder_names_carry_the_map_index(self, task_id, map_index, folder):
        assert kernel._task_folder_name(task_id, map_index) == folder
