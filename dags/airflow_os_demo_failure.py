"""A dag that fails for an honest reason, so the desktop has something real to show.

Airflow OS has two features that only look good against a genuine failure: the stop
screen needs an exception to print, and Clippy needs a traceback worth reasoning about.
An empty log teaches neither of them anything.

So this pipeline breaks the way real pipelines break. It fetches a price feed in which
one vendor reports "n/a" instead of a number, and the parsing step does not defend
against it - which is exactly the bug you would have written, and exactly the traceback
you would have had to read on a Friday afternoon.

Trigger it from Run… or the Start menu. It is not scheduled.
"""

from __future__ import annotations

from airflow.sdk import dag, task

# One vendor reports "n/a" for a product it has stopped stocking. Nobody told us.
PRICE_FEED = [
    {"sku": "AOS-100", "vendor": "northwind", "price": "24.99"},
    {"sku": "AOS-101", "vendor": "northwind", "price": "31.50"},
    {"sku": "AOS-102", "vendor": "contoso", "price": "18.00"},
    {"sku": "AOS-103", "vendor": "fabrikam", "price": "n/a"},
    {"sku": "AOS-104", "vendor": "fabrikam", "price": "42.75"},
]


@dag(
    dag_id="airflow_os_demo_failure",
    schedule=None,
    catchup=False,
    is_paused_upon_creation=False,
    tags=["airflow-os", "demo"],
    doc_md=__doc__,
)
def airflow_os_demo_failure():
    @task
    def fetch_price_feed() -> list[dict[str, str]]:
        """Pull today's vendor price feed. This part works fine."""
        print(f"Fetched {len(PRICE_FEED)} rows from the vendor feed")
        return PRICE_FEED

    @task
    def parse_prices(rows: list[dict[str, str]]) -> dict[str, float]:
        """Convert the feed's price strings to floats.

        Trusts the feed. The feed does not deserve it.
        """
        parsed: dict[str, float] = {}
        for row in rows:
            print(f"Parsing {row['sku']} from vendor {row['vendor']}: {row['price']!r}")
            parsed[row["sku"]] = float(row["price"])
        return parsed

    @task
    def load_warehouse(prices: dict[str, float]) -> int:
        """Never runs: it is downstream of the break, so it ends up upstream_failed."""
        print(f"Loading {len(prices)} prices into the warehouse")
        return len(prices)

    load_warehouse(parse_prices(fetch_price_feed()))


airflow_os_demo_failure()
