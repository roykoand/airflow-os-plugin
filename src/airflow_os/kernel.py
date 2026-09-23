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
from typing import Any

from airflow.configuration import conf

# The only ORM left. Deadlines have no REST API, so the mailbox reads their tables, and
# needs ``dag_run`` alongside to say which run each deadline was measured against.
from airflow.models.dagrun import DagRun
from airflow.utils.state import TaskInstanceState
from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from airflow_os import __version__ as AIRFLOW_OS_VERSION
from airflow_os.rest import ANY, Rest
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

#: Ceiling on one process-table query. The desktop mirrors this as ``PROCESS_LIMIT``
#: so it can say "500+" rather than reporting a truncated count as the total; move
#: the two together.
PROCESS_LIMIT = 500


def _dt(value: Any) -> datetime | None:
    """A timestamp from a JSON payload.

    The REST API renders datetimes as RFC 3339 with a ``Z``, which
    ``datetime.fromisoformat`` only learned to parse in Python 3.11; the project still
    supports 3.10, so the suffix is normalised first. Anything unparseable becomes
    ``None`` rather than raising: a missing date greys out one column, a traceback
    takes down the window.
    """
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


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


def _count(client: Rest, path: str, **params: Any) -> int:
    """How many rows match, without fetching them.

    Every list response carries ``total_entries``, so a page of one answers a counting
    question for the price of the smallest possible response. This is what replaced the
    ``SELECT count(*)`` behind the Performance tab.
    """
    return int(client.get(path, limit=1, **params).get("total_entries") or 0)


def _live_states() -> list[str]:
    return [state.value for state in LIVE_STATES]


def _dag_index(client: Rest) -> dict[str, dict]:
    """Every dag, by id, including the stale ones.

    The task instance schema carries no owner, so the process table's Owner column is
    filled from here. Listing dags is cheap next to listing their task instances, and
    one lookup table serves the whole page.
    """
    return {
        row["dag_id"]: row
        for row in client.rows("/dags", "dags", exclude_stale=False, max_rows=2000)
    }


def _mean_durations(client: Rest, keys: set[tuple[str, str]]) -> dict[tuple[str, str], float]:
    """Mean duration per (dag_id, task_id), used to estimate progress.

    This is what powers the CPU column: a task 30 seconds into a job that normally takes
    60 reads as 50%. Tasks with no history report 0 rather than a guess.

    Where this used to be one ``AVG ... GROUP BY`` across all of history, it is now the
    mean of the most recent successful runs the API will return in one page. That is a
    deliberate trade and arguably the better statistic: a task whose runtime changed last
    week is described by what it does now, not by what it did in March.
    """
    if not keys:
        return {}
    dag_ids = {dag_id for dag_id, _ in keys}
    totals: dict[tuple[str, str], list[float]] = {}
    for dag_id in dag_ids:
        rows = client.rows(
            f"/dags/{dag_id}/dagRuns/{ANY}/taskInstances",
            "task_instances",
            state="success",
            order_by="-start_date",
            max_rows=200,
        )
        for row in rows:
            key = (row.get("dag_id"), row.get("task_id"))
            duration = row.get("duration")
            if key in keys and duration:
                totals.setdefault(key, []).append(float(duration))
    return {key: sum(values) / len(values) for key, values in totals.items() if values}


