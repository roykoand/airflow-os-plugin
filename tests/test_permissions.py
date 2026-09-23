"""What stops the desktop seeing more than the person driving it.

The rule used to be "filter every row-level view by ``get_authorized_dag_ids(user)``",
because the kernel read the metadata database directly and nothing else would narrow a
deployment-wide listing. The kernel no longer reads the database for these views: it
calls Airflow's own REST API with the caller's own credential, so the permission checks
that apply are the ones the core endpoints already define, and there is no second
implementation to drift out of agreement with the first.

That moves what is worth testing. These check the seam rather than the filter:

* no credential, no read -- there is no service account to fall back to;
* the caller's credential is what actually goes out, on every request;
* a refusal comes back as a refusal, never as an empty list;
* secrets the core API is willing to hand over are dropped before the browser sees them.

Deadlines keep the old allow-list test, because deadlines are the one thing still read
from the database -- Airflow publishes no endpoint for them.
"""

from __future__ import annotations

import json

import httpx
import pytest
from airflow_os import kernel
from airflow_os.rest import Rest, credential_from
from fastapi import HTTPException

TOKEN = "Bearer test-token-for-the-caller"


def fake(handler) -> Rest:
    """A kernel REST client whose api-server is ``handler``."""
    return Rest(TOKEN, transport=httpx.MockTransport(handler))


def json_page(key: str, rows: list[dict]):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={key: rows, "total_entries": len(rows)})

    return handler


# --------------------------------------------------------------------------- credential


def test_a_request_with_no_credential_is_refused():
    with pytest.raises(HTTPException) as refused:
        credential_from(headers={}, cookies={})
    assert refused.value.status_code == 401


def test_the_token_cookie_becomes_a_bearer_header():
    # This is the real path: the desktop is same-origin and sends the api-server's own
    # `_token` cookie, never an Authorization header.
    assert credential_from(headers={}, cookies={"_token": "abc"}) == "Bearer abc"


def test_an_explicit_authorization_header_wins():
    creds = credential_from(headers={"authorization": "Bearer xyz"}, cookies={"_token": "abc"})
    assert creds == "Bearer xyz"


def test_every_request_carries_the_callers_credential():
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("authorization"))
        return httpx.Response(200, json={"dags": [], "total_entries": 0})

    with fake(handler) as client:
        client.get("/dags")
        client.rows("/dags", "dags")

    assert seen, "no request was made"
    assert set(seen) == {TOKEN}


# --------------------------------------------------------------------------- refusals


@pytest.mark.parametrize("status", [401, 403])
def test_a_refusal_is_forwarded_not_swallowed(status):
    """A "no" must reach the desktop as a "no".

    Turning 403 into an empty listing would be the dangerous failure: the window would
    look like a deployment with nothing in it rather than one the caller may not read.
    """
    with fake(lambda request: httpx.Response(status, json={"detail": "nope"})) as client:
        with pytest.raises(HTTPException) as refused:
            client.get("/dags")
    assert refused.value.status_code == status


def test_a_missing_thing_reads_as_empty():
    with fake(lambda request: httpx.Response(404, json={"detail": "not found"})) as client:
        assert client.get("/dags/gone") == {}


def test_an_unreachable_api_server_is_not_an_empty_deployment():
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with fake(refuse) as client:
        with pytest.raises(HTTPException) as failed:
            client.get("/dags")
    assert failed.value.status_code == 503


# --------------------------------------------------------------------------- secrets


def test_control_panel_drops_the_secrets_the_api_hands_over():
    """``/api/v2`` will return a connection's password and extra, and a variable's value.

    The Control Panel lists names and shapes; it has no use for any of that, so it is
    dropped here rather than sent to a browser. This asserts the dropping, by answering
    with secrets and checking none survive.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/variables"):
            rows = {
                "variables": [
                    {
                        "key": "api_key",
                        "value": "s3cr3t-value",
                        "description": "d",
                        "is_encrypted": True,
                    }
                ]
            }
        elif path.endswith("/connections"):
            rows = {
                "connections": [
                    {
                        "connection_id": "warehouse",
                        "conn_type": "postgres",
                        "host": "db.internal",
                        "schema": "public",
                        "login": "reporter",
                        "port": 5432,
                        "description": "d",
                        "password": "s3cr3t-password",
                        "extra": '{"token": "s3cr3t-extra"}',
                    }
                ]
            }
        else:
            rows = {"pools": [{"name": "default_pool", "slots": 8, "occupied_slots": 1}]}
        rows["total_entries"] = 1
        return httpx.Response(200, json=rows)

    with fake(handler) as client:
        panel = kernel.control_panel(client)

    blob = json.dumps(panel)
    assert "s3cr3t" not in blob
    assert panel["connections"][0]["conn_id"] == "warehouse"
    assert panel["variables"][0]["key"] == "api_key"
    assert set(panel["connections"][0]) == {
        "conn_id",
        "conn_type",
        "host",
        "schema",
        "login",
        "port",
        "description",
    }


def test_one_broken_applet_does_not_empty_the_control_panel():
    """A rotated Fernet key makes ``/connections`` answer 500. Pools should still show."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/connections"):
            return httpx.Response(500, json={"detail": "InvalidToken"})
        key = "variables" if request.url.path.endswith("/variables") else "pools"
        rows = [{"key": "k"}] if key == "variables" else [{"name": "default_pool", "slots": 8}]
        return httpx.Response(200, json={key: rows, "total_entries": 1})

    with fake(handler) as client:
        panel = kernel.control_panel(client)

    assert panel["connections"] == []
    assert panel["pools"] and panel["variables"]


