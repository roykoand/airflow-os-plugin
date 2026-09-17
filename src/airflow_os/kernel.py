"""The Airflow OS kernel.

Everything the Windows 95 shell shows is derived here from live Airflow metadata.
The mapping the whole project rests on:

===========================  ==========================================
Windows 95                   Airflow
===========================  ==========================================
process                      task instance
PID                          ``TaskInstance.pid``, or a stable synthetic id
CPU usage                    running slots / ``core.parallelism``
memory usage                 occupied pool slots / total pool slots
priority class               ``TaskInstance.priority_weight``, bucketed
drive C:                     the Dag bundle
folder                       Dag -> Dag run -> task instance
file                         task log / XCom value / rendered detail
Control Panel applet         Variables, Connections, Pools, config
Event Viewer                 the audit log
===========================  ==========================================
"""

from __future__ import annotations

import platform
import sys
import zlib
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

from airflow.configuration import conf
from airflow.models.connection import Connection
from airflow.models.dag import DagModel
from airflow.models.dagrun import DagRun
from airflow.models.pool import Pool
from airflow.models.taskinstance import TaskInstance as TI
from airflow.models.variable import Variable
from airflow.models.xcom import XComModel
from airflow.utils.state import DagRunState, TaskInstanceState
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from airflow_os import __version__ as AIRFLOW_OS_VERSION
from airflow_os.schemas import (
    FsEntry,
    FsFile,
    FsListing,
    PerformanceInfo,
    ProcessRow,
    SystemInfo,
)
from airflow_os.version_compat import AIRFLOW_VERSION

# Task instances that count as "a running process" in Task Manager. Mirrors the
# set the scheduler considers in-flight.
LIVE_STATES: tuple[TaskInstanceState, ...] = (
    TaskInstanceState.RUNNING,
    TaskInstanceState.QUEUED,
    TaskInstanceState.SCHEDULED,
    TaskInstanceState.DEFERRED,
    TaskInstanceState.UP_FOR_RETRY,
    TaskInstanceState.UP_FOR_RESCHEDULE,
    TaskInstanceState.RESTARTING,
)

# Win95 Task Manager priority classes, mapped from priority_weight.
_PRIORITY_BANDS: tuple[tuple[int, str], ...] = (
    (100, "Realtime"),
    (10, "High"),
    (3, "AboveNormal"),
    (1, "Normal"),
    (0, "BelowNormal"),
)

_MAX_LOG_BYTES = 512 * 1024


def synthetic_pid(dag_id: str, run_id: str, task_id: str, map_index: int) -> int:
    """Derive a stable, Win95-plausible PID for a task instance with no real one.

    Airflow only records ``TaskInstance.pid`` once a worker has actually forked, so
    queued/scheduled/deferred tasks have none. A CRC32 of the task instance key gives
    us something stable across polls (so rows don't jitter) and in the range Windows 95
    used.

    It is decoration, not identity. 64512 slots means a birthday collision is likely
    well before the process list is full - around a 30% chance at 200 rows and 80% at
    500 - so nothing may resolve a process *from* a PID. Acting on a process goes
    through ``ProcessRow.ti_id``, which is ``TaskInstance.id``.
    """
    key = f"{dag_id}\x00{run_id}\x00{task_id}\x00{map_index}".encode()
    return 1024 + (zlib.crc32(key) % 64512)


def _priority_class(weight: int | None) -> str:
    if weight is None:
        return "Normal"
    for threshold, label in _PRIORITY_BANDS:
        if weight >= threshold:
            return label
    return "Low"


def _image_name(task_id: str, map_index: int) -> str:
    """Turn a task_id into an executable name. Mapped tasks get an index suffix."""
    stem = task_id.replace(".", "_")
    if map_index >= 0:
        return f"{stem}[{map_index}].exe"
    return f"{stem}.exe"


def _mean_durations(session: Session, keys: set[tuple[str, str]]) -> dict[tuple[str, str], float]:
    """Mean historical duration per (dag_id, task_id), used to estimate progress.

    This is what powers the CPU column: a task 30 seconds into a job that normally
    takes 60 reads as 50%. Tasks with no history report 0 rather than a guess.
    """
    if not keys:
        return {}
    dag_ids = {dag_id for dag_id, _ in keys}
    task_ids = {task_id for _, task_id in keys}
    rows = session.execute(
        select(TI.dag_id, TI.task_id, func.avg(TI.duration))
        .where(
            TI.dag_id.in_(dag_ids),
            TI.task_id.in_(task_ids),
            TI.duration.isnot(None),
            TI.state == TaskInstanceState.SUCCESS,
        )
        .group_by(TI.dag_id, TI.task_id)
    ).all()
    return {(d, t): float(avg) for d, t, avg in rows if avg}


