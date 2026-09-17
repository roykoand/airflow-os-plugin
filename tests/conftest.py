"""Shared fixtures.

Two kinds of test live here:

* pure unit tests of the kernel's helpers, which import ``airflow_os`` and therefore
  need Airflow importable (the Docker image has it; ``pip install -e .[dev]`` does too);
* tests against the metadata database, which use Airflow's own session and are
  skipped when no database is configured.
"""

from __future__ import annotations

import os

import pytest


@pytest.fixture(scope="session")
def session():
    """An Airflow ORM session, or skip when the tests run without a metadata db."""
    try:
        from airflow import settings
    except Exception as cause:  # pragma: no cover - only without Airflow installed
        pytest.skip(f"Airflow is not importable here: {cause}")
    if not os.environ.get("AIRFLOW__DATABASE__SQL_ALCHEMY_CONN") and not os.path.exists(
        os.path.join(os.environ.get("AIRFLOW_HOME", ""), "airflow.db")
    ):
        pytest.skip("no metadata database configured")
    settings.configure_orm()
    with settings.Session() as db:
        try:
            from airflow.models import DagModel
            from sqlalchemy import select

            db.execute(select(DagModel.dag_id).limit(1)).all()
        except Exception as cause:
            pytest.skip(f"metadata database not reachable: {cause}")
        yield db
