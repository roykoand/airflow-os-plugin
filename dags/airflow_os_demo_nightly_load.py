"""A scheduled load with a deadline it cannot meet, so the mailbox keeps filling.

``airflow_os_demo_deadline`` is the manual version. This one runs every 20 minutes
with a 30-second deadline and 75 seconds of work, so every run turns into another
missed deadline: unread mail, bold, flag up. ``max_active_runs=1`` and
``catchup=False`` keep it to one miss per interval.
"""

from __future__ import annotations

import time
from datetime import timedelta

from airflow.sdk import DAG, DeadlineAlert, DeadlineReference, task
from airflow.sdk.definitions.deadline import AsyncCallback

from airflow_os.demo_callbacks import escalate

with DAG(
    dag_id="airflow_os_demo_nightly_load",
    schedule="*/20 * * * *",
    catchup=False,
    max_active_runs=1,
    is_paused_upon_creation=False,
    tags=["airflow-os", "demo", "deadline"],
    doc_md=__doc__,
    deadline=DeadlineAlert(
        reference=DeadlineReference.DAGRUN_QUEUED_AT,
        interval=timedelta(seconds=30),
        callback=AsyncCallback(escalate),
        name="Finance pack must land within 30s of queueing",
    ),
) as dag:

    @task
    def extract_ledger() -> int:
        """Pulls the general ledger. Slower than promised, every time."""
        for step in range(5):
            print(f"extracting ledger partition {step + 1} of 5")
            time.sleep(15)
        return 5

    @task
    def build_finance_pack(partitions: int) -> str:
        print(f"Built the finance pack from {partitions} partitions")
        return "finance_pack.xlsx"

    build_finance_pack(extract_ledger())