def list_processes(
    session: Session, *, include_finished: bool = False, allowed_dags: set[str] | None = None
) -> list[ProcessRow]:
    """Build the Task Manager process table from live task instances.

    Selects explicit columns rather than the ``TaskInstance`` entity: the ORM model
    grows columns between minor releases (and eagerly joins ``dag_run``), so entity
    loads break against any metadata DB that is a migration behind. The desktop only
    needs these eighteen fields.
    """
    now = datetime.now(tz=timezone.utc)

    columns = (
        TI.id,
        TI.dag_id,
        TI.run_id,
        TI.task_id,
        TI.map_index,
        TI.state,
        TI.start_date,
        TI.end_date,
        TI.try_number,
        TI.max_tries,
        TI.hostname,
        TI.pool,
        TI.pool_slots,
        TI.queue,
        TI.priority_weight,
        TI.operator,
        TI.pid,
        TI.executor,
        TI.task_display_name,
    )
    stmt = select(*columns, DagModel.owners).join(
        DagModel, DagModel.dag_id == TI.dag_id, isouter=True
    )
    if allowed_dags is not None:
        stmt = stmt.where(TI.dag_id.in_(allowed_dags))
    if include_finished:
        # "Show all processes" -> also surface what recently exited, like a process
        # list that keeps zombies around briefly.
        cutoff = now - timedelta(hours=6)
        stmt = stmt.where(or_(TI.state.in_(LIVE_STATES), TI.end_date >= cutoff))
    else:
        stmt = stmt.where(TI.state.in_(LIVE_STATES))
    stmt = stmt.order_by(TI.start_date.desc().nullslast(), TI.dag_id, TI.task_id).limit(500)

    records = session.execute(stmt).all()
    means = _mean_durations(session, {(r.dag_id, r.task_id) for r in records})

    rows: list[ProcessRow] = []
    for r in records:
        if r.start_date is not None:
            reference = r.end_date or now
            elapsed = max((reference - r.start_date).total_seconds(), 0.0)
        else:
            elapsed = 0.0

        mean = means.get((r.dag_id, r.task_id))
        if mean and r.state == TaskInstanceState.RUNNING:
            cpu = min(elapsed / mean * 100.0, 100.0)
        else:
            cpu = 0.0

        rows.append(
            ProcessRow(
                ti_id=str(r.id),
                pid=r.pid or synthetic_pid(r.dag_id, r.run_id, r.task_id, r.map_index),
                synthetic_pid=r.pid is None,
                image_name=_image_name(r.task_id, r.map_index),
                dag_id=r.dag_id,
                run_id=r.run_id,
                task_id=r.task_id,
                map_index=r.map_index,
                display_name=r.task_display_name or r.task_id,
                owner=(r.owners or "airflow").split(",")[0].strip() or "airflow",
                state=str(r.state) if r.state else "none",
                cpu=round(cpu, 1),
                elapsed=round(elapsed, 1),
                mem_k=(r.pool_slots or 1) * 1024,
                try_number=r.try_number or 0,
                max_tries=r.max_tries or 0,
                priority=_priority_class(r.priority_weight),
                priority_weight=r.priority_weight or 0,
                pool=r.pool or "default_pool",
                pool_slots=r.pool_slots or 1,
                operator=r.operator,
                hostname=r.hostname or None,
                queue=r.queue,
                executor=r.executor,
                start_date=r.start_date,
                end_date=r.end_date,
                is_deferred=r.state == TaskInstanceState.DEFERRED,
            )
        )
    return rows


def performance(session: Session) -> PerformanceInfo:
    """Task Manager 'Performance' tab: parallelism as CPU, pool slots as memory."""
    parallelism = conf.getint("core", "parallelism", fallback=32) or 32

    state_counts = dict(
        session.execute(
            select(TI.state, func.count()).where(TI.state.in_(LIVE_STATES)).group_by(TI.state)
        ).all()
    )
    running = int(state_counts.get(TaskInstanceState.RUNNING, 0))
    queued = int(state_counts.get(TaskInstanceState.QUEUED, 0)) + int(
        state_counts.get(TaskInstanceState.SCHEDULED, 0)
    )
    deferred = int(state_counts.get(TaskInstanceState.DEFERRED, 0))
    processes = sum(int(v) for v in state_counts.values())

    # Pools are Airflow's memory: a bounded resource tasks allocate from.
    total_slots = int(session.scalar(select(func.coalesce(func.sum(Pool.slots), 0))) or 0)
    used_slots = int(
        session.scalar(
            select(func.coalesce(func.sum(TI.pool_slots), 0)).where(
                TI.state.in_((TaskInstanceState.RUNNING, TaskInstanceState.QUEUED))
            )
        )
        or 0
    )

    running_dag_runs = int(
        session.scalar(select(func.count()).select_from(DagRun).where(DagRun.state == DagRunState.RUNNING))
        or 0
    )
    handles = int(session.scalar(select(func.count()).select_from(TI)) or 0)
    threads = int(
        session.scalar(
            select(func.count(func.distinct(TI.hostname))).where(
                TI.state == TaskInstanceState.RUNNING, TI.hostname.isnot(None)
            )
        )
        or 0
    )

    return PerformanceInfo(
        cpu_usage=round(min(running / parallelism * 100.0, 100.0), 1) if parallelism else 0.0,
        cpu_running=running,
        cpu_total=parallelism,
        mem_usage=round(used_slots / total_slots * 100.0, 1) if total_slots else 0.0,
        mem_used_slots=used_slots,
        mem_total_slots=total_slots,
        queued=queued,
        deferred=deferred,
        running_dag_runs=running_dag_runs,
        handles=handles,
        threads=max(threads, running),
        processes=processes,
    )


def _bundle_built() -> str | None:
    """When the staged desktop bundle was built, so a stale browser cache is visible."""
    from pathlib import Path

    bundle = Path(__file__).parent / "www" / "dist" / "main.umd.cjs"
    try:
        return datetime.fromtimestamp(bundle.stat().st_mtime, tz=timezone.utc).strftime(
            "%Y-%m-%d %H:%M:%S"
        )
    except OSError:
        return None


