"""Version gates.

Airflow OS relies on the ``react_apps`` plugin extension point, which is new in
Airflow 3.1. Everything UI-related is guarded on :data:`AIRFLOW_V_3_1_PLUS` so the
package stays importable (and ``pip install``-able) on older releases instead of
exploding at plugin-load time.
"""

from __future__ import annotations

from airflow import __version__ as AIRFLOW_VERSION

try:  # Airflow 3.x
    from packaging.version import Version
except ImportError:  # pragma: no cover - packaging always ships with Airflow
    Version = None  # type: ignore[assignment]


def _at_least(major: int, minor: int) -> bool:
    if Version is None:  # pragma: no cover
        return False
    base = Version(AIRFLOW_VERSION).base_version
    parsed = Version(base)
    return (parsed.major, parsed.minor) >= (major, minor)


AIRFLOW_V_3_1_PLUS = _at_least(3, 1)

__all__ = ["AIRFLOW_VERSION", "AIRFLOW_V_3_1_PLUS"]
