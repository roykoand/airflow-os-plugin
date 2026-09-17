"""A dag with a deadline, so the Deadlines mailbox has something to show.

Airflow 3 deadlines let you say "this run must be finished by X" and fire a callback
when it is not. There is no REST API for them and no UI anywhere shows them, which is
why Airflow OS reads them out of the metadata database directly.

This pipeline is deliberately slower than its own deadline: the deadline is 30 seconds
after the run starts, and the work takes rather longer than that. Trigger it, then
watch the deadline go from pending to missed in the mailbox.

The callback is imported from the installed ``airflow_os`` package rather than defined
here: the triggerer imports callbacks by dotted path, and a function inside a dag file
has no importable path outside the dag processor.
"""

from __future__ import annotations

import time
from datetime import timedelta

from airflow.sdk import DAG, DeadlineAlert, DeadlineReference
from airflow.sdk.definitions.deadline import AsyncCallback
from airflow_os.demo_callbacks import deadline_missed

with DAG(
    dag_id="airflow_os_demo_deadline",
    schedule=None,
    catchup=False,
    is_paused_upon_creation=False,
    tags=["airflow-os", "demo"],
    doc_md=__doc__,
    deadline=DeadlineAlert(
        reference=DeadlineReference.DAGRUN_QUEUED_AT,
        interval=timedelta(seconds=30),
        callback=AsyncCallback(deadline_missed),
        name="Nightly load must finish within 30s",
    ),
) as dag:
    from airflow.sdk import task

    @task
    def slow_extract() -> int:
        """Takes 75 seconds, which is 45 seconds more than we promised."""
        for step in range(5):
            print(f"extracting chunk {step + 1} of 5")
            time.sleep(15)
        return 5

    slow_extract()