def system_info(session: Session) -> SystemInfo:
    """The 'System Properties' dialog.

    Deployment settings are withheld unless ``[api] expose_config`` allows it, so the
    desktop cannot be used to read configuration the core API would refuse to show.
    """
    from airflow.jobs.job import Job

    expose_config = conf.getboolean("api", "expose_config", fallback=False)
    hidden = "< hidden >"

    scheduler = session.scalars(
        select(Job).where(Job.job_type == "SchedulerJob").order_by(Job.latest_heartbeat.desc()).limit(1)
    ).first()

    heartbeat = getattr(scheduler, "latest_heartbeat", None)
    alive = bool(scheduler and scheduler.is_alive()) if scheduler is not None else False
    uptime = None
    if scheduler is not None and scheduler.start_date is not None:
        reference = heartbeat or datetime.now(tz=timezone.utc)
        uptime = max((reference - scheduler.start_date).total_seconds(), 0.0)

    dags_total = int(session.scalar(select(func.count()).select_from(DagModel)) or 0)
    dags_paused = int(
        session.scalar(select(func.count()).select_from(DagModel).where(DagModel.is_paused.is_(True))) or 0
    )
    dags_broken = int(
        session.scalar(
            select(func.count()).select_from(DagModel).where(DagModel.has_import_errors.is_(True))
        )
        or 0
    )
    bundles = [
        row
        for row in session.scalars(select(func.distinct(DagModel.bundle_name))).all()
        if row is not None
    ]

    return SystemInfo(
        airflow_version=AIRFLOW_VERSION,
        airflow_os_version=AIRFLOW_OS_VERSION,
        bundle_built=_bundle_built(),
        python_version=f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
        f" ({platform.machine()})",
        executor=conf.get("core", "executor", fallback="unknown") if expose_config else hidden,
        auth_manager=(
            conf.get("core", "auth_manager", fallback="unknown").rsplit(".", 1)[-1]
            if expose_config
            else hidden
        ),
        timezone=conf.get("core", "default_timezone", fallback="utc") if expose_config else hidden,
        dag_bundles=sorted(bundles) or ["dags-folder"],
        scheduler_alive=alive,
        scheduler_heartbeat=heartbeat,
        scheduler_hostname=getattr(scheduler, "hostname", None),
        uptime_seconds=uptime,
        dags_total=dags_total,
        dags_paused=dags_paused,
        dags_broken=dags_broken,
        parallelism=conf.getint("core", "parallelism", fallback=32),
        max_active_tasks_per_dag=conf.getint("core", "max_active_tasks_per_dag", fallback=16),
        performance=performance(session),
    )


# ---------------------------------------------------------------------------
# The filesystem
#
# Explorer browses a synthetic drive whose tree is the metadata database:
#
#   C:\<dag_id>\<run_id>\<task_id>\{stdout.log, xcom\, details.json}
#
# Paths travel over the wire with forward slashes (so they survive a query
# string) and are rendered with backslashes in the shell.
# ---------------------------------------------------------------------------

DRIVE = "C:"

# The DagModel columns Airflow OS reads. Same reasoning as the task-instance select:
# name the columns instead of loading the entity, so a metadata DB that is a
# migration behind the installed ORM still browses fine.
_DAG_COLUMNS = (
    DagModel.dag_id,
    DagModel.dag_display_name,
    DagModel.description,
    DagModel.owners,
    DagModel.is_paused,
    DagModel.is_stale,
    DagModel.has_import_errors,
    DagModel.bundle_name,
    DagModel.bundle_version,
    DagModel.fileloc,
    DagModel.relative_fileloc,
    DagModel.timetable_summary,
    DagModel.timetable_description,
    DagModel.max_active_runs,
    DagModel.max_active_tasks,
    DagModel.last_parsed_time,
    DagModel.next_dagrun,
)


def _get_dag(session: Session, dag_id: str):
    """Fetch one dag row as a lightweight column tuple."""
    return session.execute(select(*_DAG_COLUMNS).where(DagModel.dag_id == dag_id)).first()

_STATE_ICONS = {
    "success": "file-ok",
    "failed": "file-bad",
    "running": "file-run",
    "queued": "file-wait",
    "scheduled": "file-wait",
    "deferred": "file-wait",
    "upstream_failed": "file-bad",
    "skipped": "file-skip",
    "up_for_retry": "file-wait",
    "removed": "file-skip",
}


def _split(path: str) -> list[str]:
    """Normalise a wire path into segments below the drive letter."""
    cleaned = (path or DRIVE).replace("\\", "/").strip("/")
    parts = [p for p in cleaned.split("/") if p]
    if parts and parts[0].upper() == "C:":
        parts = parts[1:]
    return parts


def path_segments(path: str) -> list[str]:
    """Public view of the wire-path parser, so the API can authorize per file kind."""
    return _split(path)


def _join(*parts: str) -> str:
    return "/".join([DRIVE, *[p for p in parts if p]])


def _parent(path: str) -> str | None:
    parts = _split(path)
    if not parts:
        return None
    return _join(*parts[:-1])


def _state_icon(state: str | None, fallback: str = "file") -> str:
    return _STATE_ICONS.get(str(state or ""), fallback)


def _task_folder_name(task_id: str, map_index: int) -> str:
    return task_id if map_index < 0 else f"{task_id}.{map_index}"


def _parse_task_folder(name: str, session: Session, dag_id: str, run_id: str) -> tuple[str, int]:
    """Resolve a task folder name back to (task_id, map_index).

    Task ids may legitimately contain dots, so a trailing ``.<int>`` is only treated
    as a map index when the un-suffixed name actually exists as a mapped task.
    """
    if "." in name:
        stem, _, suffix = name.rpartition(".")
        if suffix.isdigit():
            exists = session.scalar(
                select(func.count())
                .select_from(TI)
                .where(TI.dag_id == dag_id, TI.run_id == run_id, TI.task_id == stem)
            )
            if exists:
                return stem, int(suffix)
    return name, -1


def list_drives(session: Session, allowed_dags: set[str] | None = None) -> list[FsEntry]:
    """'My Computer'. One drive per Dag bundle, plus the control-panel style shortcuts."""
    bundles = sorted(
        row for row in session.scalars(select(func.distinct(DagModel.bundle_name))).all() if row
    )
    count_stmt = select(func.count()).select_from(DagModel)
    if allowed_dags is not None:
        count_stmt = count_stmt.where(DagModel.dag_id.in_(allowed_dags))
    dag_count = int(session.scalar(count_stmt) or 0)
    entries = [
        FsEntry(
            name=f"Dags ({DRIVE})",
            path=DRIVE,
            kind="drive",
            icon="drive-hdd",
            detail=f"{dag_count} dag{'s' if dag_count != 1 else ''}"
            + (f" in {', '.join(bundles)}" if bundles else ""),
        )
    ]
    return entries


def list_dir(session: Session, path: str, allowed_dags: set[str] | None = None) -> FsListing:
    """List one directory of the synthetic drive."""
    parts = _split(path)
    depth = len(parts)

    if depth > 0 and allowed_dags is not None and parts[0] not in allowed_dags:
        # Report an unreadable dag as absent rather than forbidden, so the listing
        # does not confirm that a dag by that name exists.
        raise FileNotFoundError(parts[0])

    if depth == 0:
        return _list_dags(session, allowed_dags)
    if depth == 1:
        return _list_dag_runs(session, parts[0])
    if depth == 2:
        return _list_task_instances(session, parts[0], parts[1])
    if depth == 3:
        return _list_task_instance(session, parts[0], parts[1], parts[2])
    if depth == 4 and parts[3] == "xcom":
        return _list_xcoms(session, parts[0], parts[1], parts[2])
    return FsListing(path=_join(*parts), title=_join(*parts), parent=_parent(path), entries=[])