def list_processes(client: Rest, *, include_finished: bool = False) -> list[ProcessRow]:
    """Build the Task Manager process table from live task instances.

    ``~`` stands in for both the dag and the dag run, which is what lets one request ask
    the deployment-wide question -- every in-flight task instance, whoever owns it.

    "Show all processes" needs live *or* recently exited, and the API ands its filters
    rather than oring them, so that is two requests merged on task instance id.
    """
    now = datetime.now(tz=timezone.utc)
    path = f"/dags/{ANY}/dagRuns/{ANY}/taskInstances"

    records: dict[str, dict] = {}
    for row in client.rows(
        path, "task_instances", state=_live_states(), order_by="-start_date", max_rows=PROCESS_LIMIT
    ):
        records[row["id"]] = row

    if include_finished:
        # A process list that keeps its zombies around briefly.
        cutoff = (now - timedelta(hours=6)).isoformat()
        for row in client.rows(
            path,
            "task_instances",
            end_date_gte=cutoff,
            order_by="-start_date",
            max_rows=PROCESS_LIMIT,
        ):
            records.setdefault(row["id"], row)

    found = list(records.values())[:PROCESS_LIMIT]
    dags = _dag_index(client)
    means = _mean_durations(client, {(r["dag_id"], r["task_id"]) for r in found})

    rows: list[ProcessRow] = []
    for r in found:
        dag_id, task_id = r["dag_id"], r["task_id"]
        map_index = r.get("map_index", -1)
        run_id = r.get("dag_run_id") or ""
        state = r.get("state")
        start_date, end_date = _dt(r.get("start_date")), _dt(r.get("end_date"))

        if start_date is not None:
            elapsed = max(((end_date or now) - start_date).total_seconds(), 0.0)
        else:
            elapsed = 0.0

        mean = means.get((dag_id, task_id))
        cpu = min(elapsed / mean * 100.0, 100.0) if mean and state == "running" else 0.0

        pid = r.get("pid")
        owners = (dags.get(dag_id, {}).get("owners") or []) or ["airflow"]
        pool_slots = r.get("pool_slots") or 1

        rows.append(
            ProcessRow(
                ti_id=str(r["id"]),
                pid=pid or synthetic_pid(dag_id, run_id, task_id, map_index),
                synthetic_pid=pid is None,
                image_name=_image_name(task_id, map_index),
                dag_id=dag_id,
                run_id=run_id,
                task_id=task_id,
                map_index=map_index,
                display_name=r.get("task_display_name") or task_id,
                owner=str(owners[0]).strip() or "airflow",
                state=str(state) if state else "none",
                cpu=round(cpu, 1),
                elapsed=round(elapsed, 1),
                mem_k=pool_slots * 1024,
                try_number=r.get("try_number") or 0,
                max_tries=r.get("max_tries") or 0,
                priority=_priority_class(r.get("priority_weight")),
                priority_weight=r.get("priority_weight") or 0,
                pool=r.get("pool") or "default_pool",
                pool_slots=pool_slots,
                operator=r.get("operator"),
                hostname=r.get("hostname") or None,
                queue=r.get("queue"),
                executor=r.get("executor"),
                start_date=start_date,
                end_date=end_date,
                is_deferred=state == "deferred",
            )
        )
    return rows


def authorized_dag_ids(client: Rest) -> set[str]:
    """The dag ids this caller may read.

    ``/api/v2/dags`` returns what the caller is allowed to see and nothing else, so the
    listing *is* the allow-list. This used to be ``get_authorized_dag_ids(user)`` against
    the metadata database; asking the API instead means the answer comes from the same
    place every other read is already checked against, and cannot disagree with it.
    """
    return set(_dag_index(client))


def find_process(client: Rest, ti_id: str) -> dict | None:
    """Resolve a Task Manager row back to its task instance.

    Task instances are addressed over REST by dag, run, task and map index, but the
    desktop holds a row's identity as ``TaskInstance.id`` -- deliberately, because
    synthetic PIDs collide and must never be resolvable. So the id is matched against the
    same set the process table was built from: live first, then what recently exited.
    A process the desktop could not have listed is one it cannot end.
    """
    path = f"/dags/{ANY}/dagRuns/{ANY}/taskInstances"
    windows = (
        {"state": _live_states()},
        {"end_date_gte": (datetime.now(tz=timezone.utc) - timedelta(hours=6)).isoformat()},
    )
    for params in windows:
        for row in client.rows(path, "task_instances", max_rows=PROCESS_LIMIT, **params):
            if str(row.get("id")) == ti_id:
                return row
    return None


def end_process(client: Rest, row: dict) -> str | None:
    """Fail one task instance, and only that one.

    ``include_downstream`` is off, so nothing cascades: Windows 95 did not ask permission
    either. Airflow's own patch endpoint does the state change, which means the dag run
    bookkeeping and the audit entry are its, not ours.
    """
    previous = row.get("state")
    client.patch(
        _ti_path(row["dag_id"], row["dag_run_id"], row["task_id"], row.get("map_index", -1)),
        {
            "new_state": "failed",
            "include_downstream": False,
            "include_upstream": False,
            "include_future": False,
            "include_past": False,
        },
        update_mask="new_state",
    )
    return str(previous) if previous else None


def purge_dag(client: Rest, dag_id: str) -> None:
    """'Empty Recycle Bin' for one dag: drop the record and everything hanging off it.

    Refuses anything still live. A dag whose file is present is not in the bin, and
    deleting its history because the desktop asked would be indefensible.
    """
    dag = _get_dag(client, dag_id)
    if not dag:
        raise FileNotFoundError(dag_id)
    if not dag.get("is_stale"):
        raise PermissionError(f"{dag_id} is not in the Recycle Bin - its file is still present.")
    client.delete(f"/dags/{dag_id}")


