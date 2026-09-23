"""The Airflow OS kernel API.

Mounted into the Airflow api-server via the plugin's ``fastapi_apps``. What lives here
is shape, not data: the desktop needs deployment-wide roll-ups and a filesystem-shaped
view of dag runs, and this assembles them out of calls to Airflow's own REST API, made
with the caller's own credential. Airflow therefore applies its permission checks to
everything the desktop reads, rather than the plugin reimplementing them against the
ORM and hoping the two agree.

Two things still touch the metadata database, because nothing else can serve them:

* **Deadlines.** Airflow 3 publishes no deadline endpoints at all, which is why the
  Deadlines mailbox is the only place in any Airflow UI where a deadline is visible.
* **End Process** and **Empty Recycle Bin**, two writes with no REST equivalent --
  failing one task instance without touching its downstream, and dropping a stale
  ``DagModel`` row.

Everything the browser can do for itself -- triggering dags, clearing tasks, streaming
logs, answering a HITL request -- it still calls on ``/api/v2`` directly.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Annotated, Any

from airflow.api_fastapi.auth.managers.models.resource_details import DagAccessEntity
from airflow.api_fastapi.core_api.security import (
    requires_access_configuration,
    requires_access_connection,
    requires_access_dag,
    requires_access_pool,
    requires_access_variable,
)
from airflow.utils.session import create_session
from airflow.utils.state import TaskInstanceState
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from airflow_os import kernel
from airflow_os.rest import Rest, credential_from
from airflow_os.schemas import (
    DeadlineItem,
    FsEntry,
    FsFile,
    FsListing,
    HitlRequest,
    KillResult,
    PerformanceInfo,
    ProcessRow,
    RecycledItem,
    SystemInfo,
)


def _get_session():
    """A metadata DB session. One route uses it.

    Deadlines have no REST endpoints at all, so the mailbox reads ``deadline`` and
    ``deadline_alert`` directly. Everything else on this app -- every read, and both
    writes -- goes through :data:`RestDep`.
    """
    with create_session(scoped=False) as session:
        yield session


SessionDep = Annotated[Session, Depends(_get_session)]


def _get_rest(request: Request):
    """A REST client carrying this caller's own credential.

    Reads that ``/api/v2`` can serve are made as the user who asked, so Airflow applies
    its own permission checks to them and the plugin does not have to reproduce the
    result. Nothing here can see more than the browser could.
    """
    with Rest(credential_from(request.headers, request.cookies)) as client:
        yield client


RestDep = Annotated[Rest, Depends(_get_rest)]


def _authorized_dags(client: RestDep) -> set[str]:
    """The dag ids this caller may read.

    ``requires_access_dag`` with no ``dag_id`` in the path only answers "may you read
    dags at all"; it cannot narrow a deployment-wide listing. Deadlines are still read
    from the metadata database and so still need narrowing, and the dag listing already
    is that answer -- it returns what this caller may see and nothing more.
    """
    return kernel.authorized_dag_ids(client)


AuthorizedDagsDep = Annotated[set[str], Depends(_authorized_dags)]


# Reading the process table, the synthetic filesystem and the performance graphs all
# amount to reading task instances, so they share one permission gate.
_reads_task_instances = Depends(
    requires_access_dag(method="GET", access_entity=DagAccessEntity.TASK_INSTANCE)
)
_reads_dags = Depends(requires_access_dag(method="GET"))

app = FastAPI(
    title="Airflow OS",
    description=(
        "Kernel API for the Airflow OS desktop shell. Exposes the Windows 95 views of "
        "Airflow state: the process table (task instances), performance counters "
        "(parallelism and pool slots), and a synthetic filesystem over the metadata database."
    ),
    version="0.1.0",
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe, also used by the desktop to decide whether to boot or BSOD."""
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Task Manager
# ---------------------------------------------------------------------------