def _list_dags(session: Session, allowed_dags: set[str] | None = None) -> FsListing:
    stmt = select(
            DagModel.dag_id,
            DagModel.dag_display_name,
            DagModel.is_paused,
            DagModel.has_import_errors,
            DagModel.last_parsed_time,
            DagModel.timetable_summary,
        DagModel.owners,
    ).order_by(DagModel.dag_id)
    if allowed_dags is not None:
        stmt = stmt.where(DagModel.dag_id.in_(allowed_dags))
    rows = session.execute(stmt).all()
    entries = [
        FsEntry(
            name=dag_id,
            path=_join(dag_id),
            kind="folder",
            icon="folder-broken" if broken else ("folder-paused" if paused else "folder-dag"),
            modified=last_parsed,
            state="paused" if paused else ("broken" if broken else "active"),
            detail=" · ".join(
                bit for bit in [display or None, schedule or None, (owners or None)] if bit
            ),
        )
        for dag_id, display, paused, broken, last_parsed, schedule, owners in rows
    ]
    return FsListing(path=DRIVE, title=f"{DRIVE}\\", parent=None, entries=entries)


def _list_dag_runs(session: Session, dag_id: str) -> FsListing:
    dag = _get_dag(session, dag_id)
    entries: list[FsEntry] = []
    if dag is not None:
        entries.append(
            FsEntry(
                name="dag.py",
                path=_join(dag_id, "dag.py"),
                kind="file",
                icon="file-py",
                modified=dag.last_parsed_time,
                detail=dag.relative_fileloc or dag.fileloc,
            )
        )
        entries.append(
            FsEntry(
                name="properties.json",
                path=_join(dag_id, "properties.json"),
                kind="file",
                icon="file-json",
                modified=dag.last_parsed_time,
                detail="Dag properties",
            )
        )

    runs = session.execute(
        select(
            DagRun.run_id,
            DagRun.state,
            DagRun.run_type,
            DagRun.logical_date,
            DagRun.start_date,
            DagRun.end_date,
        )
        .where(DagRun.dag_id == dag_id)
        .order_by(DagRun.run_after.desc(), DagRun.id.desc())
        .limit(200)
    ).all()
    for run_id, state, run_type, logical_date, start, end in runs:
        entries.append(
            FsEntry(
                name=run_id,
                path=_join(dag_id, run_id),
                kind="folder",
                icon=_state_icon(state, "folder-run").replace("file-", "folder-"),
                modified=end or start or logical_date,
                state=str(state) if state else None,
                detail=str(run_type) if run_type else None,
            )
        )
    return FsListing(
        path=_join(dag_id), title=f"{DRIVE}\\{dag_id}", parent=DRIVE, entries=entries
    )


def _list_task_instances(session: Session, dag_id: str, run_id: str) -> FsListing:
    rows = session.execute(
        select(
            TI.task_id,
            TI.map_index,
            TI.state,
            TI.duration,
            TI.end_date,
            TI.start_date,
            TI.try_number,
            TI.operator,
        )
        .where(TI.dag_id == dag_id, TI.run_id == run_id)
        .order_by(TI.task_id, TI.map_index)
    ).all()
    entries = [
        FsEntry(
            name=_task_folder_name(task_id, map_index),
            path=_join(dag_id, run_id, _task_folder_name(task_id, map_index)),
            kind="folder",
            icon=_state_icon(state, "folder-task").replace("file-", "folder-"),
            modified=end or start,
            state=str(state) if state else None,
            task_id=task_id,
            map_index=map_index,
            try_number=try_number,
            detail=" · ".join(
                bit
                for bit in [
                    operator,
                    f"{duration:.1f}s" if duration else None,
                    f"try {try_number}" if try_number else None,
                ]
                if bit
            ),
        )
        for task_id, map_index, state, duration, end, start, try_number, operator in rows
    ]
    return FsListing(
        path=_join(dag_id, run_id),
        title=f"{DRIVE}\\{dag_id}\\{run_id}",
        parent=_join(dag_id),
        entries=entries,
    )


def _list_task_instance(session: Session, dag_id: str, run_id: str, folder: str) -> FsListing:
    task_id, map_index = _parse_task_folder(folder, session, dag_id, run_id)
    ti = session.execute(
        select(
            TI.state,
            TI.try_number,
            TI.max_tries,
            TI.start_date,
            TI.end_date,
            TI.updated_at,
        ).where(
            TI.dag_id == dag_id,
            TI.run_id == run_id,
            TI.task_id == task_id,
            TI.map_index == map_index,
        )
    ).first()
    base = _join(dag_id, run_id, folder)
    entries: list[FsEntry] = []
    if ti is not None:
        tries = max(ti.try_number or 1, 1)
        for attempt in range(tries, 0, -1):
            entries.append(
                FsEntry(
                    name="stdout.log" if attempt == tries else f"stdout.{attempt}.log",
                    path=f"{base}/stdout.{attempt}.log",
                    kind="file",
                    icon="file-log",
                    modified=ti.end_date or ti.start_date,
                    state=str(ti.state) if ti.state else None,
                    task_id=task_id,
                    map_index=map_index,
                    try_number=attempt,
                    detail=f"attempt {attempt} of {ti.max_tries + 1 if ti.max_tries else tries}",
                )
            )
        xcom_count = int(
            session.scalar(
                select(func.count())
                .select_from(XComModel)
                .where(
                    XComModel.dag_id == dag_id,
                    XComModel.run_id == run_id,
                    XComModel.task_id == task_id,
                    XComModel.map_index == map_index,
                )
            )
            or 0
        )
        entries.append(
            FsEntry(
                name="xcom",
                path=f"{base}/xcom",
                kind="folder",
                icon="folder-xcom",
                detail=f"{xcom_count} value{'s' if xcom_count != 1 else ''}",
            )
        )
        entries.append(
            FsEntry(
                name="details.json",
                path=f"{base}/details.json",
                kind="file",
                icon="file-json",
                modified=ti.updated_at,
                detail="Task instance properties",
            )
        )
    return FsListing(
        path=base,
        title=f"{DRIVE}\\{dag_id}\\{run_id}\\{folder}",
        parent=_join(dag_id, run_id),
        entries=entries,
    )