def performance(client: Rest) -> PerformanceInfo:
    """Task Manager 'Performance' tab: parallelism as CPU, pool slots as memory.

    Counted rather than fetched. Each number is the ``total_entries`` of a filtered
    listing asked for one row, so the tab costs a handful of tiny responses instead of
    the whole task instance table.
    """
    parallelism = conf.getint("core", "parallelism", fallback=32) or 32
    tis = f"/dags/{ANY}/dagRuns/{ANY}/taskInstances"

    running = _count(client, tis, state="running")
    queued = _count(client, tis, state=["queued", "scheduled"])
    deferred = _count(client, tis, state="deferred")
    processes = _count(client, tis, state=_live_states())
    handles = _count(client, tis)
    running_dag_runs = _count(client, f"/dags/{ANY}/dagRuns", state="running")

    # Pools are Airflow's memory: a bounded resource tasks allocate from. The pool
    # listing already reports its own occupancy, which used to be a GROUP BY here.
    pools = client.rows("/pools", "pools")
    total_slots = sum(int(pool.get("slots") or 0) for pool in pools)
    used_slots = sum(int(pool.get("occupied_slots") or 0) for pool in pools)

    # Distinct hosts running work. This one genuinely needs the rows, but only the
    # running ones, which is the smallest of the live sets.
    hosts = {
        row.get("hostname")
        for row in client.rows(tis, "task_instances", state="running", max_rows=PROCESS_LIMIT)
        if row.get("hostname")
    }

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
        threads=max(len(hosts), running),
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


def system_info(client: Rest) -> SystemInfo:
    """The 'System Properties' dialog.

    Deployment settings are withheld unless ``[api] expose_config`` allows it, so the
    desktop cannot be used to read configuration the core API would refuse to show.
    """
    expose_config = conf.getboolean("api", "expose_config", fallback=False)
    hidden = "< hidden >"

    # A live scheduler if there is one, otherwise the most recent corpse, so the dialog
    # can say "not responding" with a last-seen time rather than showing nothing.
    jobs = client.get(
        "/jobs", job_type="SchedulerJob", is_alive=True, order_by="-latest_heartbeat", limit=1
    ).get("jobs") or []
    alive = bool(jobs)
    if not jobs:
        jobs = client.get(
            "/jobs", job_type="SchedulerJob", order_by="-latest_heartbeat", limit=1
        ).get("jobs") or []
    scheduler = jobs[0] if jobs else {}

    heartbeat = _dt(scheduler.get("latest_heartbeat"))
    started = _dt(scheduler.get("start_date"))
    uptime = None
    if started is not None:
        uptime = max(((heartbeat or datetime.now(tz=timezone.utc)) - started).total_seconds(), 0.0)

    # Stale dags are still dags as far as the census is concerned; they are what the
    # Recycle Bin is full of.
    dags = _dag_index(client)
    bundles = {row.get("bundle_name") for row in dags.values() if row.get("bundle_name")}

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
        scheduler_hostname=scheduler.get("hostname"),
        uptime_seconds=uptime,
        dags_total=len(dags),
        dags_paused=sum(1 for row in dags.values() if row.get("is_paused")),
        dags_broken=sum(1 for row in dags.values() if row.get("has_import_errors")),
        parallelism=conf.getint("core", "parallelism", fallback=32),
        max_active_tasks_per_dag=conf.getint("core", "max_active_tasks_per_dag", fallback=16),
        performance=performance(client),
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


def _get_dag(client: Rest, dag_id: str) -> dict:
    """One dag's record, or ``{}`` when there is no such dag (or none this caller sees)."""
    return client.get(f"/dags/{dag_id}")


def _ti_path(dag_id: str, run_id: str, task_id: str, map_index: int = -1) -> str:
    """The core API's address for one task instance, mapped or not.

    A mapped instance is addressed by appending its index as a path segment; the
    unmapped form has no segment at all, and passing ``-1`` explicitly returns the
    unmapped row only on some releases. So the suffix is added only when it is real.
    """
    base = f"/dags/{dag_id}/dagRuns/{run_id}/taskInstances/{task_id}"
    return base if map_index < 0 else f"{base}/{map_index}"


def _split(path: str) -> list[str]:
    """Normalise a wire path into segments below the drive letter."""
    cleaned = (path or DRIVE).replace("\\", "/").strip("/")
    parts = [p for p in cleaned.split("/") if p]
    if parts and parts[0].upper() == DRIVE:
        parts = parts[1:]
    return parts


def path_segments(path: str) -> list[str]:
    """Public form of :func:`_split`, for the API layer's permission checks."""
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