@app.get("/processes", response_model=list[ProcessRow], dependencies=[_reads_task_instances])
def list_processes(
    client: RestDep,
    include_finished: Annotated[
        bool, Query(description="Also include task instances that exited in the last 6 hours.")
    ] = False,
) -> list[ProcessRow]:
    """The process table: one row per in-flight task instance."""
    return kernel.list_processes(client, include_finished=include_finished)


@app.get("/performance", response_model=PerformanceInfo, dependencies=[_reads_task_instances])
def performance(client: RestDep) -> PerformanceInfo:
    """Task Manager performance counters, sampled from live scheduler state."""
    return kernel.performance(client)


@app.post(
    "/processes/{ti_id}/end",
    response_model=KillResult,
    dependencies=[Depends(requires_access_dag(method="PUT", access_entity=DagAccessEntity.TASK_INSTANCE))],
)
def end_process(ti_id: str, client: RestDep) -> KillResult:
    """'End Process': fail the task instance behind a Task Manager row.

    Addressed by ``TaskInstance.id``, never by the PID on screen. The PID for a task
    with no worker is a CRC32 of its key into 64512 slots, so collisions are likely
    once a few hundred processes are listed - resolving a process from its PID could
    fail somebody else's task.

    Deliberately does not cascade to downstream tasks; Windows 95 did not ask
    permission either. If the worker is still alive it may report its own result
    afterwards, which is the authentic "this program is not responding" experience.
    """
    row = kernel.find_process(client, ti_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No such process")

    previous = kernel.end_process(client, row)
    map_index = row.get("map_index", -1)
    return KillResult(
        pid=row.get("pid")
        or kernel.synthetic_pid(row["dag_id"], row["dag_run_id"], row["task_id"], map_index),
        task_id=row["task_id"],
        dag_id=row["dag_id"],
        run_id=row["dag_run_id"],
        previous_state=previous,
        new_state=TaskInstanceState.FAILED.value,
    )


# ---------------------------------------------------------------------------
# System Properties
# ---------------------------------------------------------------------------


@app.get(
    "/system",
    response_model=SystemInfo,
    dependencies=[_reads_dags, Depends(requires_access_configuration(method="GET"))],
)
def system(client: RestDep) -> SystemInfo:
    """The System Properties dialog: versions, scheduler health, dag census."""
    return kernel.system_info(client)


# ---------------------------------------------------------------------------
# Explorer
# ---------------------------------------------------------------------------


@app.get("/fs/drives", response_model=list[FsEntry], dependencies=[_reads_dags])
def fs_drives(client: RestDep) -> list[FsEntry]:
    """'My Computer': the drives available on this machine."""
    return kernel.list_drives(client)


@app.get("/fs/list", response_model=FsListing, dependencies=[_reads_task_instances])
def fs_list(
    client: RestDep,
    path: Annotated[
        str, Query(description=r"Wire path with forward slashes, e.g. 'C:/my_dag/manual__2026-01-01'.")
    ] = kernel.DRIVE,
) -> FsListing:
    """List one directory of the synthetic drive."""
    try:
        return kernel.list_dir(client, path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Path not found: {exc}") from exc


@app.get("/fs/read", response_model=FsFile, dependencies=[_reads_task_instances])
def fs_read(
    client: RestDep,
    path: Annotated[str, Query(description="Wire path of the file to open in Notepad.")],
) -> FsFile:
    """Open a synthetic file: dag source, dag properties, task details, or an XCom value.

    One route serves several kinds of document and they are not governed by the same
    permission -- dag source needs ``CODE``, XCom values need ``XCOM``. Each is fetched
    from the core endpoint that owns it, as the caller, so those checks are applied by
    the code that defines them instead of being restated here.
    """
    try:
        return kernel.read_file(client, path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"File not found: {exc}") from exc


# ---------------------------------------------------------------------------
# Recycle Bin
# ---------------------------------------------------------------------------


@app.get("/recycle-bin", response_model=list[RecycledItem], dependencies=[_reads_task_instances])
def recycle_bin(client: RestDep) -> list[RecycledItem]:
    """Things Airflow deleted but kept: stale dags, and task instances marked removed."""
    return kernel.list_recycled(client)


@app.delete(
    "/recycle-bin/dags/{dag_id}",
    dependencies=[Depends(requires_access_dag(method="DELETE"))],
)
def purge_dag(dag_id: str, client: RestDep) -> dict[str, str]:
    """'Empty Recycle Bin' for one dag: drop the record and everything hanging off it."""
    try:
        kernel.purge_dag(client, dag_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Dag not found") from None
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return {"dag_id": dag_id, "status": "purged"}


# ---------------------------------------------------------------------------
# Deadlines
# ---------------------------------------------------------------------------


@app.get("/deadlines", response_model=list[DeadlineItem], dependencies=[_reads_dags])
def deadlines(
    session: SessionDep,
    allowed_dags: AuthorizedDagsDep,
    missed_only: Annotated[bool, Query(description="Only deadlines that were missed.")] = False,
) -> list[DeadlineItem]:
    """Every deadline the scheduler is tracking.

    Airflow 3 deadlines have no public REST API, so this reads the ``deadline`` and
    ``deadline_alert`` tables directly - which makes the desktop the only place a
    deadline is visible at all.
    """
    return kernel.list_deadlines(session, allowed_dags=allowed_dags, missed_only=missed_only)


# ---------------------------------------------------------------------------
# Human-in-the-loop
# ---------------------------------------------------------------------------


@app.get(
    "/hitl",
    response_model=list[HitlRequest],
    dependencies=[
        Depends(requires_access_dag(method="GET", access_entity=DagAccessEntity.HITL_DETAIL))
    ],
)
def hitl_requests(
    client: RestDep,
    include_answered: Annotated[
        bool, Query(description="Also return requests that already have an answer.")
    ] = False,
) -> list[HitlRequest]:
    """Everything waiting on a human, across the whole deployment.

    The core API only lists HITL details one dag run at a time, which cannot answer
    "what needs me?" - so the inbox asks here. Answering still goes through the public
    REST API so the task resume path and its audit entry stay Airflow's.
    """
    return kernel.list_hitl_requests(client, include_answered=include_answered)


# ---------------------------------------------------------------------------
# Clippy
# ---------------------------------------------------------------------------


@app.get(
    "/evidence",
    dependencies=[
        _reads_task_instances,
        Depends(requires_access_dag(method="GET", access_entity=DagAccessEntity.TASK_LOGS)),
    ],
)
def evidence(
    client: RestDep,
    dag_id: str,
    run_id: str,
    task_id: str,
    map_index: int = -1,
    try_number: int = 0,
) -> dict[str, Any]:
    """Evidence for one failed task instance, for the Clippy assistant to triage.

    Airflow 3 task code cannot read the metadata DB, so the desktop collects this here
    and passes it to the triage dag in ``dag_run.conf``. Returns log content, hence the
    TASK_LOGS check on top of the usual task-instance one.
    """
    try:
        return kernel.failure_evidence(
            client,
            dag_id=dag_id,
            run_id=run_id,
            task_id=task_id,
            map_index=map_index,
            try_number=try_number,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Task instance not found: {exc}") from exc


# ---------------------------------------------------------------------------
# Control Panel
# ---------------------------------------------------------------------------


@app.get(
    "/control-panel",
    dependencies=[
        Depends(requires_access_variable(method="GET")),
        Depends(requires_access_connection(method="GET")),
        Depends(requires_access_pool(method="GET")),
    ],
)
def control_panel(client: RestDep) -> dict[str, Any]:
    """Control Panel applets: Variables, Connections (secrets withheld) and Pools."""
    return kernel.control_panel(client)


# ---------------------------------------------------------------------------
# Static assets for the React bundle
# ---------------------------------------------------------------------------

# FastAPI serves .cjs as text/plain by default, which makes the dynamic import fail.
mimetypes.add_type("application/javascript", ".cjs")

_DIST = Path(__file__).parent / "www" / "dist"
if _DIST.is_dir():
    app.mount(
        "/static",
        StaticFiles(directory=str(_DIST.absolute()), html=True),
        name="airflow_os_static",
    )
