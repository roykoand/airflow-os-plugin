"""Generate demo Variables, Connections and Pools for the Airflow OS container.

Realistic names, random values. The names are fixed so screenshots and demos look
the same on every machine; hosts, ports, logins and passwords are rolled fresh each
time, and every credential is obviously synthetic. Nothing here points at a real
system, and connection passwords never reach the browser anyway.

Writes three files the Airflow CLI can import:

    python demo_data.py <out_dir>   ->  variables.json, connections.json, pools.json
"""

from __future__ import annotations

import json
import random
import secrets
import string
import sys
from pathlib import Path

ALNUM = string.ascii_letters + string.digits


def token(prefix: str = "", length: int = 24) -> str:
    return prefix + "".join(secrets.choice(ALNUM) for _ in range(length))


def password(length: int = 16) -> str:
    return "".join(secrets.choice(ALNUM + "!#%+-") for _ in range(length))


def host(name: str, domain: str = "internal.acme.example") -> str:
    return f"{name}-{random.randint(1, 9):02d}.{domain}"


def ip() -> str:
    return f"10.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}"


REGION = random.choice(["eu-central-1", "eu-west-1", "us-east-1"])
ACCOUNT = f"{random.randint(100000000000, 999999999999)}"


# ------------------------------------------------------------------ variables --

def var(value: object, description: str) -> dict[str, object]:
    """The import format that carries a description alongside the value."""
    return {"value": value, "description": description}


VARIABLES: dict[str, dict[str, object]] = {
    "environment": var("prod", "Deployment tier; dags branch on it for sinks and alert routing"),
    "region": var(REGION, "Cloud region every regional resource name is derived from"),
    "data_lake_bucket": var(f"s3://acme-data-lake-{REGION}", "Root of the raw and curated zones in the data lake"),
    "warehouse_schema": var("analytics", "Target schema for the nightly warehouse loads"),
    "snowflake_warehouse": var("ETL_WH", "Virtual warehouse the ETL role runs on"),
    "dbt_project_dir": var("/opt/dbt/acme_analytics", "Checkout of the dbt project the transform dags invoke"),
    "spark_executor_memory": var("8g", "Default executor memory passed to every SparkSubmitOperator"),
    "etl_batch_size": var(5000, "Rows per batch when extracting from the operational databases"),
    "max_retries_default": var(3, "Retries applied through default_args unless a dag overrides it"),
    "sla_minutes_orders": var(45, "Minutes after the hour by which the order pipeline must land"),
    "gdpr_retention_days": var(730, "Days of personal data kept before the purge dag removes it"),
    "fx_base_currency": var("EUR", "Currency all reporting figures are converted into"),
    "holiday_calendar": var("DE", "Calendar used to skip loads on public holidays"),
    "slack_alert_channel": var("#data-alerts", "Where the on-failure callback posts"),
    "oncall_email": var("data-oncall@acme.example", "Escalation address for missed deadlines"),
    "report_recipients": var(
        ["finance-reporting@acme.example", "cfo-office@acme.example"],
        "Distribution list for the month-end finance pack",
    ),
    "pricing_vendors": var(["northwind", "contoso", "fabrikam"], "Vendors polled by the price feed dag, in priority order"),
    "feature_flags": var(
        {"use_incremental_orders": True, "dual_write_customers": False, "new_fx_source": True},
        "Pipeline feature flags read at parse time; flip without a deploy",
    ),
    "api_key_pricing_feed": var(token("pf_live_", 32), "Bearer token for the vendor price feed; masked by name"),
    "last_full_refresh": var("2026-09-14", "Date of the last full (non-incremental) warehouse rebuild"),
}


# ---------------------------------------------------------------- connections --

def conn(conn_type: str, **fields: object) -> dict[str, object]:
    record: dict[str, object] = {"conn_type": conn_type}
    for key, value in fields.items():
        if value is None:
            continue
        record[key] = json.dumps(value) if key == "extra" and not isinstance(value, str) else value
    return record