def _parse_task_folder(name: str, client: Rest, dag_id: str, run_id: str) -> tuple[str, int]:
    """Resolve a task folder name back to (task_id, map_index).

    Task ids may legitimately contain dots, so a trailing ``.<int>`` is only treated as a
    map index when the un-suffixed name actually exists as a task in this run.
    """
    if "." in name:
        stem, _, suffix = name.rpartition(".")
        if suffix.isdigit():
            exists = _count(
                client, f"/dags/{dag_id}/dagRuns/{run_id}/taskInstances", task_id=stem
            )
            if exists:
                return stem, int(suffix)
    return name, -1


def list_drives(client: Rest) -> list[FsEntry]:
    """'My Computer'. The dag bundle, as a hard drive."""
    dags = _dag_index(client)
    bundles = sorted({row.get("bundle_name") for row in dags.values() if row.get("bundle_name")})
    dag_count = len(dags)
    return [
        FsEntry(
            name=f"Dags ({DRIVE})",
            path=DRIVE,
            kind="drive",
            icon="drive-hdd",
            detail=f"{dag_count} dag{'s' if dag_count != 1 else ''}"
            + (f" in {', '.join(bundles)}" if bundles else ""),
        )
    ]


def list_dir(client: Rest, path: str) -> FsListing:
    """List one directory of the synthetic drive."""
    parts = _split(path)
    depth = len(parts)

    if depth == 0:
        return _list_dags(client)
    if depth == 1:
        return _list_dag_runs(client, parts[0])
    if depth == 2:
        return _list_task_instances(client, parts[0], parts[1])
    if depth == 3:
        return _list_task_instance(client, parts[0], parts[1], parts[2])
    if depth == 4 and parts[3] == "xcom":
        return _list_xcoms(client, parts[0], parts[1], parts[2])
    return FsListing(path=_join(*parts), title=_join(*parts), parent=_parent(path), entries=[])


def _owners(row: dict) -> str | None:
    """``owners`` arrives as a list over the API and as a comma-joined string in the DB."""
    owners = row.get("owners")
    if isinstance(owners, list):
        return ", ".join(str(o) for o in owners) or None
    return str(owners) if owners else None


def _list_dags(client: Rest) -> FsListing:
    entries = [
        FsEntry(
            name=row["dag_id"],
            path=_join(row["dag_id"]),
            kind="folder",
            icon=(
                "folder-broken"
                if row.get("has_import_errors")
                else ("folder-paused" if row.get("is_paused") else "folder-dag")
            ),
            modified=_dt(row.get("last_parsed_time")),
            state=(
                "paused"
                if row.get("is_paused")
                else ("broken" if row.get("has_import_errors") else "active")
            ),
            detail=" · ".join(
                bit
                for bit in [
                    row.get("dag_display_name") or None,
                    row.get("timetable_summary") or None,
                    _owners(row),
                ]
                if bit
            ),
        )
        for row in sorted(_dag_index(client).values(), key=lambda r: r["dag_id"])
    ]
    return FsListing(path=DRIVE, title=f"{DRIVE}\\", parent=None, entries=entries)


def _list_dag_runs(client: Rest, dag_id: str) -> FsListing:
    dag = _get_dag(client, dag_id)
    entries: list[FsEntry] = []
    if dag:
        parsed = _dt(dag.get("last_parsed_time"))
        entries.append(
            FsEntry(
                name="dag.py",
                path=_join(dag_id, "dag.py"),
                kind="file",
                icon="file-py",
                modified=parsed,
                detail=dag.get("relative_fileloc") or dag.get("fileloc"),
            )
        )
        entries.append(
            FsEntry(
                name="properties.json",
                path=_join(dag_id, "properties.json"),
                kind="file",
                icon="file-json",
                modified=parsed,
                detail="Dag properties",
            )
        )

    for row in client.rows(
        f"/dags/{dag_id}/dagRuns", "dag_runs", order_by="-run_after", max_rows=200
    ):
        run_id = row["dag_run_id"]
        state = row.get("state")
        entries.append(
            FsEntry(
                name=run_id,
                path=_join(dag_id, run_id),
                kind="folder",
                icon=_state_icon(state, "folder-run").replace("file-", "folder-"),
                modified=_dt(row.get("end_date") or row.get("start_date") or row.get("logical_date")),
                state=str(state) if state else None,
                detail=str(row.get("run_type")) if row.get("run_type") else None,
            )
        )
    return FsListing(path=_join(dag_id), title=f"{DRIVE}\\{dag_id}", parent=DRIVE, entries=entries)


