"""Something is always running, so Task Manager is never empty.

A ``@continuous`` schedule starts the next run the moment the previous one ends, and
``max_active_runs=1`` keeps it to one. Three mapped shards each spend a few minutes
"polling", which gives the process list three ``poll_shard[n].exe`` rows with a real
CPU column: the kernel reports progress against the task's own historical mean, and
these tasks take the same time every run, so the number is honest.
"""

from __future__ import annotations

import time

from airflow.sdk import dag, task

SHARDS = ["orders", "customers", "inventory"]
CYCLE_SECONDS = 180


@dag(
    dag_id="airflow_os_demo_heartbeat",
    schedule="@continuous",
    catchup=False,
    max_active_runs=1,
    is_paused_upon_creation=False,
    tags=["airflow-os", "demo"],
    doc_md=__doc__,
)
def airflow_os_demo_heartbeat():
    @task
    def poll_shard(shard: str) -> int:
        """Watch one change-data-capture shard for a cycle."""
        seen = 0
        for step in range(CYCLE_SECONDS // 15):
            seen += 1
            print(f"[{shard}] cycle {step + 1}: no new change events")
            time.sleep(15)
        return seen

    @task
    def summarise(counts: list[int]) -> int:
        total = sum(counts)
        print(f"{total} polls across {len(counts)} shards; next cycle starts immediately")
        return total

    summarise(poll_shard.expand(shard=SHARDS))


airflow_os_demo_heartbeat()