CONNECTIONS: dict[str, dict[str, object]] = {
    # Databases
    "warehouse_postgres": conn("postgres", host=host("pg-warehouse"), schema="analytics", login="etl_writer", password=password(), port=5432, description="Primary analytics warehouse"),
    "orders_db": conn("postgres", host=host("pg-orders"), schema="orders", login="airflow_ro", password=password(), port=5432, description="Order service database, read-only replica"),
    "analytics_replica": conn("postgres", host=host("pg-replica"), schema="analytics", login="reporting", password=password(), port=6432, description="PgBouncer in front of the reporting replica"),
    "legacy_erp_mysql": conn("mysql", host=host("erp-mysql"), schema="erp", login="airflow", password=password(), port=3306, description="Legacy ERP, extracted nightly"),
    "finance_mssql": conn("mssql", host=host("finance-sql"), schema="dbo", login="svc_airflow", password=password(), port=1433, description="Finance ledger (SQL Server)"),
    "jdbc_oracle_hr": conn("jdbc", host=f"jdbc:oracle:thin:@{host('hr-oracle')}:1521/HRPDB", login="hr_extract", password=password(), extra={"driver_class": "oracle.jdbc.OracleDriver"}, description="HR system via JDBC"),
    "mongo_customer_profiles": conn("mongo", host=host("mongo"), schema="customers", login="airflow", password=password(), port=27017, extra={"srv": False, "ssl": True}),
    "redis_cache": conn("redis", host=host("redis"), port=6379, extra={"db": 2}, description="Feature cache"),
    "clickhouse_events": conn("generic", host=host("clickhouse"), schema="events", login="etl", password=password(), port=8123, description="Clickstream events"),
    "elasticsearch_logs": conn("elasticsearch", host=host("es"), port=9200, login="airflow", password=password(), extra={"use_ssl": True}),
    # Cloud warehouses & lakes
    "snowflake_prod": conn("snowflake", host=f"acme-{token('', 6).lower()}.{REGION}.snowflakecomputing.com", schema="ANALYTICS", login="AIRFLOW_ETL", password=password(), extra={"account": f"acme-{token('', 6).lower()}", "warehouse": "ETL_WH", "database": "ACME_DW", "role": "ETL_ROLE", "region": REGION}),
    "redshift_dw": conn("redshift", host=f"acme-dw.{token('', 12).lower()}.{REGION}.redshift.amazonaws.com", schema="public", login="airflow", password=password(), port=5439),
    "databricks_workspace": conn("databricks", host=f"adb-{random.randint(10**15, 10**16 - 1)}.{random.randint(1, 20)}.azuredatabricks.net", password=token("dapi", 32), extra={"http_path": f"/sql/1.0/warehouses/{token('', 16).lower()}"}),
    "aws_default": conn("aws", login=token("AKIA", 16).upper(), password=token("", 40), extra={"region_name": REGION}, description="Data platform account"),
    "aws_s3_data_lake": conn("aws", extra={"region_name": REGION, "role_arn": f"arn:aws:iam::{ACCOUNT}:role/airflow-data-lake"}, description="Assumed role for the data lake buckets"),
    "google_cloud_default": conn("google_cloud_platform", extra={"project": "acme-analytics-prod", "keyfile_dict": {"type": "service_account", "project_id": "acme-analytics-prod", "client_email": "airflow@acme-analytics-prod.iam.gserviceaccount.com", "private_key_id": token("", 40).lower()}, "scope": "https://www.googleapis.com/auth/cloud-platform"}),
    "azure_blob_raw": conn("wasb", login="acmerawstorage", password=token("", 64), extra={"connection_string": None}, description="Raw landing zone"),
    "azure_data_lake": conn("adls", login=token("", 36).lower(), password=token("", 40), extra={"tenant_id": token("", 36).lower(), "account_name": "acmedatalake"}),
    # Compute & streaming
    "spark_cluster": conn("spark", host=f"spark://{host('spark-master')}", port=7077, extra={"deploy-mode": "cluster", "queue": "etl"}),
    "kafka_events": conn("kafka", extra={"bootstrap.servers": ",".join(f"{host(f'kafka-{n}')}:9092" for n in range(1, 4)), "security.protocol": "SASL_SSL", "sasl.mechanism": "SCRAM-SHA-512", "sasl.username": "airflow", "sasl.password": password()}),
    "trino_adhoc": conn("trino", host=host("trino"), port=8443, login="airflow", schema="hive", extra={"protocol": "https", "catalog": "hive"}),
    "kubernetes_default": conn("kubernetes", extra={"in_cluster": True, "namespace": "airflow-workers"}),
    # SaaS & APIs
    "http_pricing_api": conn("http", host="https://pricing.vendor.example", password=token("sk_live_", 32), extra={"timeout": 30}, description="Vendor price feed (Bearer)"),
    "http_exchange_rates": conn("http", host="https://api.exchangerates.example", extra={"api_key": token("", 32)}, description="Daily FX rates"),
    "stripe_payments": conn("http", host="https://api.stripe.example", password=token("rk_live_", 40), description="Restricted key, read-only"),
    "salesforce_crm": conn("salesforce", host="https://acme.my.salesforce.example", login="airflow@acme.example", password=password(), extra={"security_token": token("", 24), "domain": "login"}),
    "dbt_cloud": conn("dbt_cloud", login=str(random.randint(10000, 99999)), password=token("dbtc_", 40), extra={"tenant": "cloud"}),
    # Files & transfer
    "sftp_vendor_dropbox": conn("sftp", host=f"sftp.{random.choice(['northwind', 'contoso', 'fabrikam'])}.example", login="acme_inbound", port=22, extra={"key_file": "/opt/airflow/keys/vendor_ed25519", "no_host_key_check": False}),
    "ssh_bastion": conn("ssh", host=ip(), login="airflow", port=22, extra={"key_file": "/opt/airflow/keys/bastion", "conn_timeout": 10}),
    "fs_default": conn("fs", extra={"path": "/opt/airflow/data/landing"}),
    # Alerting
    "slack_alerts": conn("slackwebhook", password=f"https://hooks.slack.example/services/T{token('', 8).upper()}/B{token('', 8).upper()}/{token('', 24)}", description="#data-alerts"),
    "smtp_default": conn("smtp", host="smtp.acme.example", login="airflow-noreply@acme.example", password=password(), port=587, extra={"from_email": "airflow-noreply@acme.example", "disable_tls": False}),
    "pagerduty_oncall": conn("pagerduty_events", password=token("", 32), description="Data platform on-call service"),
}