def _list_task_instances(client: Rest, dag_id: str, run_id: str) -> FsListing:
    # No ``order_by``: the task instance endpoint does not accept task_id as a sort key,
    # and the folder order is settled below anyway, mapped indexes included.
    rows = client.rows(
        f"/dags/{dag_id}/dagRuns/{run_id}/taskInstances", "task_instances", max_rows=1000
    )
    entries = []
    for row in sorted(rows, key=lambda r: (r["task_id"], r.get("map_index", -1))):
        task_id = row["task_id"]
        map_index = row.get("map_index", -1)
        folder = _task_folder_name(task_id, map_index)
        state = row.get("state")
        duration = row.get("duration")
        try_number = row.get("try_number") or 0
        entries.append(
            FsEntry(
                name=folder,
                path=_join(dag_id, run_id, folder),
                kind="folder",
                icon=_state_icon(state, "folder-task").replace("file-", "folder-"),
                modified=_dt(row.get("end_date") or row.get("start_date")),
                state=str(state) if state else None,
                task_id=task_id,
                map_index=map_index,
                try_number=try_number,
                detail=" · ".join(
                    bit
                    for bit in [
                        row.get("operator"),
                        f"{duration:.1f}s" if duration else None,
                        f"try {try_number}" if try_number else None,
                    ]
                    if bit
                ),
            )
        )
    return FsListing(
        path=_join(dag_id, run_id),
        title=f"{DRIVE}\\{dag_id}\\{run_id}",
        parent=_join(dag_id),
        entries=entries,
    )


def _list_task_instance(client: Rest, dag_id: str, run_id: str, folder: str) -> FsListing:
    task_id, map_index = _parse_task_folder(folder, client, dag_id, run_id)
    ti = client.get(_ti_path(dag_id, run_id, task_id, map_index))
    base = _join(dag_id, run_id, folder)
    entries: list[FsEntry] = []
    if ti:
        modified = _dt(ti.get("end_date") or ti.get("start_date"))
        state = ti.get("state")
        max_tries = ti.get("max_tries") or 0
        tries = max(ti.get("try_number") or 1, 1)
        for attempt in range(tries, 0, -1):
            entries.append(
                FsEntry(
                    name="stdout.log" if attempt == tries else f"stdout.{attempt}.log",
                    path=f"{base}/stdout.{attempt}.log",
                    kind="file",
                    icon="file-log",
                    modified=modified,
                    state=str(state) if state else None,
                    task_id=task_id,
                    map_index=map_index,
                    try_number=attempt,
                    detail=f"attempt {attempt} of {max_tries + 1 if max_tries else tries}",
                )
            )
        xcom_count = _count(
            client,
            f"/dags/{dag_id}/dagRuns/{run_id}/taskInstances/{task_id}/xcomEntries",
            map_index=map_index,
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
                modified=modified,
                detail="Task instance properties",
            )
        )
    return FsListing(
        path=base,
        title=f"{DRIVE}\\{dag_id}\\{run_id}\\{folder}",
        parent=_join(dag_id, run_id),
        entries=entries,
    )


def _list_xcoms(client: Rest, dag_id: str, run_id: str, folder: str) -> FsListing:
    task_id, map_index = _parse_task_folder(folder, client, dag_id, run_id)
    rows = client.rows(
        f"/dags/{dag_id}/dagRuns/{run_id}/taskInstances/{task_id}/xcomEntries",
        "xcom_entries",
        map_index=map_index,
        max_rows=200,
    )
    base = _join(dag_id, run_id, folder, "xcom")
    entries = [
        FsEntry(
            name=f"{row['key']}.json",
            path=f"{base}/{row['key']}.json",
            kind="file",
            icon="file-json",
            modified=_dt(row.get("timestamp")),
            detail="XCom value",
        )
        for row in sorted(rows, key=lambda r: r["key"])
    ]
    return FsListing(
        path=base,
        title=f"{DRIVE}\\{dag_id}\\{run_id}\\{folder}\\xcom",
        parent=_join(dag_id, run_id, folder),
        entries=entries,
    )


def read_file(client: Rest, path: str) -> FsFile:
    """Open one synthetic file in Notepad.

    Task logs are deliberately *not* served here - the shell streams those from the core
    REST log endpoint so it inherits pagination and the log handler config.
    """
    parts = _split(path)
    if not parts:
        raise FileNotFoundError(path)
    name = parts[-1]

    if len(parts) == 2 and name == "dag.py":
        return _read_dag_source(client, parts[0])
    if len(parts) == 2 and name == "properties.json":
        return _read_dag_properties(client, parts[0])
    if len(parts) == 4 and name == "details.json":
        return _read_ti_details(client, parts[0], parts[1], parts[2])
    if len(parts) == 5 and parts[3] == "xcom" and name.endswith(".json"):
        return _read_xcom(client, parts[0], parts[1], parts[2], name[: -len(".json")])
    raise FileNotFoundError(path)


