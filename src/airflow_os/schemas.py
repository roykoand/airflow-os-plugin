"""Pydantic response models for the Airflow OS kernel API."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class ProcessRow(BaseModel):
    """One row of the Task Manager process list. A process is a task instance."""

    ti_id: str = Field(
        description=(
            "TaskInstance.id. This is the identity - the PID is decoration, and synthetic "
            "PIDs collide, so anything that acts on a process must address it by this."
        )
    )
    pid: int = Field(description="Real worker PID when Airflow reported one, else a stable synthetic id.")
    synthetic_pid: bool = Field(description="True when the PID was derived rather than reported.")
    image_name: str = Field(description="Win95-style executable name, e.g. 'extract_orders.exe'.")
    dag_id: str
    run_id: str
    task_id: str
    map_index: int
    display_name: str
    owner: str
    state: str
    cpu: float = Field(description="Percent of the task's historical mean duration already elapsed, 0-100.")
    elapsed: float = Field(description="Seconds since the task instance started.")
    mem_k: int = Field(description="Pool slots held by this task, expressed in KB for the Win95 column.")
    try_number: int
    max_tries: int
    priority: str = Field(description="priority_weight bucketed into Win95 priority-class names.")
    priority_weight: int
    pool: str
    pool_slots: int
    operator: str | None = None
    hostname: str | None = None
    queue: str | None = None
    executor: str | None = None
    start_date: datetime | None = None
    end_date: datetime | None = None
    is_deferred: bool = False


class PerformanceInfo(BaseModel):
    """The Task Manager 'Performance' tab. Every number here is real Airflow state."""

    cpu_usage: float = Field(description="Running slots as a percent of core.parallelism.")
    cpu_running: int
    cpu_total: int
    mem_usage: float = Field(description="Occupied pool slots as a percent of all pool slots.")
    mem_used_slots: int
    mem_total_slots: int
    queued: int
    deferred: int
    running_dag_runs: int
    handles: int = Field(description="Total task instances tracked, the Win95 'Handles' counter.")
    threads: int = Field(description="Distinct hosts running tasks, the Win95 'Threads' counter.")
    processes: int


class SystemInfo(BaseModel):
    """The 'System Properties' control panel page."""

    airflow_version: str
    airflow_os_version: str
    bundle_built: str | None = None
    python_version: str
    executor: str
    auth_manager: str
    timezone: str
    dag_bundles: list[str]
    scheduler_alive: bool
    scheduler_heartbeat: datetime | None = None
    scheduler_hostname: str | None = None
    uptime_seconds: float | None = None
    dags_total: int
    dags_paused: int
    dags_broken: int
    parallelism: int
    max_active_tasks_per_dag: int
    performance: PerformanceInfo


class FsEntry(BaseModel):
    """One item in an Explorer listing."""

    name: str
    path: str
    kind: str = Field(description="One of: drive, folder, file.")
    icon: str = Field(description="Icon key the desktop maps to a sprite.")
    size: int | None = None
    modified: datetime | None = None
    state: str | None = None
    detail: str | None = None
    # Set on task-instance folders and log files so the shell can open a log without
    # having to parse the path back into (task_id, map_index, try_number) - task ids
    # may contain dots, which makes that parse ambiguous.
    task_id: str | None = None
    map_index: int | None = None
    try_number: int | None = None


class FsListing(BaseModel):
    path: str
    title: str
    parent: str | None = None
    entries: list[FsEntry]


class FsFile(BaseModel):
    path: str
    name: str
    content: str
    language: str = "text"
    truncated: bool = False


class KillResult(BaseModel):
    pid: int
    task_id: str
    dag_id: str
    run_id: str
    previous_state: str | None
    new_state: str



class HitlRequest(BaseModel):
    """One human-in-the-loop request, as the Inbox renders it."""

    ti_id: str
    dag_id: str
    run_id: str
    task_id: str
    map_index: int
    task_state: str | None = None
    subject: str
    body: str | None = None
    options: list[str] = Field(default_factory=list)
    defaults: list[str] | None = None
    multiple: bool = False
    params: dict[str, Any] = Field(default_factory=dict)
    assignees: list[dict[str, str]] = Field(default_factory=list)
    created_at: datetime | None = None
    responded_at: datetime | None = None
    responded_by: str | None = None
    chosen_options: list[str] | None = None


class RecycledItem(BaseModel):
    """One item in the Recycle Bin: something Airflow deleted but did not throw away."""

    key: str = Field(description="Stable identity for selection.")
    kind: str = Field(description="'dag' for a stale dag, 'task' for a removed task instance.")
    name: str
    dag_id: str
    run_id: str | None = None
    task_id: str | None = None
    map_index: int | None = None
    deleted_at: datetime | None = Field(default=None, description="When Airflow last saw it.")
    detail: str | None = None
    restorable: bool = Field(
        default=False,
        description="False for stale dags: restoring one means putting its file back on disk.",
    )


class DeadlineItem(BaseModel):
    """One deadline, as the mailbox renders it.

    Deadlines have no public REST API, so this is assembled from the ``deadline`` and
    ``deadline_alert`` tables directly.
    """

    id: str
    dag_id: str | None = None
    run_id: str | None = None
    name: str | None = None
    description: str | None = None
    deadline_time: datetime
    missed: bool
    created_at: datetime | None = None
    reference: str | None = Field(default=None, description="Rendered DeadlineReference.")
    interval: str | None = Field(default=None, description="Rendered interval.")
    callback: str | None = Field(default=None, description="The callback that fires on a miss.")
    dag_run_state: str | None = None
