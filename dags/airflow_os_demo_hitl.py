"""Release approval: three human-in-the-loop requests, so the message boxes have mail.

Airflow 3.1's HITL operators park a task until a person answers. Airflow OS renders
each pending request as a Windows message box whose buttons are the operator's
``options``, badged on the desktop icon and in the tray. This dag raises all three
request shapes at once, in parallel, so a single run fills the inbox:

* ``approve_release``     ApprovalOperator: Approve / Reject
* ``choose_regions``      HITLOperator with ``multiple=True``: checkboxes seeded from defaults
* ``set_rollout_params``  HITLEntryOperator: a form built from ``params``

It runs hourly. Every request carries ``defaults`` and a 55-minute
``response_timeout``, so an ignored request resolves to its default instead of
failing and the next run brings fresh ones. Answer them from Human Input Required
on the desktop, or leave them for the screenshot.
"""

from __future__ import annotations

from datetime import timedelta

from airflow.providers.standard.operators.hitl import (
    ApprovalOperator,
    HITLEntryOperator,
    HITLOperator,
)
from airflow.sdk import Param, dag, task

RELEASE = "2026.09.16"


@dag(
    dag_id="airflow_os_demo_hitl",
    schedule="@hourly",
    catchup=False,
    max_active_runs=1,
    is_paused_upon_creation=False,
    tags=["airflow-os", "demo", "hitl"],
    doc_md=__doc__,
)
def airflow_os_demo_hitl():
    @task
    def build_release() -> str:
        """Package the release. Instant, because the point is what comes next."""
        artifact = f"acme-analytics-{RELEASE}.whl"
        print(f"Built {artifact}")
        return artifact

    approve_release = ApprovalOperator(
        task_id="approve_release",
        subject=f"Release {RELEASE} to production?",
        body=(
            "The nightly warehouse loads and the dbt transforms passed on staging. "
            "Approving deploys to all selected regions."
        ),
        defaults="Reject",
        response_timeout=timedelta(minutes=55),
    )

    choose_regions = HITLOperator(
        task_id="choose_regions",
        subject="Which regions receive this release?",
        body="Tick every region to roll out to. eu-central-1 is the canary and is pre-selected.",
        options=["eu-central-1", "eu-west-1", "us-east-1", "ap-southeast-2"],
        defaults=["eu-central-1"],
        multiple=True,
        response_timeout=timedelta(minutes=55),
    )

    set_rollout_params = HITLEntryOperator(
        task_id="set_rollout_params",
        subject="Rollout parameters",
        body="Canary share and where to announce. Types are preserved when sent back.",
        params={
            "canary_percent": Param(10, type="integer", minimum=1, maximum=100),
            "soak_minutes": Param(30, type="integer"),
            "notify_channel": Param("#releases", type="string"),
            "page_oncall_on_error": Param(True, type="boolean"),
        },
        response_timeout=timedelta(minutes=55),
    )

    @task(trigger_rule="none_failed")
    def deploy(artifact: str) -> str:
        """Runs once every request has an answer, human or default."""
        print(f"Deploying {artifact}")
        return artifact

    artifact = build_release()
    artifact >> [approve_release, choose_regions, set_rollout_params] >> deploy(artifact)


airflow_os_demo_hitl()