def _as_json(value: Any) -> str:
    import json

    def default(obj: Any) -> str:
        if isinstance(obj, datetime):
            return obj.isoformat()
        return str(obj)

    return json.dumps(value, indent=2, sort_keys=True, default=default)


def _read_dag_source(client: Rest, dag_id: str) -> FsFile:
    """Open a dag's source, as Airflow parsed it.

    ``/dagSources`` serves the version-pinned copy from ``dag_code``, not whatever is on
    the api-server's disk now. It also owns the awkward rule about shared files: one
    ``.py`` may define several dags, and a caller who cannot read all of them may not
    read the file. That check used to be reimplemented here; now the endpoint that
    invented it decides, and a refusal is rendered as a withheld-source note.
    """
    path = _join(dag_id, "dag.py")
    try:
        source = client.get(f"/dagSources/{dag_id}")
    except HTTPException as exc:
        if exc.status_code not in (401, 403):
            raise
        content = (
            "# Source withheld.\n#\n"
            "# This file also defines dags you do not have permission to read.\n"
        )
        return FsFile(path=path, name="dag.py", content=content, language="python")

    content = (source or {}).get("content")
    if content is None:
        if not _get_dag(client, dag_id):
            raise FileNotFoundError(dag_id)
        content = f"# No parsed source is stored for {dag_id}.\n"

    return FsFile(
        path=path,
        name="dag.py",
        content=content[:_MAX_LOG_BYTES],
        language="python",
        truncated=len(content) > _MAX_LOG_BYTES,
    )


def _read_dag_properties(client: Rest, dag_id: str) -> FsFile:
    dag = _get_dag(client, dag_id)
    if not dag:
        raise FileNotFoundError(dag_id)
    keep = (
        "dag_id",
        "dag_display_name",
        "description",
        "owners",
        "is_paused",
        "is_stale",
        "has_import_errors",
        "bundle_name",
        "bundle_version",
        "fileloc",
        "relative_fileloc",
        "timetable_summary",
        "timetable_description",
        "max_active_runs",
        "max_active_tasks",
        "last_parsed_time",
    )
    payload = {key: dag.get(key) for key in keep}
    payload["next_dagrun"] = dag.get("next_dagrun_logical_date")
    return FsFile(
        path=_join(dag_id, "properties.json"),
        name="properties.json",
        content=_as_json(payload),
        language="json",
    )


def _read_ti_details(client: Rest, dag_id: str, run_id: str, folder: str) -> FsFile:
    task_id, map_index = _parse_task_folder(folder, client, dag_id, run_id)
    ti = client.get(_ti_path(dag_id, run_id, task_id, map_index))
    if not ti:
        raise FileNotFoundError(folder)
    trigger = ti.get("trigger") or {}
    payload = {
        "dag_id": dag_id,
        "run_id": run_id,
        "task_id": task_id,
        "map_index": map_index,
        "state": ti.get("state"),
        "operator": ti.get("operator"),
        "try_number": ti.get("try_number"),
        "max_tries": ti.get("max_tries"),
        "start_date": ti.get("start_date"),
        "end_date": ti.get("end_date"),
        "duration": ti.get("duration"),
        "hostname": ti.get("hostname"),
        "pid": ti.get("pid"),
        "pool": ti.get("pool"),
        "pool_slots": ti.get("pool_slots"),
        "queue": ti.get("queue"),
        "priority_weight": ti.get("priority_weight"),
        "priority_class": _priority_class(ti.get("priority_weight")),
        "executor": ti.get("executor"),
        "queued_dttm": ti.get("queued_when"),
        "trigger_id": trigger.get("id") if isinstance(trigger, dict) else None,
    }
    return FsFile(
        path=_join(dag_id, run_id, folder, "details.json"),
        name="details.json",
        content=_as_json(payload),
        language="json",
    )


def _read_xcom(client: Rest, dag_id: str, run_id: str, folder: str, key: str) -> FsFile:
    """Open one XCom value.

    The core endpoint deserialises the value itself, which is the part that used to need
    care here: loading the ORM entity to get at ``deserialize_value`` breaks against a
    metadata database a migration behind.
    """
    task_id, map_index = _parse_task_folder(folder, client, dag_id, run_id)
    entry = client.get(
        f"/dags/{dag_id}/dagRuns/{run_id}/taskInstances/{task_id}/xcomEntries/{key}",
        map_index=map_index,
    )
    if not entry:
        raise FileNotFoundError(key)
    return FsFile(
        path=_join(dag_id, run_id, folder, "xcom", f"{key}.json"),
        name=f"{key}.json",
        content=_as_json(entry.get("value")),
        language="json",
    )