def _list_xcoms(session: Session, dag_id: str, run_id: str, folder: str) -> FsListing:
    task_id, map_index = _parse_task_folder(folder, session, dag_id, run_id)
    rows = session.execute(
        select(XComModel.key, XComModel.timestamp)
        .where(
            XComModel.dag_id == dag_id,
            XComModel.run_id == run_id,
            XComModel.task_id == task_id,
            XComModel.map_index == map_index,
        )
        .order_by(XComModel.key)
    ).all()
    base = _join(dag_id, run_id, folder, "xcom")
    entries = [
        FsEntry(
            name=f"{key}.json",
            path=f"{base}/{key}.json",
            kind="file",
            icon="file-json",
            modified=timestamp,
            detail="XCom value",
        )
        for key, timestamp in rows
    ]
    return FsListing(
        path=base,
        title=f"{DRIVE}\\{dag_id}\\{run_id}\\{folder}\\xcom",
        parent=_join(dag_id, run_id, folder),
        entries=entries,
    )


def read_file(session: Session, path: str, allowed_dags: set[str] | None = None) -> FsFile:
    """Open one synthetic file in Notepad.

    Task logs are deliberately *not* served here - the shell streams those from the
    core REST log endpoint so it inherits pagination and the log handler config.
    """
    parts = _split(path)
    if not parts:
        raise FileNotFoundError(path)
    if allowed_dags is not None and parts[0] not in allowed_dags:
        # Same rule as list_dir: an unreadable dag reads as absent, not forbidden. The
        # API checks this too; the kernel repeats it so no caller can skip it.
        raise FileNotFoundError(parts[0])
    name = parts[-1]

    if len(parts) == 2 and name == "dag.py":
        return _read_dag_source(session, parts[0], allowed_dags)
    if len(parts) == 2 and name == "properties.json":
        return _read_dag_properties(session, parts[0])
    if len(parts) == 4 and name == "details.json":
        return _read_ti_details(session, parts[0], parts[1], parts[2])
    if len(parts) == 5 and parts[3] == "xcom" and name.endswith(".json"):
        return _read_xcom(session, parts[0], parts[1], parts[2], name[: -len(".json")])
    raise FileNotFoundError(path)


def _as_json(value: Any) -> str:
    import json

    def default(obj: Any) -> str:
        if isinstance(obj, datetime):
            return obj.isoformat()
        return str(obj)

    return json.dumps(value, indent=2, sort_keys=True, default=default)


def _read_dag_source(
    session: Session, dag_id: str, allowed_dags: set[str] | None = None
) -> FsFile:
    """Open a dag's source.

    Reads the version-pinned copy from ``dag_code`` rather than opening
    ``DagModel.fileloc`` off the api-server's disk: the DB copy is what Airflow
    actually parsed, and going through the filesystem would bypass the per-file
    redaction below. One file may define several dags, so if the caller cannot read
    every dag defined in it, the whole file is withheld - the same rule the core
    ``/dagSources`` endpoint applies.
    """
    from airflow.models.dagcode import DagCode

    dag = _get_dag(session, dag_id)
    if dag is None:
        raise FileNotFoundError(dag_id)

    if allowed_dags is not None and dag.relative_fileloc:
        colocated = set(
            session.scalars(
                select(DagModel.dag_id).where(
                    DagModel.relative_fileloc == dag.relative_fileloc,
                    DagModel.bundle_name == dag.bundle_name,
                )
            ).all()
        )
        if colocated and not colocated.issubset(allowed_dags):
            content = (
                "# Source withheld.\n#\n"
                "# This file also defines dags you do not have permission to read:\n"
                + "".join(f"#   {other}\n" for other in sorted(colocated - allowed_dags))
            )
            return FsFile(
                path=_join(dag_id, "dag.py"), name="dag.py", content=content, language="python"
            )

    content = session.scalar(
        select(DagCode.source_code)
        .where(DagCode.dag_id == dag_id)
        .order_by(DagCode.last_updated.desc())
        .limit(1)
    )
    if content is None:
        content = f"# No parsed source is stored for {dag_id}.\n"

    truncated = len(content) > _MAX_LOG_BYTES
    return FsFile(
        path=_join(dag_id, "dag.py"),
        name="dag.py",
        content=content[:_MAX_LOG_BYTES],
        language="python",
        truncated=truncated,
    )


def _read_dag_properties(session: Session, dag_id: str) -> FsFile:
    dag = _get_dag(session, dag_id)
    if dag is None:
        raise FileNotFoundError(dag_id)
    payload = {
        "dag_id": dag.dag_id,
        "dag_display_name": dag.dag_display_name,
        "description": dag.description,
        "owners": dag.owners,
        "is_paused": dag.is_paused,
        "is_stale": dag.is_stale,
        "has_import_errors": dag.has_import_errors,
        "bundle_name": dag.bundle_name,
        "bundle_version": dag.bundle_version,
        "fileloc": dag.fileloc,
        "relative_fileloc": dag.relative_fileloc,
        "timetable_summary": dag.timetable_summary,
        "timetable_description": dag.timetable_description,
        "max_active_runs": dag.max_active_runs,
        "max_active_tasks": dag.max_active_tasks,
        "last_parsed_time": dag.last_parsed_time,
        "next_dagrun": dag.next_dagrun,
    }
    return FsFile(
        path=_join(dag_id, "properties.json"),
        name="properties.json",
        content=_as_json(payload),
        language="json",
    )


