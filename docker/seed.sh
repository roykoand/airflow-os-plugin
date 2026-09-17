#!/usr/bin/env bash
# Seed the demo Variables, Connections and Pools. Runs once per data volume (a marker
# file remembers it); pass --force to roll fresh values over the existing ones.
#
#   docker compose exec airflow-os bash /seed.sh --force
set -euo pipefail

data_dir=/opt/airflow/data
marker="${data_dir}/.demo-seeded"

if [[ "${1:-}" != "--force" && -f "${marker}" ]]; then
  echo "[airflow-os] demo data already seeded (${marker} exists); use --force to redo"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
python3 /opt/airflow-os/docker/seed/demo_data.py "${work}"

# The metadata db must exist before the CLI can write to it. Idempotent, and
# `airflow standalone` re-checks it afterwards anyway.
airflow db migrate >/dev/null 2>&1

airflow variables import --action-on-existing-key overwrite "${work}/variables.json"
airflow connections import --overwrite "${work}/connections.json"
airflow pools import "${work}/pools.json"

date -u +%Y-%m-%dT%H:%M:%SZ > "${marker}"
echo "[airflow-os] demo data seeded"