# -------------------------------------------------------------------- pools --

POOLS: dict[str, dict[str, object]] = {
    "warehouse_pool": {"slots": 8, "description": "Concurrent statements against the analytics warehouse", "include_deferred": False},
    "snowflake_etl": {"slots": 6, "description": "ETL_WH credits: keep the bill predictable", "include_deferred": False},
    "spark_cluster": {"slots": 4, "description": "One slot per Spark application", "include_deferred": False},
    "api_rate_limited": {"slots": 3, "description": "Vendor APIs with per-minute rate limits", "include_deferred": True},
    "sftp_vendor": {"slots": 1, "description": "The vendor SFTP allows a single session", "include_deferred": False},
    "ml_gpu": {"slots": 2, "description": "GPU nodes for model training", "include_deferred": False},
    "notifications": {"slots": 10, "description": "Slack, email and PagerDuty sends", "include_deferred": True},
    "backfill": {"slots": 2, "description": "Throttle for historical reprocessing", "include_deferred": False},
}


def main(out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "variables.json").write_text(json.dumps(VARIABLES, indent=2))
    (out / "connections.json").write_text(json.dumps(CONNECTIONS, indent=2))
    (out / "pools.json").write_text(json.dumps(POOLS, indent=2))
    print(f"{len(VARIABLES)} variables, {len(CONNECTIONS)} connections, {len(POOLS)} pools -> {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