def _read_ti_details(session: Session, dag_id: str, run_id: str, folder: str) -> FsFile:
    task_id, map_index = _parse_task_folder(folder, session, dag_id, run_id)
    ti = session.execute(
        select(
            TI.state,
            TI.operator,
            TI.try_number,
            TI.max_tries,
            TI.start_date,
            TI.end_date,
            TI.duration,
            TI.hostname,
            TI.pid,
            TI.pool,
            TI.pool_slots,
            TI.queue,
            TI.priority_weight,
            TI.executor,
            TI.queued_dttm,
            TI.trigger_id,
        ).where(
            TI.dag_id == dag_id,
            TI.run_id == run_id,
            TI.task_id == task_id,
            TI.map_index == map_index,
        )
    ).first()
    if ti is None:
        raise FileNotFoundError(folder)
    payload = {
        "dag_id": dag_id,
        "run_id": run_id,
        "task_id": task_id,
        "map_index": map_index,
        "state": str(ti.state) if ti.state else None,
        "operator": ti.operator,
        "try_number": ti.try_number,
        "max_tries": ti.max_tries,
        "start_date": ti.start_date,
        "end_date": ti.end_date,
        "duration": ti.duration,
        "hostname": ti.hostname,
        "pid": ti.pid,
        "pool": ti.pool,
        "pool_slots": ti.pool_slots,
        "queue": ti.queue,
        "priority_weight": ti.priority_weight,
        "priority_class": _priority_class(ti.priority_weight),
        "executor": ti.executor,
        "queued_dttm": ti.queued_dttm,
        "trigger_id": ti.trigger_id,
    }
    return FsFile(
        path=_join(dag_id, run_id, folder, "details.json"),
        name="details.json",
        content=_as_json(payload),
        language="json",
    )


def _read_xcom(session: Session, dag_id: str, run_id: str, folder: str, key: str) -> FsFile:
    task_id, map_index = _parse_task_folder(folder, session, dag_id, run_id)
    raw = session.scalar(
        select(XComModel.value).where(
            XComModel.dag_id == dag_id,
            XComModel.run_id == run_id,
            XComModel.task_id == task_id,
            XComModel.map_index == map_index,
            XComModel.key == key,
        )
    )
    if raw is None:
        raise FileNotFoundError(key)
    try:
        # deserialize_value only reads ``.value``; wrapping avoids an entity load,
        # which would break on any metadata DB a migration behind the ORM.
        value = XComModel.deserialize_value(SimpleNamespace(value=raw))
    except Exception as exc:  # noqa: BLE001 - a corrupt XCom should still open
        value = f"<could not deserialize: {exc}>"
    return FsFile(
        path=_join(dag_id, run_id, folder, "xcom", f"{key}.json"),
        name=f"{key}.json",
        content=_as_json(value),
        language="json",
    )


def control_panel(session: Session) -> dict[str, Any]:
    """Contents of the Control Panel applets: Variables, Connections, Pools."""
    variables = [
        {"key": key, "description": description, "is_encrypted": bool(encrypted)}
        for key, description, encrypted in session.execute(
            select(Variable.key, Variable.description, Variable.is_encrypted).order_by(Variable.key)
        ).all()
    ]
    connections = [
        {
            "conn_id": conn_id,
            "conn_type": conn_type,
            "host": host,
            "schema": schema,
            "login": login,
            "port": port,
            "description": description,
        }
        for conn_id, conn_type, host, schema, login, port, description in session.execute(
            select(
                Connection.conn_id,
                Connection.conn_type,
                Connection.host,
                Connection.schema,
                Connection.login,
                Connection.port,
                Connection.description,
            ).order_by(Connection.conn_id)
        ).all()
    ]

    occupied = dict(
        session.execute(
            select(TI.pool, func.coalesce(func.sum(TI.pool_slots), 0))
            .where(TI.state.in_((TaskInstanceState.RUNNING, TaskInstanceState.QUEUED)))
            .group_by(TI.pool)
        ).all()
    )
    pools = [
        {
            "name": name,
            "slots": slots,
            "description": description,
            "include_deferred": bool(include_deferred),
            "occupied_slots": int(occupied.get(name, 0) or 0),
        }
        for name, slots, description, include_deferred in session.execute(
            select(Pool.pool, Pool.slots, Pool.description, Pool.include_deferred).order_by(Pool.pool)
        ).all()
    ]
    return {"variables": variables, "connections": connections, "pools": pools}


# ---------------------------------------------------------------------------
# Failure evidence, for the Clippy assistant
#
# Airflow 3 task code has no metadata DB access - tasks run under the Task SDK
# and reach the scheduler over the Task Execution API. So the evidence a triage
# needs is collected here, in the api-server, and handed to the dag in
# ``dag_run.conf``. The dag is then purely the agentic part: one ``@task.llm``
# call over a payload it was given.
# ---------------------------------------------------------------------------

LOG_TAIL_LINES = 120


def _read_log_tail(
    session: Session, dag_id: str, run_id: str, task_id: str, map_index: int, try_number: int
) -> str:
    """Best-effort tail of one task log.

    Goes through the configured task log handler rather than guessing file paths, so
    it works with remote logging too. A log that cannot be read is not fatal: the
    model can still reason from the metadata, and is told the log was unavailable.
    """
    try:
        from airflow.models.taskinstance import TaskInstance as TI_MODEL
        from airflow.utils.log.log_reader import TaskLogReader

        ti = session.scalars(
            select(TI_MODEL).where(
                TI_MODEL.dag_id == dag_id,
                TI_MODEL.run_id == run_id,
                TI_MODEL.task_id == task_id,
                TI_MODEL.map_index == map_index,
            )
        ).first()
        if ti is None:
            return "(task instance not found)"

        reader = TaskLogReader()
        if not reader.supports_read:
            return "(the configured log handler does not support reading)"

        # read_log_chunks returns (stream, metadata); the stream yields
        # StructuredLogMessage objects rather than plain strings.
        stream, _ = reader.read_log_chunks(ti, max(try_number, 1), metadata={})
        lines: list[str] = []
        for message in stream:
            if isinstance(message, str):
                lines.append(message)
                continue
            event = getattr(message, "event", None)
            if event is None:
                lines.append(str(message))
                continue
            timestamp = getattr(message, "timestamp", None)
            lines.append(f"{timestamp} {event}" if timestamp else str(event))

            # Airflow 3 logs a traceback as structured data rather than text: the
            # event only says "Task failed with exception", and the exception class
            # and message live in an ``error_detail`` extra. Without this the tail
            # never contains the one line a reader actually wants.
            extra = getattr(message, "model_extra", None) or {}
            for detail in extra.get("error_detail") or []:
                if not isinstance(detail, dict):
                    continue
                exc_type = detail.get("exc_type")
                if not exc_type:
                    continue
                exc_value = detail.get("exc_value")
                lines.append(f"{exc_type}: {exc_value}" if exc_value else str(exc_type))

        text = "\n".join(lines).strip()
        if not text:
            return "(the log is empty)"
        return "\n".join(text.splitlines()[-LOG_TAIL_LINES:])
    except Exception as exc:  # noqa: BLE001 - a missing log must not break triage
        return f"(could not read the log: {exc})"


