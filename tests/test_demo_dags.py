"""The demo dags: they parse, and what they promise the desktop is really there.

The deadline callback test exists because of a bug this caught: a callback defined
inside a dag file has no importable path outside the dag processor, so the triggerer
logged "Failed to import the callable" and the alert never fired. Every callback must
resolve from a plain ``import_string``, the way the triggerer does it.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

DAGS = Path(os.environ.get("AIRFLOW_OS_DAGS_FOLDER", Path(__file__).resolve().parents[1] / "dags"))
if not DAGS.exists():  # inside the container the dags are mounted at AIRFLOW_HOME/dags
    DAGS = Path(os.environ.get("AIRFLOW_HOME", "/opt/airflow")) / "dags"


@pytest.fixture(scope="module")
def bag():
    try:
        from airflow.models.dagbag import DagBag
    except Exception as cause:  # pragma: no cover - only without Airflow installed
        pytest.skip(f"Airflow is not importable here: {cause}")
    if not DAGS.exists():
        pytest.skip(f"no dags folder at {DAGS}")
    return DagBag(dag_folder=str(DAGS))


def _deadlines(dag):
    deadline = getattr(dag, "deadline", None)
    if deadline is None:
        return []
    return deadline if isinstance(deadline, list) else [deadline]


def test_every_demo_dag_parses(bag):
    assert bag.import_errors == {}
    expected = {"airflow_os_demo_failure", "airflow_os_demo_hitl", "airflow_os_demo_heartbeat"}
    assert expected <= set(bag.dag_ids)


def test_demo_dags_are_tagged_and_unpaused(bag):
    for dag_id in bag.dag_ids:
        dag = bag.get_dag(dag_id)
        assert "airflow-os" in set(dag.tags), dag_id
        assert dag.is_paused_upon_creation is False, dag_id


def test_deadline_callbacks_are_importable_by_the_triggerer(bag):
    import importlib

    def import_string(path: str):
        module, _, attribute = path.rpartition(".")
        return getattr(importlib.import_module(module), attribute)

    seen = 0
    for dag_id in bag.dag_ids:
        for deadline in _deadlines(bag.get_dag(dag_id)):
            path = deadline.callback.path
            assert not path.startswith("unusual_prefix_"), f"{dag_id}: callback defined inside the dag file"
            assert callable(import_string(path)), f"{dag_id}: {path} does not import"
            seen += 1
    assert seen >= 2, "expected both deadline demo dags to declare a deadline"


def test_hitl_demo_raises_all_three_request_shapes(bag):
    dag = bag.get_dag("airflow_os_demo_hitl")
    operators = {task.task_id: type(task).__name__ for task in dag.tasks}
    assert operators["approve_release"] == "ApprovalOperator"
    assert operators["choose_regions"] == "HITLOperator"
    assert operators["set_rollout_params"] == "HITLEntryOperator"
    for task_id in ("approve_release", "choose_regions", "set_rollout_params"):
        task = dag.get_task(task_id)
        assert task.response_timeout is not None, f"{task_id} would fail the run when nobody answers"
        assert task.defaults, f"{task_id} needs a default for the timeout to resolve to"


def test_heartbeat_is_continuous_and_single_run(bag):
    dag = bag.get_dag("airflow_os_demo_heartbeat")
    assert type(dag.timetable).__name__ == "ContinuousTimetable"
    assert dag.max_active_runs == 1