def _applet(fetch: Any) -> list[dict]:
    """One Control Panel applet, or an empty one.

    A deployment whose Fernet key has been rotated cannot decrypt its own Connections,
    and the core API answers 500 rather than omitting the field. That is worth one empty
    applet, not a dead Control Panel, so a server-side failure degrades just this list.
    A refusal (401/403) still propagates: "you may not see this" is an answer the
    desktop must show rather than dress up as "there is nothing here".
    """
    try:
        return fetch()
    except HTTPException as exc:
        if exc.status_code < 500:
            raise
        return []


def control_panel(client: Rest) -> dict[str, Any]:
    """Contents of the Control Panel applets: Variables, Connections, Pools.

    Values are deliberately dropped on the way through. ``/api/v2/variables`` and
    ``/api/v2/connections`` will hand a sufficiently privileged caller the decrypted
    value, the password and the ``extra`` blob; the desktop lists names and shapes, so
    the secrets are discarded here rather than sent to a browser that has no use for
    them. Pool occupancy arrives already counted, which used to be a GROUP BY.
    """
    variables = _applet(
        lambda: [
            {
                "key": row.get("key"),
                "description": row.get("description"),
                "is_encrypted": bool(row.get("is_encrypted")),
            }
            for row in client.rows("/variables", "variables", order_by="key")
        ]
    )
    connections = _applet(
        lambda: [
            {
                "conn_id": row.get("connection_id"),
                "conn_type": row.get("conn_type"),
                "host": row.get("host"),
                "schema": row.get("schema"),
                "login": row.get("login"),
                "port": row.get("port"),
                "description": row.get("description"),
            }
            for row in client.rows("/connections", "connections", order_by="connection_id")
        ]
    )
    pools = _applet(
        lambda: [
            {
                "name": row.get("name"),
                "slots": row.get("slots"),
                "description": row.get("description"),
                "include_deferred": bool(row.get("include_deferred")),
                "occupied_slots": int(row.get("occupied_slots") or 0),
            }
            for row in client.rows("/pools", "pools", order_by="name")
        ]
    )
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
    client: Rest, dag_id: str, run_id: str, task_id: str, map_index: int, try_number: int
) -> str:
    """Best-effort tail of one task log.

    The core log endpoint applies whatever handler the deployment configured, so remote
    logging works here without the plugin knowing anything about it. A log that cannot be
    read is not fatal: the model can still reason from the metadata, and is told the log
    was unavailable rather than being handed silence.
    """
    try:
        payload = client.get(
            f"/dags/{dag_id}/dagRuns/{run_id}/taskInstances/{task_id}/logs/{max(try_number, 1)}",
            map_index=map_index,
        )
        if not payload:
            return "(task instance not found)"

        lines: list[str] = []
        for message in payload.get("content") or []:
            if isinstance(message, str):
                lines.append(message)
                continue
            if not isinstance(message, dict):
                lines.append(str(message))
                continue
            event = message.get("event")
            timestamp = message.get("timestamp")
            lines.append(f"{timestamp} {event}" if timestamp and event else str(event or message))

            # Airflow 3 logs a traceback as structured data rather than text: the event
            # only says "Task failed with exception", and the exception class and message
            # live in an ``error_detail`` extra. Without this the tail never contains the
            # one line a reader actually wants.
            for detail in message.get("error_detail") or []:
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
    client: Rest,
    *,
    dag_id: str,
    run_id: str,
    task_id: str,
    map_index: int = -1,
    try_number: int = 0,
) -> dict[str, Any]:
    """Everything a human would look at first when triaging one failed task."""
    ti = client.get(_ti_path(dag_id, run_id, task_id, map_index))
    if not ti:
        raise FileNotFoundError(f"{dag_id}.{task_id} in {run_id}")

    attempt = try_number or ti.get("try_number") or 1

    # Sibling states let the model tell "this task broke" apart from "this task was a
    # casualty of something upstream".
    siblings = [
        {"task_id": row.get("task_id"), "state": row.get("state")}
        for row in client.rows(
            f"/dags/{dag_id}/dagRuns/{run_id}/taskInstances", "task_instances", max_rows=1000
        )
    ]

    return {
        "dag_id": dag_id,
        "run_id": run_id,
        "task_id": task_id,
        "map_index": map_index,
        "try_number": attempt,
        "state": ti.get("state"),
        "operator": ti.get("operator"),
        "tries": f"{ti.get('try_number')} of {(ti.get('max_tries') or 0) + 1}",
        "duration_seconds": ti.get("duration"),
        "hostname": ti.get("hostname"),
        "pool": ti.get("pool"),
        "queue": ti.get("queue"),
        "log_tail": _read_log_tail(client, dag_id, run_id, task_id, map_index, attempt),
        "run_task_states": siblings,
    }


