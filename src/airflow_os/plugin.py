"""Registers Airflow OS with the Airflow api-server.

Two extension points do all the work:

``fastapi_apps``
    mounts the kernel API (and the built React bundle) under ``/airflow-os``.
``react_apps``
    tells the core UI to dynamically import the bundle and render the desktop
    full-screen at ``/airflow-os``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from airflow.configuration import conf
from airflow.plugins_manager import AirflowPlugin

from airflow_os.version_compat import AIRFLOW_V_3_1_PLUS

PLUGIN_PREFIX = "/airflow-os"
URL_ROUTE = "airflow-os"


def _base_path() -> str:
    """The api-server's mount path, so Airflow OS works behind a sub-path deployment."""
    base_url = conf.get("api", "base_url", fallback="/")
    path = urlparse(base_url).path if base_url.startswith(("http://", "https://")) else base_url
    return path.rstrip("/")


def _bundle_fingerprint() -> str:
    """A cache key that changes whenever the built bundle changes.

    The core UI imports the bundle with a plain ``import()``, and the browser caches
    that module aggressively - so a rebuilt desktop keeps rendering the old code until
    someone thinks to hard-refresh. Appending the built file's mtime makes each build
    a distinct URL. Read once at plugin import, so a rebuild needs an api-server
    restart to be picked up (which the build script does anyway).
    """
    bundle = Path(__file__).parent / "www" / "dist" / "main.umd.cjs"
    try:
        return str(int(bundle.stat().st_mtime))
    except OSError:
        from airflow_os import __version__

        return __version__


def bundle_url() -> str:
    """Where the core UI should dynamically import the desktop bundle from.

    Absolute when ``api.base_url`` is a full URL: in Vite dev mode ``import()`` resolves
    relative to the script origin rather than the document origin, so a relative path
    would be looked up on the wrong port.
    """
    path = f"{_base_path()}{PLUGIN_PREFIX}/static/main.umd.cjs?v={_bundle_fingerprint()}"
    base_url = conf.get("api", "base_url", fallback="/")
    if base_url.startswith(("http://", "https://")):
        parsed = urlparse(base_url)
        return f"{parsed.scheme}://{parsed.netloc}{path}"
    return path


class AirflowOSPlugin(AirflowPlugin):
    """Airflow OS - a Windows 95 desktop shell over live Airflow state."""

    name = "airflow_os"

    fastapi_apps: list[dict[str, Any]] = []
    react_apps: list[dict[str, Any]] = []

    if AIRFLOW_V_3_1_PLUS:
        from airflow_os.api import app as _kernel_app

        fastapi_apps = [
            {
                "name": "Airflow OS Kernel",
                "app": _kernel_app,
                "url_prefix": PLUGIN_PREFIX,
            }
        ]
        react_apps = [
            {
                "name": "Airflow OS",
                "url_route": URL_ROUTE,
                "bundle_url": bundle_url(),
                "destination": "nav",
                "icon": f"{_base_path()}{PLUGIN_PREFIX}/static/icon.svg",
            }
        ]