def test_a_refused_applet_still_refuses():
    """Degrading is for breakage, not for "you may not see this"."""
    with fake(lambda request: httpx.Response(403, json={"detail": "nope"})) as client:
        with pytest.raises(HTTPException):
            kernel.control_panel(client)


# --------------------------------------------------------------------------- deadlines


def test_deadlines_still_filter_by_the_allow_list(session):
    """The one view still read from the database, so the one that still filters itself."""
    from airflow.models import DagModel
    from sqlalchemy import select

    dag_ids = sorted(session.scalars(select(DagModel.dag_id).where(DagModel.is_stale.is_(False))).all())
    if len(dag_ids) < 2:
        pytest.skip("need at least two dags in the metadata database")

    assert kernel.list_deadlines(session, allowed_dags=set()) == []
    allowed = {dag_ids[0]}
    rows = kernel.list_deadlines(session, allowed_dags=allowed)
    assert {row.dag_id for row in rows if getattr(row, "dag_id", None)} <= allowed


# --------------------------------------------------------------------------- writes


def test_end_process_fails_one_task_and_nothing_downstream():
    """The whole point of End Process: it kills the process, not the pipeline."""
    sent = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "PATCH":
            sent["url"] = str(request.url)
            sent["body"] = json.loads(request.content)
            return httpx.Response(200, json={"state": "failed"})
        return httpx.Response(200, json={"task_instances": [], "total_entries": 0})

    row = {
        "id": "abc",
        "dag_id": "d",
        "dag_run_id": "r",
        "task_id": "t",
        "map_index": 2,
        "state": "running",
    }
    with fake(handler) as client:
        previous = kernel.end_process(client, row)

    assert previous == "running"
    assert sent["body"]["new_state"] == "failed"
    # Every cascade switch off, explicitly, rather than trusting the endpoint's defaults.
    assert not any(
        sent["body"][k]
        for k in ("include_downstream", "include_upstream", "include_future", "include_past")
    )
    # A mapped task is addressed by its index, or the patch would hit the wrong row.
    assert sent["url"].split("?")[0].endswith("/dags/d/dagRuns/r/taskInstances/t/2")


def test_a_process_the_desktop_could_not_list_cannot_be_ended():
    """Identity is TaskInstance.id, and only what the process table showed is in scope."""
    with fake(json_page("task_instances", [{"id": "someone-else"}])) as client:
        assert kernel.find_process(client, "not-in-the-list") is None


def test_emptying_the_recycle_bin_refuses_a_dag_whose_file_is_still_there():
    deleted = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE":
            deleted.append(str(request.url))
            return httpx.Response(200, json={})
        return httpx.Response(200, json={"dag_id": "d", "is_stale": False})

    with fake(handler) as client:
        with pytest.raises(PermissionError):
            kernel.purge_dag(client, "d")
    assert deleted == [], "a live dag must never be deleted"


def test_emptying_the_recycle_bin_deletes_a_stale_dag():
    deleted = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE":
            deleted.append(request.url.path)
            return httpx.Response(200, json={})
        return httpx.Response(200, json={"dag_id": "d", "is_stale": True})

    with fake(handler) as client:
        kernel.purge_dag(client, "d")
    assert deleted == ["/api/v2/dags/d"]


def test_purging_an_unknown_dag_is_not_found():
    with fake(lambda request: httpx.Response(404, json={"detail": "no"})) as client:
        with pytest.raises(FileNotFoundError):
            kernel.purge_dag(client, "gone")


def test_the_allow_list_is_what_the_api_will_show():
    """Deadlines are filtered against this, and it comes from the same place as every read."""
    rows = [{"dag_id": "seen_a"}, {"dag_id": "seen_b"}]
    with fake(json_page("dags", rows)) as client:
        assert kernel.authorized_dag_ids(client) == {"seen_a", "seen_b"}