def failure_evidence(
    session: Session,
    *,
    dag_id: str,
    run_id: str,
    task_id: str,
    map_index: int = -1,
    try_number: int = 0,
) -> dict[str, Any]:
    """Everything a human would look at first when triaging one failed task."""
    row = session.execute(
        select(
            TI.state,
            TI.operator,
            TI.try_number,
            TI.max_tries,
            TI.duration,
            TI.hostname,
            TI.pool,
            TI.queue,
        ).where(
            TI.dag_id == dag_id,
            TI.run_id == run_id,
            TI.task_id == task_id,
            TI.map_index == map_index,
        )
    ).first()
    if row is None:
        raise FileNotFoundError(f"{dag_id}.{task_id} in {run_id}")

    attempt = try_number or row.try_number or 1

    # Sibling states let the model tell "this task broke" apart from
    # "this task was a casualty of something upstream".
    siblings = [
        {"task_id": tid, "state": str(state) if state else None}
        for tid, state in session.execute(
            select(TI.task_id, TI.state).where(TI.dag_id == dag_id, TI.run_id == run_id)
        ).all()
    ]

    return {
        "dag_id": dag_id,
        "run_id": run_id,
        "task_id": task_id,
        "map_index": map_index,
        "try_number": attempt,
        "state": str(row.state) if row.state else None,
        "operator": row.operator,
        "tries": f"{row.try_number} of {(row.max_tries or 0) + 1}",
        "duration_seconds": row.duration,
        "hostname": row.hostname,
        "pool": row.pool,
        "queue": row.queue,
        "log_tail": _read_log_tail(session, dag_id, run_id, task_id, map_index, attempt),
        "run_task_states": siblings,
    }


# ---------------------------------------------------------------------------
# Human-in-the-loop
#
# The core API only exposes HITL details per dag run, so there is no way to ask
# "what is waiting on a human anywhere in this deployment?" - which is exactly
# what an inbox needs. This does that query once, filtered to the dags the
# caller may read. Responding still goes through the public REST API, so the
# resume path and its audit entry are Airflow's, not ours.
# ---------------------------------------------------------------------------


def list_hitl_requests(
    session: Session,
    *,
    allowed_dags: set[str] | None = None,
    include_answered: bool = False,
) -> list[Any]:
    """Every human-in-the-loop request waiting on an answer, newest first."""
    try:
        from airflow.models.hitl import HITLDetail
    except ImportError:
        # HITL landed in Airflow 3.1; on anything older the inbox is simply empty.
        return []

    from airflow_os.schemas import HitlRequest

    stmt = (
        select(
            HITLDetail.ti_id,
            HITLDetail.subject,
            HITLDetail.body,
            HITLDetail.options,
            HITLDetail.defaults,
            HITLDetail.multiple,
            HITLDetail.params,
            HITLDetail.assignees,
            HITLDetail.created_at,
            HITLDetail.responded_at,
            HITLDetail.responded_by,
            HITLDetail.chosen_options,
            TI.dag_id,
            TI.run_id,
            TI.task_id,
            TI.map_index,
            TI.state,
        )
        .join(TI, TI.id == HITLDetail.ti_id)
        .order_by(HITLDetail.created_at.desc())
        .limit(200)
    )
    if not include_answered:
        stmt = stmt.where(HITLDetail.responded_at.is_(None))
    if allowed_dags is not None:
        stmt = stmt.where(TI.dag_id.in_(allowed_dags))

    requests: list[Any] = []
    for row in session.execute(stmt).all():
        responder = row.responded_by
        requests.append(
            HitlRequest(
                ti_id=str(row.ti_id),
                dag_id=row.dag_id,
                run_id=row.run_id,
                task_id=row.task_id,
                map_index=row.map_index,
                task_state=str(row.state) if row.state else None,
                subject=row.subject,
                body=row.body,
                options=list(row.options or []),
                defaults=list(row.defaults) if row.defaults else None,
                multiple=bool(row.multiple),
                params=dict(row.params or {}),
                assignees=list(row.assignees or []),
                created_at=row.created_at,
                responded_at=row.responded_at,
                responded_by=(responder or {}).get("name") if isinstance(responder, dict) else None,
                chosen_options=list(row.chosen_options) if row.chosen_options else None,
            )
        )
    return requests


# ---------------------------------------------------------------------------
# Recycle Bin
#
# Airflow already behaves like one and nobody notices: deleting a dag file does
# not drop the record, it sets ``DagModel.is_stale``. The history stays, the runs
# stay, and putting the file back brings it all straight home. Task instances get
# the same treatment - a task removed from a dag leaves its old runs in state
# ``removed`` rather than deleting them.
# ---------------------------------------------------------------------------


