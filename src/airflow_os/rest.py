"""A thin client for Airflow's own public REST API, used from inside the api-server.

The kernel used to answer every question by querying the metadata database. It does
not any more: anything ``/api/v2`` can answer is asked over HTTP instead, carrying the
caller's own bearer token, so Airflow applies its own permission checks to the desktop's
reads rather than the plugin re-implementing them.

Two things make this cheaper than it looks. The call never leaves the machine -- the
api-server is talking to itself on loopback -- and the desktop's polling is coarse, a
few requests every few seconds rather than per frame.

One thing stays on the metadata database: the ``deadline`` and ``deadline_alert``
tables. Airflow 3 exposes no deadline endpoints at all -- ``grep -c deadline`` on the
OpenAPI spec returns ``0`` -- which is why the Deadlines mailbox is the only place a
deadline is visible in any Airflow UI, and why it is the one view that still opens a
session.

The wildcard is what makes the rest of it possible. ``~`` stands in for a dag id or a
run id, so ``/dags/~/dagRuns/~/taskInstances`` is the whole deployment's process table
and ``/dags/~/dagRuns/~/hitlDetails`` is the inbox -- the two deployment-wide questions
that used to look like they needed SQL.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

import httpx
from airflow.configuration import conf
from fastapi import HTTPException

#: The wildcard the core API accepts in place of a dag id or run id, which is what makes
#: deployment-wide questions ("every in-flight task instance") answerable over REST.
ANY = "~"

#: Rows per page when walking a paginated collection. The core API caps ``limit`` well
#: above this; a smaller page keeps any single response small enough to parse quickly.
_PAGE = 100

#: Stop paging here. The process table and the HITL inbox are human-readable windows,
#: not exports, and the desktop truncates anyway.
_MAX_ROWS = 1000

_TIMEOUT = httpx.Timeout(15.0, connect=5.0)


@lru_cache(maxsize=1)
def base_url() -> str:
    """Where this api-server can reach itself.

    ``api.base_url`` is what the deployment believes its own address to be, and is set
    whenever Airflow is not on the default port. Falling back to ``api.port`` keeps the
    plugin working when it is unset, which is the common single-node case.

    Cached because it cannot change while the process lives, and because Airflow logs a
    warning every time an unset option is read -- uncached, an unset ``base_url`` wrote a
    line to the scheduler log for every request the desktop made.
    """
    configured = conf.get("api", "base_url", fallback=None)
    if configured:
        return str(configured).rstrip("/")
    port = conf.get("api", "port", fallback="8080")
    return f"http://localhost:{port}"


#: The cookie the api-server sets at log-on. Its value is the JWT the REST API wants in
#: an ``Authorization`` header, so forwarding amounts to moving it from one to the other.
TOKEN_COOKIE = "_token"


def credential_from(headers: Any, cookies: Any) -> str:
    """The caller's own credential, to be replayed against ``/api/v2``.

    The desktop is served from the api-server's own origin and authenticates with the
    ``_token`` cookie, so that is the usual source. An explicit ``Authorization`` header
    wins when one is present, which is what a script driving the kernel API would send.
    """
    header = headers.get("authorization")
    if header:
        return str(header)
    token = cookies.get(TOKEN_COOKIE)
    if token:
        return f"Bearer {token}"
    raise HTTPException(status_code=401, detail="Not authenticated")


class Rest:
    """Reads against ``/api/v2``, as the user who asked.

    The credential is the caller's own, taken off the incoming request by
    :func:`credential_from`. There is no service account here: a request the desktop
    could not have made is one this client cannot make either.
    """

    def __init__(self, token: str, transport: httpx.BaseTransport | None = None) -> None:
        self._token = token
        self._client = httpx.Client(
            base_url=f"{base_url()}/api/v2",
            headers={"Authorization": token},
            timeout=_TIMEOUT,
            # Tests hand in a transport so they can assert what this client sends and how
            # it reacts to a refusal, without standing up an api-server to be refused by.
            transport=transport,
            # The api-server is this process; a redirect would mean a misconfigured
            # base_url, and following it could send the caller's token elsewhere.
            follow_redirects=False,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> Rest:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- the two verbs the kernel needs -------------------------------------

    def get(self, path: str, **params: Any) -> dict[str, Any]:
        """One GET. 404 is returned as ``{}`` so callers can treat "gone" as "empty"."""
        try:
            response = self._client.get(path, params=_clean(params))
        except httpx.RequestError as exc:
            raise HTTPException(
                status_code=503, detail=f"Airflow API unreachable at {base_url()}: {exc}"
            ) from exc
        if response.status_code == 404:
            return {}
        _raise_for_status(response)
        return response.json()

    def patch(self, path: str, body: dict[str, Any], **params: Any) -> dict[str, Any]:
        """One PATCH, for the two state changes the desktop is allowed to make."""
        return self._send("PATCH", path, params, body)

    def delete(self, path: str, **params: Any) -> dict[str, Any]:
        """One DELETE."""
        return self._send("DELETE", path, params, None)

    def _send(self, method: str, path: str, params: dict, body: dict | None) -> dict[str, Any]:
        try:
            response = self._client.request(method, path, params=_clean(params), json=body)
        except httpx.RequestError as exc:
            raise HTTPException(
                status_code=503, detail=f"Airflow API unreachable at {base_url()}: {exc}"
            ) from exc
        _raise_for_status(response)
        try:
            return response.json()
        except ValueError:
            return {}

    def rows(self, path: str, key: str, *, max_rows: int = _MAX_ROWS, **params: Any) -> list[dict]:
        """Every row of a paginated collection, up to ``max_rows``.

        The core API's list responses are ``{<key>: [...], "total_entries": n}``. Pages
        are walked by offset until the collection is exhausted or the cap is reached.
        """
        out: list[dict] = []
        offset = 0
        while len(out) < max_rows:
            page = self.get(path, limit=min(_PAGE, max_rows - len(out)), offset=offset, **params)
            batch = page.get(key) or []
            out.extend(batch)
            total = page.get("total_entries")
            if len(batch) < _PAGE or (total is not None and len(out) >= total):
                break
            offset += len(batch)
        return out


def _clean(params: dict[str, Any]) -> dict[str, Any]:
    """Drop unset params, and send booleans the way the API spells them."""
    out: dict[str, Any] = {}
    for key, value in params.items():
        if value is None:
            continue
        out[key] = "true" if value is True else "false" if value is False else value
    return out


def _raise_for_status(response: httpx.Response) -> None:
    """Pass the core API's own refusal through, rather than inventing one.

    A 401 or 403 from ``/api/v2`` is the real answer to "may this user read this", so it
    is forwarded unchanged: the desktop already knows how to show an expired session.
    """
    if response.is_success:
        return
    detail = response.text[:400]
    try:
        body = response.json()
        detail = body.get("detail", detail) if isinstance(body, dict) else detail
    except ValueError:
        pass
    raise HTTPException(status_code=response.status_code, detail=detail)
