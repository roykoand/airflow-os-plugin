"""Deadline callbacks for the demo dags.

They live in the installed package rather than in the dag files on purpose. The
triggerer runs a deadline callback by importing it from its dotted path, and a
function defined inside a dag file cannot be imported that way: the dag processor
loads dag files under a mangled module name (``unusual_prefix_<hash>_<file>``) that
exists only in that process. The triggerer then logs "Failed to import the callable"
and the alert silently never fires. The dags folder is not on ``sys.path`` for the
triggerer either, so a sibling module in the dags folder does not help. An installed
package is importable everywhere Airflow runs.
"""

from __future__ import annotations

from typing import Any


def _run_label(context: dict[str, Any]) -> str:
    """Name the run from whatever the triggerer put in the callback context.

    The context is not the task-execution context: there is no top-level ``dag_id``.
    Look in the places it may be, and fall back to listing the keys we did get, so a
    future shape change is visible in the log rather than silently printing None.
    """
    for key in ("dag_id",):
        if context.get(key):
            return str(context[key])
    for holder in ("dag_run", "dagrun", "dag", "deadline"):
        value = context.get(holder)
        if isinstance(value, dict) and value.get("dag_id"):
            return str(value["dag_id"])
        if getattr(value, "dag_id", None):
            return str(value.dag_id)
    return f"a run (context keys: {sorted(context)})"


async def deadline_missed(context: dict[str, Any]) -> None:
    """The manual demo's callback. In real life: page someone."""
    print(f"DEADLINE MISSED for {_run_label(context)} - the nightly load is late")


async def escalate(context: dict[str, Any]) -> None:
    """The scheduled demo's callback. In real life: page whoever owns the finance pack."""
    print(f"DEADLINE MISSED for {_run_label(context)}: the finance pack will be late")
