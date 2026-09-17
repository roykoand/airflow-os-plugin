"""End-to-end smoke test against a running Airflow OS.

    AIRFLOW_OS_URL=http://localhost:28080 pytest tests/integration

Logs in with the simple auth manager, then checks that the plugin is registered,
that the kernel answers, and that the bundle is served. Skipped when the URL is
unset, so the unit tests stay runnable offline.
"""

from __future__ import annotations

import json
import os
import urllib.request

import pytest

URL = os.environ.get("AIRFLOW_OS_URL")
USER = os.environ.get("AIRFLOW_OS_USER", "admin")
PASSWORD = os.environ.get("AIRFLOW_OS_PASSWORD", "admin")

pytestmark = pytest.mark.integration


def _request(path: str, token: str | None = None, body: dict | None = None):
    request = urllib.request.Request(f"{URL}{path}", method="POST" if body else "GET")
    request.add_header("Accept", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    data = None
    if body is not None:
        request.add_header("Content-Type", "application/json")
        data = json.dumps(body).encode()
    with urllib.request.urlopen(request, data, timeout=20) as response:
        content_type = response.headers.get("Content-Type", "")
        raw = response.read()
        return json.loads(raw) if "json" in content_type else raw


@pytest.fixture(scope="module")
def token():
    if not URL:
        pytest.skip("AIRFLOW_OS_URL not set")
    return _request("/auth/token", body={"username": USER, "password": PASSWORD})["access_token"]


def test_plugin_is_registered(token):
    plugins = _request("/api/v2/plugins", token)["plugins"]
    ours = next(plugin for plugin in plugins if plugin["name"] == "airflow_os")
    assert [app["url_prefix"] for app in ours["fastapi_apps"]] == ["/airflow-os"]
    assert ours["react_apps"][0]["bundle_url"].startswith("/airflow-os/static/main.umd.cjs")


def test_kernel_answers(token):
    system = _request("/airflow-os/system", token)
    assert system["airflow_os_version"]
    assert system["scheduler_alive"] is True
    for endpoint in ("/processes", "/performance", "/fs/drives", "/hitl", "/deadlines", "/recycle-bin"):
        assert _request(f"/airflow-os{endpoint}", token) is not None


def test_bundle_is_served(token):
    bundle = _request("/airflow-os/static/main.umd.cjs")
    assert len(bundle) > 50_000
    assert b"AirflowPlugin" in bundle


def test_demo_dags_are_parsed(token):
    dags = {dag["dag_id"] for dag in _request("/api/v2/dags?limit=200", token)["dags"]}
    assert {"airflow_os_demo_failure", "airflow_os_demo_hitl", "airflow_os_demo_heartbeat"} <= dags
