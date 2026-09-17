#!/usr/bin/env bash
# Give the desktop something to show on first boot: once the dag processor has parsed
# the demo dags, trigger the ones that are not on a tight schedule. Runs in the
# background from start.sh; a marker in the data volume makes it a one-time thing.
set -euo pipefail

marker=/opt/airflow/data/.demo-kicked
[[ -f "${marker}" ]] && exit 0

wanted=(airflow_os_demo_hitl airflow_os_demo_failure airflow_os_demo_nightly_load)

# Wait (up to ~5 minutes) for the api-server and for the dags to be parsed.
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:8080/api/v2/monitor/health >/dev/null 2>&1; then
    listed="$(airflow dags list -o json 2>/dev/null || echo '[]')"
    ready=1
    for dag_id in "${wanted[@]}"; do
      grep -q "\"${dag_id}\"" <<<"${listed}" || ready=0
    done
    [[ "${ready}" == 1 ]] && break
  fi
  sleep 5
done

for dag_id in "${wanted[@]}"; do
  if airflow dags trigger "${dag_id}" >/dev/null 2>&1; then
    echo "[airflow-os] triggered ${dag_id}"
  else
    echo "[airflow-os] could not trigger ${dag_id} (not parsed yet?)"
  fi
done
date -u +%Y-%m-%dT%H:%M:%SZ > "${marker}"
