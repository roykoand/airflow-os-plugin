"""Clippy: the Airflow OS failure assistant.

    "It looks like your dag failed. Would you like help with that?"

The desktop collects the evidence for a failed task instance - the tail of its log,
its metadata, and the states of its siblings in the run - and triggers this dag with
that payload in ``dag_run.conf``. The dag turns it into an explanation.

Why the evidence arrives in ``conf`` rather than being gathered here: Airflow 3 task
code has no metadata database access. Tasks run under the Task SDK and reach the
scheduler over the Task Execution API, so ``create_session()`` inside a task raises
``RuntimeError: Session must be set before!``. The Airflow OS plugin runs inside the
api-server, which does have DB access, so it does the collecting (and the permission
checks that go with reading someone's logs). That leaves this dag as purely the
agentic step, which is what you want auditable, retryable and logged as a task.

Configure the model with two Airflow Variables, both optional:

    airflow_os_llm_conn_id   default: anthropic_default
    airflow_os_llm_model_id  default: anthropic:claude-opus-5

Both are read through Jinja rather than ``Variable.get()`` at module scope: the
operator marks them templatable, so this way the lookup happens once per task run
instead of on every dag-processor parse loop.
"""

from __future__ import annotations

import json
from typing import Any

from airflow.sdk import dag, task
from pydantic import BaseModel, Field

SYSTEM_PROMPT = """
You are Clippy, the assistant from Windows 95, now employed triaging Apache Airflow
task failures. You are cheerful and concise, but you are a genuinely good engineer and
you never invent facts.

You will be given the evidence from one failed Airflow task instance: the tail of its
log, its metadata, and the states of the other tasks in its dag run. Explain what went
wrong.

Rules:
- Base every claim on the evidence. If the log does not show a root cause, say so and
  set confidence to "low" rather than guessing.
- If the task failed only because an upstream task failed, say that plainly and name
  the upstream task; do not invent a cause of your own.
- suggested_fix must be a concrete next action, not general advice.
- Keep headline under 70 characters. Stay in character, but keep it to one light
  touch; the person reading this is debugging a production pipeline.
""".strip()


class ClippyVerdict(BaseModel):
    """What Clippy shows in the speech balloon."""

    headline: str = Field(description="One-line summary of the failure, under 70 characters.")
    explanation: str = Field(description="Two or three sentences on what actually happened.")
    likely_cause: str = Field(description="The most probable root cause, grounded in the evidence.")
    suggested_fix: str = Field(description="One concrete next action the operator should take.")
    confidence: str = Field(description="One of: high, medium, low.")


@dag(
    dag_id="airflow_os_clippy",
    schedule=None,
    catchup=False,
    # Clippy is triggered on demand by the desktop; if this dag were paused the
    # trigger would succeed and then silently never run.
    is_paused_upon_creation=False,
    max_active_runs=8,
    tags=["airflow-os", "assistant"],
    doc_md=__doc__,
    params={"evidence": {}},
)
def airflow_os_clippy():
    @task.llm(
        llm_conn_id="{{ var.value.get('airflow_os_llm_conn_id', 'anthropic_default') }}",
        model_id="{{ var.value.get('airflow_os_llm_model_id', 'anthropic:claude-opus-5') }}",
        system_prompt=SYSTEM_PROMPT,
        output_type=ClippyVerdict,
        serialize_output=True,
    )
    def explain_failure(**context: Any) -> str:
        """Build the prompt. The decorator makes the model call and stores the verdict."""
        evidence = context["params"].get("evidence") or {}
        required = ("dag_id", "run_id", "task_id")
        missing = [field for field in required if not evidence.get(field)]
        if missing:
            raise ValueError(
                "Clippy needs an 'evidence' object in the dag run conf, with at least "
                f"{', '.join(required)}. Missing: {', '.join(missing)}."
            )

        casualties = [
            item
            for item in evidence.get("run_task_states", [])
            if item.get("state") in {"failed", "upstream_failed", "skipped"}
            and item.get("task_id") != evidence["task_id"]
        ]

        return f"""
A task instance failed in Apache Airflow. Here is everything known about it.

Task:      {evidence["dag_id"]}.{evidence["task_id"]} (map index {evidence.get("map_index", -1)})
Dag run:   {evidence["run_id"]}
State:     {evidence.get("state")}
Operator:  {evidence.get("operator")}
Attempt:   {evidence.get("tries")}
Duration:  {evidence.get("duration_seconds")} seconds
Host:      {evidence.get("hostname")}
Pool:      {evidence.get("pool")} / queue {evidence.get("queue")}

Other tasks in this run that failed, were skipped, or failed upstream:
{json.dumps(casualties, indent=2) if casualties else "(none - this task is the only casualty)"}

Tail of the task log:
--------------------------------------------------------------------------------
{evidence.get("log_tail", "(no log was captured)")}
--------------------------------------------------------------------------------

Explain what went wrong.
""".strip()

    explain_failure()


airflow_os_clippy()
