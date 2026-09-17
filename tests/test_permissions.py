"""Row-level filtering by ``allowed_dags``.

The README's rule: every row-level view filters by ``get_authorized_dag_ids(user)``,
because ``requires_access_dag`` with no dag id only asks "may you read dags at all".
These tests hand the kernel an allow-list and check that nothing outside it leaks
through any listing, file or evidence payload. They run against whatever metadata
database is configured (the Docker container's, normally) and skip without one.
"""

from __future__ import annotations

import pytest
from airflow_os import kernel
from sqlalchemy import select


@pytest.fixture(scope="module")
def dag_ids(session) -> list[str]:
    from airflow.models import DagModel

    ids = sorted(session.scalars(select(DagModel.dag_id).where(DagModel.is_stale.is_(False))).all())
    if len(ids) < 2:
        pytest.skip("need at least two dags in the metadata database")
    return ids


def test_drive_listing_shows_only_allowed_dags(session, dag_ids):
    allowed = {dag_ids[0]}
    listing = kernel.list_dir(session, "C:", allowed_dags=allowed)
    names = {entry.name for entry in listing.entries}
    assert names == allowed


def test_empty_allow_list_shows_nothing(session, dag_ids):
    assert kernel.list_dir(session, "C:", allowed_dags=set()).entries == []
    assert kernel.list_recycled(session, allowed_dags=set()) == []
    assert kernel.list_hitl_requests(session, allowed_dags=set()) == []
    assert kernel.list_deadlines(session, allowed_dags=set()) == []


def test_no_allow_list_means_unfiltered(session, dag_ids):
    names = {entry.name for entry in kernel.list_dir(session, "C:", allowed_dags=None).entries}
    assert set(dag_ids) <= names


def test_forbidden_dag_folder_reads_as_absent_not_forbidden(session, dag_ids):
    # Reporting 404 rather than 403 keeps the listing from confirming the dag exists.
    with pytest.raises(FileNotFoundError):
        kernel.list_dir(session, f"C:/{dag_ids[1]}", allowed_dags={dag_ids[0]})


@pytest.mark.parametrize("file", ["dag.py", "properties.json"])
def test_files_of_a_forbidden_dag_read_as_absent(session, dag_ids, file):
    with pytest.raises(FileNotFoundError):
        kernel.read_file(session, f"C:/{dag_ids[1]}/{file}", allowed_dags={dag_ids[0]})


def test_allowed_dag_source_is_readable(session, dag_ids):
    source = kernel.read_file(session, f"C:/{dag_ids[0]}/dag.py", allowed_dags={dag_ids[0]})
    assert source.name == "dag.py"
    assert source.language == "python"


def test_every_row_level_view_filters(session, dag_ids):
    allowed = {dag_ids[0]}
    for rows in (
        kernel.list_recycled(session, allowed_dags=allowed),
        kernel.list_hitl_requests(session, allowed_dags=allowed, include_answered=True),
        kernel.list_deadlines(session, allowed_dags=allowed),
        kernel.list_processes(session, allowed_dags=allowed, include_finished=True),
    ):
        assert {row.dag_id for row in rows if getattr(row, "dag_id", None)} <= allowed