def list_recycled(session: Session, *, allowed_dags: set[str] | None = None) -> list[Any]:
    """Everything Airflow has deleted but kept, newest first."""
    from airflow_os.schemas import RecycledItem

    items: list[Any] = []

    stale_stmt = select(
        DagModel.dag_id,
        DagModel.last_parsed_time,
        DagModel.relative_fileloc,
        DagModel.bundle_name,
        DagModel.is_paused,
    ).where(DagModel.is_stale.is_(True))
    if allowed_dags is not None:
        stale_stmt = stale_stmt.where(DagModel.dag_id.in_(allowed_dags))

    for row in session.execute(stale_stmt).all():
        items.append(
            RecycledItem(
                key=f"dag:{row.dag_id}",
                kind="dag",
                name=row.dag_id,
                dag_id=row.dag_id,
                deleted_at=row.last_parsed_time,
                detail=" · ".join(
                    bit
                    for bit in [
                        row.relative_fileloc or "no recorded file",
                        row.bundle_name,
                        "paused" if row.is_paused else None,
                    ]
                    if bit
                ),
                # A stale dag comes back when its file does; nothing the desktop can do.
                restorable=False,
            )
        )

    removed_stmt = (
        select(TI.dag_id, TI.run_id, TI.task_id, TI.map_index, TI.updated_at, TI.operator)
        .where(TI.state == TaskInstanceState.REMOVED)
        .order_by(TI.updated_at.desc())
        .limit(200)
    )
    if allowed_dags is not None:
        removed_stmt = removed_stmt.where(TI.dag_id.in_(allowed_dags))

    for row in session.execute(removed_stmt).all():
        items.append(
            RecycledItem(
                key=f"task:{row.dag_id}/{row.run_id}/{row.task_id}/{row.map_index}",
                kind="task",
                name=_image_name(row.task_id, row.map_index),
                dag_id=row.dag_id,
                run_id=row.run_id,
                task_id=row.task_id,
                map_index=row.map_index,
                deleted_at=row.updated_at,
                detail=" · ".join(bit for bit in [row.operator, row.run_id] if bit),
                restorable=False,
            )
        )

    items.sort(key=lambda item: item.deleted_at or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return items


# ---------------------------------------------------------------------------
# Deadlines
#
# Airflow 3 deadlines have no public REST API at all, so the mailbox reads the
# ``deadline`` and ``deadline_alert`` tables directly. A missed deadline is
# unread mail: something was due, nobody delivered, and the callback fired.
# ---------------------------------------------------------------------------


def _render_json_blob(blob: Any, *keys: str) -> str | None:
    """Summarise one of the deadline JSON columns for a human.

    These columns hold Airflow's serialization envelope - ``__classname__`` plus a
    ``__data__`` payload - so the raw value reads like
    ``__classname__=datetime.timedelta, __version__=2, __data__=30.0``. Unwrap the
    common shapes rather than showing the machinery.
    """
    if not isinstance(blob, dict):
        return str(blob) if blob else None

    classname = blob.get("__classname__")
    data = blob.get("__data__")

    if classname == "datetime.timedelta" and isinstance(data, (int, float)):
        return _humanise_seconds(float(data))

    if isinstance(data, dict):
        # Callbacks carry the dotted path of the function that fires.
        path = data.get("path")
        if isinstance(path, str) and path:
            # Dag modules get an "unusual_prefix_<hash>_" prefix when imported; the
            # function name is the part anyone cares about.
            return path.rsplit(".", 1)[-1]

    if isinstance(classname, str) and classname:
        return classname.rsplit(".", 1)[-1]

    for key in keys:
        value = blob.get(key)
        if isinstance(value, str) and value:
            return value.rsplit(".", 1)[-1]

    return ", ".join(f"{k}={v}" for k, v in list(blob.items())[:3]) or None


def _humanise_seconds(seconds: float) -> str:
    """30.0 -> '30 seconds'; 5400 -> '1h 30m'."""
    total = int(seconds)
    if total < 60:
        return f"{total} second{'' if total == 1 else 's'}"
    minutes, secs = divmod(total, 60)
    if minutes < 60:
        return f"{minutes}m" + (f" {secs}s" if secs else "")
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h" + (f" {minutes}m" if minutes else "")


def list_deadlines(
    session: Session,
    *,
    allowed_dags: set[str] | None = None,
    missed_only: bool = False,
) -> list[Any]:
    """Every deadline the scheduler is tracking, soonest first."""
    try:
        from airflow.models.deadline import Deadline
        from airflow.models.deadline_alert import DeadlineAlert
    except ImportError:
        # Deadlines are new in Airflow 3; on anything older the mailbox is empty.
        return []

    from airflow_os.schemas import DeadlineItem

    stmt = (
        select(
            Deadline.id,
            Deadline.deadline_time,
            Deadline.missed,
            Deadline.created_at,
            Deadline.deadline_alert_id,
            DeadlineAlert.name,
            DeadlineAlert.description,
            DeadlineAlert.reference,
            DeadlineAlert.interval,
            DeadlineAlert.callback_def,
            DagRun.dag_id,
            DagRun.run_id,
            DagRun.state,
        )
        .join(DeadlineAlert, DeadlineAlert.id == Deadline.deadline_alert_id, isouter=True)
        .join(DagRun, DagRun.id == Deadline.dagrun_id, isouter=True)
        .order_by(Deadline.deadline_time.asc())
        .limit(300)
    )
    if missed_only:
        stmt = stmt.where(Deadline.missed.is_(True))
    if allowed_dags is not None:
        # A deadline with no dag run is deployment-level; keep those visible.
        stmt = stmt.where(or_(DagRun.dag_id.is_(None), DagRun.dag_id.in_(allowed_dags)))

    return [
        DeadlineItem(
            id=str(row.id),
            dag_id=row.dag_id,
            run_id=row.run_id,
            name=row.name,
            description=row.description,
            deadline_time=row.deadline_time,
            missed=bool(row.missed),
            created_at=row.created_at,
            reference=_render_json_blob(row.reference, "reference_type", "type", "name"),
            interval=_render_json_blob(row.interval, "interval", "seconds", "type"),
            callback=_render_json_blob(row.callback_def, "path", "callback", "type"),
            dag_run_state=str(row.state) if row.state else None,
        )
        for row in session.execute(stmt).all()
    ]
