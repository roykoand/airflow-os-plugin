"""The Airflow OS kernel API.

Mounted into the Airflow api-server via the plugin's ``fastapi_apps``, so it runs
in-process and can read the metadata DB directly instead of round-tripping through
HTTP. Only aggregate, desktop-shaped views live here; anything the public REST API
already models well (triggering dags, clearing tasks, reading logs, audit events)
is called straight from the browser against ``/api/v2`` so Airflow OS inherits its
validation and permissions rather than reimplementing them.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Annotated, Any

from airflow.api_fastapi.app import get_auth_manager
from airflow.api_fastapi.auth.managers.models.resource_details import DagAccessEntity, DagDetails
from airflow.api_fastapi.core_api.security import (
    GetUserDep,
    requires_access_configuration,
    requires_access_connection,
    requires_access_dag,
    requires_access_pool,
    requires_access_variable,
)
from airflow.utils.session import create_session
from airflow.utils.state import TaskInstanceState
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from airflow_os import kernel
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
    with create_session(scoped=False) as session:
        yield session


SessionDep = Annotated[Session, Depends(_get_session)]


def _authorized_dags(user: GetUserDep, session: SessionDep) -> set[str]:
    """The dag ids this caller may read.

    ``requires_access_dag`` with no ``dag_id`` in the path only answers "may you read
    dags at all"; it cannot narrow a deployment-wide listing. The core API pairs it
    with ``Permitted*Filter`` dependencies, and this is the plugin's equivalent: every
    row-level view is filtered to this set, so an auth manager with per-dag roles
    (FAB, Keycloak) does not leak dags the caller cannot see.
    """
    return get_auth_manager().get_authorized_dag_ids(user=user, method="GET", session=session)


AuthorizedDagsDep = Annotated[set[str], Depends(_authorized_dags)]


def _require_dag_entity(user, dag_id: str, entity: DagAccessEntity) -> None:
    """Check one specific dag entity, for routes that serve several kinds of file."""
    if not get_auth_manager().is_authorized_dag(
        method="GET", access_entity=entity, details=DagDetails(id=dag_id), user=user
    ):
        raise HTTPException(status_code=403, detail="Forbidden")

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
    session: SessionDep,
    allowed_dags: AuthorizedDagsDep,
    include_finished: Annotated[
        bool, Query(description="Also include task instances that exited in the last 6 hours.")
    ] = False,
) -> list[ProcessRow]:
    """The process table: one row per in-flight task instance."""
    return kernel.list_processes(session, include_finished=include_finished, allowed_dags=allowed_dags)


@app.get("/performance", response_model=PerformanceInfo, dependencies=[_reads_task_instances])
def performance(session: SessionDep) -> PerformanceInfo:
    """Task Manager performance counters, sampled from live scheduler state."""
    return kernel.performance(session)


@app.post(
    "/processes/{ti_id}/end",
    response_model=KillResult,
    dependencies=[Depends(requires_access_dag(method="PUT", access_entity=DagAccessEntity.TASK_INSTANCE))],
)
def end_process(ti_id: str, session: SessionDep, allowed_dags: AuthorizedDagsDep) -> KillResult:
    """'End Process': fail the task instance behind a Task Manager row.

    Addressed by ``TaskInstance.id``, never by the PID on screen. The PID for a task
    with no worker is a CRC32 of its key into 64512 slots, so collisions are likely
    once a few hundred processes are listed - resolving a process from its PID could
    fail somebody else's task.

    Deliberately does not cascade to downstream tasks; Windows 95 did not ask
    permission either. If the worker is still alive it may report its own result
    afterwards, which is the authentic "this program is not responding" experience.
    """
    from uuid import UUID

    from airflow.models.taskinstance import TaskInstance as TI
    from sqlalchemy import select

    # TaskInstance.id is a Uuid column: SQLAlchemy needs a UUID object, and handing it
    # the raw path string fails deep in the driver ('str' has no attribute 'hex')
    # rather than simply matching nothing.
    try:
        key = UUID(ti_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="No such process") from None

    # A full entity load, unlike the read paths: set_state needs the mapped object and
    # its dag-run bookkeeping. Write paths already require a current metadata DB.
    ti = session.scalars(select(TI).where(TI.id == key)).first()
    if ti is None or ti.dag_id not in allowed_dags:
        raise HTTPException(status_code=404, detail="No such process")

    previous = str(ti.state) if ti.state else None
    real_pid = getattr(ti, "pid", None)
    ti.set_state(TaskInstanceState.FAILED, session=session)
    session.commit()
    return KillResult(
        pid=real_pid or kernel.synthetic_pid(ti.dag_id, ti.run_id, ti.task_id, ti.map_index),
        task_id=ti.task_id,
        dag_id=ti.dag_id,
        run_id=ti.run_id,
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
def system(session: SessionDep) -> SystemInfo:
    """The System Properties dialog: versions, scheduler health, dag census."""
    return kernel.system_info(session)


# ---------------------------------------------------------------------------
# Explorer
# ---------------------------------------------------------------------------


@app.get("/fs/drives", response_model=list[FsEntry], dependencies=[_reads_dags])
def fs_drives(session: SessionDep, allowed_dags: AuthorizedDagsDep) -> list[FsEntry]:
    """'My Computer': the drives available on this machine."""
    return kernel.list_drives(session, allowed_dags)


@app.get("/fs/list", response_model=FsListing, dependencies=[_reads_task_instances])
def fs_list(
    session: SessionDep,
    allowed_dags: AuthorizedDagsDep,
    path: Annotated[
        str, Query(description=r"Wire path with forward slashes, e.g. 'C:/my_dag/manual__2026-01-01'.")
    ] = kernel.DRIVE,
) -> FsListing:
    """List one directory of the synthetic drive."""
    try:
        return kernel.list_dir(session, path, allowed_dags)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Path not found: {exc}") from exc


@app.get("/fs/read", response_model=FsFile, dependencies=[_reads_task_instances])
def fs_read(
    session: SessionDep,
    user: GetUserDep,
    allowed_dags: AuthorizedDagsDep,
    path: Annotated[str, Query(description="Wire path of the file to open in Notepad.")],
) -> FsFile:
    """Open a synthetic file: dag source, dag properties, task details, or an XCom value.

    One route serves several kinds of document, and they are not all governed by the
    same permission, so the specific entity is checked here: dag source needs ``CODE``
    and XCom values need ``XCOM``, matching the core endpoints that serve them.
    """
    segments = kernel.path_segments(path)
    if not segments or segments[0] not in allowed_dags:
        raise HTTPException(status_code=404, detail="File not found")

    dag_id = segments[0]
    if segments[-1] == "dag.py":
        _require_dag_entity(user, dag_id, DagAccessEntity.CODE)
    elif "xcom" in segments:
        _require_dag_entity(user, dag_id, DagAccessEntity.XCOM)

    try:
        return kernel.read_file(session, path, allowed_dags)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"File not found: {exc}") from exc


# ---------------------------------------------------------------------------
# Recycle Bin
# ---------------------------------------------------------------------------


@app.get("/recycle-bin", response_model=list[RecycledItem], dependencies=[_reads_task_instances])
def recycle_bin(session: SessionDep, allowed_dags: AuthorizedDagsDep) -> list[RecycledItem]:
    """Things Airflow deleted but kept: stale dags, and task instances marked removed."""
    return kernel.list_recycled(session, allowed_dags=allowed_dags)


@app.delete(
    "/recycle-bin/dags/{dag_id}",
    dependencies=[Depends(requires_access_dag(method="DELETE"))],
)
def purge_dag(dag_id: str, session: SessionDep, allowed_dags: AuthorizedDagsDep) -> dict[str, str]:
    """'Empty Recycle Bin' for one dag: drop the record and everything hanging off it.

    Refuses anything still live. A dag whose file is present is not in the bin, and
    deleting its history because the desktop asked would be indefensible.
    """
    from sqlalchemy import delete, select

    if dag_id not in allowed_dags:
        raise HTTPException(status_code=404, detail="Dag not found")

    from airflow.models.dag import DagModel

    is_stale = session.scalar(select(DagModel.is_stale).where(DagModel.dag_id == dag_id))
    if is_stale is None:
        raise HTTPException(status_code=404, detail="Dag not found")
    if not is_stale:
        raise HTTPException(
            status_code=409,
            detail=f"{dag_id} is not in the Recycle Bin - its file is still present.",
        )

    session.execute(delete(DagModel).where(DagModel.dag_id == dag_id))
    session.commit()
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
    session: SessionDep,
    allowed_dags: AuthorizedDagsDep,
    include_answered: Annotated[
        bool, Query(description="Also return requests that already have an answer.")
    ] = False,
) -> list[HitlRequest]:
    """Everything waiting on a human, across the whole deployment.

    The core API only lists HITL details one dag run at a time, which cannot answer
    "what needs me?" - so the inbox asks here. Answering still goes through the public
    REST API so the task resume path and its audit entry stay Airflow's.
    """
    return kernel.list_hitl_requests(
        session, allowed_dags=allowed_dags, include_answered=include_answered
    )


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
    session: SessionDep,
    allowed_dags: AuthorizedDagsDep,
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
    if dag_id not in allowed_dags:
        raise HTTPException(status_code=404, detail="Task instance not found")
    try:
        return kernel.failure_evidence(
            session,
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
def control_panel(session: SessionDep) -> dict[str, Any]:
    """Control Panel applets: Variables, Connections (secrets withheld) and Pools."""
    return kernel.control_panel(session)


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