# ---------------------------------------------------------------------------
# Human-in-the-loop
#
# The core API lists HITL details a dag run at a time, which is the wrong shape
# for an inbox: what needs me, anywhere? The same route takes ``~`` for both the
# dag and the run, so one request answers it. Responding still goes through the
# public REST API from the browser, so the resume path and its audit entry are
# Airflow's, not ours.
# ---------------------------------------------------------------------------


def list_hitl_requests(client: Rest, *, include_answered: bool = False) -> list[Any]:
    """Every human-in-the-loop request waiting on an answer, newest first.

    The core API lists these per dag run, which cannot answer "what needs me?" -- but
    the same route takes ``~`` for both the dag and the run, and that does.
    """
    from airflow_os.schemas import HitlRequest

    rows = client.rows(
        f"/dags/{ANY}/dagRuns/{ANY}/hitlDetails",
        "hitl_details",
        order_by="-created_at",
        response_received=None if include_answered else False,
        max_rows=200,
    )

    requests: list[Any] = []
    for row in rows:
        ti = row.get("task_instance") or {}
        responder = row.get("responded_by_user") or {}
        requests.append(
            HitlRequest(
                ti_id=str(ti.get("id") or ""),
                dag_id=ti.get("dag_id") or "",
                run_id=ti.get("dag_run_id") or "",
                task_id=ti.get("task_id") or "",
                map_index=ti.get("map_index", -1),
                task_state=ti.get("state"),
                subject=row.get("subject") or "",
                body=row.get("body"),
                options=list(row.get("options") or []),
                defaults=list(row["defaults"]) if row.get("defaults") else None,
                multiple=bool(row.get("multiple")),
                params=dict(row.get("params") or {}),
                assignees=list(row.get("assigned_users") or []),
                created_at=_dt(row.get("created_at")),
                responded_at=_dt(row.get("responded_at")),
                responded_by=responder.get("name") if isinstance(responder, dict) else None,
                chosen_options=list(row["chosen_options"]) if row.get("chosen_options") else None,
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


def list_recycled(client: Rest) -> list[Any]:
    """Everything Airflow has deleted but kept, newest first.

    Two kinds of thing end up here, and neither is really gone. A dag whose file
    disappeared is marked ``is_stale`` and keeps all its history, which the dag listing
    will only show when asked with ``exclude_stale=false``. A task removed from a dag
    leaves its old instances in state ``removed``.
    """
    from airflow_os.schemas import RecycledItem

    items: list[Any] = []

    for row in client.rows("/dags", "dags", exclude_stale=False):
        if not row.get("is_stale"):
            continue
        dag_id = row["dag_id"]
        items.append(
            RecycledItem(
                key=f"dag:{dag_id}",
                kind="dag",
                name=dag_id,
                dag_id=dag_id,
                deleted_at=_dt(row.get("last_parsed_time")),
                detail=" · ".join(
                    bit
                    for bit in [
                        row.get("relative_fileloc") or "no recorded file",
                        row.get("bundle_name"),
                        "paused" if row.get("is_paused") else None,
                    ]
                    if bit
                ),
                # A stale dag comes back when its file does; nothing the desktop can do.
                restorable=False,
            )
        )

    removed = client.rows(
        f"/dags/{ANY}/dagRuns/{ANY}/taskInstances",
        "task_instances",
        state="removed",
        order_by="-start_date",
        max_rows=200,
    )
    for row in removed:
        map_index = row.get("map_index", -1)
        task_id = row["task_id"]
        run_id = row["dag_run_id"]
        items.append(
            RecycledItem(
                key=f"task:{row['dag_id']}/{run_id}/{task_id}/{map_index}",
                kind="task",
                name=_image_name(task_id, map_index),
                dag_id=row["dag_id"],
                run_id=run_id,
                task_id=task_id,
                map_index=map_index,
                # The task instance schema carries no ``updated_at``, so the last time
                # the instance actually did anything stands in for when it was removed.
                deleted_at=_dt(row.get("end_date") or row.get("start_date")),
                detail=" · ".join(bit for bit in [row.get("operator"), run_id] if bit),
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
