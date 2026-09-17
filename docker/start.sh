#!/usr/bin/env bash
# Container entrypoint: seed the dev credentials once, then run `airflow standalone`
# (scheduler + dag-processor + triggerer + api-server in one process, on SQLite).
set -euo pipefail

data_dir=/opt/airflow/data
mkdir -p "${data_dir}/logs"

# `airflow standalone` generates a random admin password on first boot and prints it
# once. For a local box a known password is friendlier: write the simple auth manager's
# password file ourselves if it is not there yet. Existing files are never touched, so
# the password survives restarts and can be changed in place.
passwords_file="${AIRFLOW__CORE__SIMPLE_AUTH_MANAGER_PASSWORDS_FILE:-${data_dir}/passwords.json}"
if [[ ! -s "${passwords_file}" ]]; then
  python3 - "${passwords_file}" "${AIRFLOW_OS_ADMIN_PASSWORD:-admin}" <<'PY'
import json, sys
path, password = sys.argv[1:]
with open(path, "w") as f:
    json.dump({"admin": password}, f)
PY
  echo "[airflow-os] wrote admin credentials to ${passwords_file}"
fi

# Clippy's model connection. Airflow reads AIRFLOW_CONN_<ID> env vars as connections,
# so an API key in the environment becomes the `anthropic_default` connection with no
# `airflow connections add` step. Left unset, Clippy still reports the evidence and says
# the model call could not be made.
if [[ -n "${ANTHROPIC_API_KEY:-}" && -z "${AIRFLOW_CONN_ANTHROPIC_DEFAULT:-}" ]]; then
  AIRFLOW_CONN_ANTHROPIC_DEFAULT="$(python3 -c 'import json,os; print(json.dumps({"conn_type": "pydanticai", "password": os.environ["ANTHROPIC_API_KEY"]}))')"
  export AIRFLOW_CONN_ANTHROPIC_DEFAULT
  echo "[airflow-os] anthropic_default connection configured from ANTHROPIC_API_KEY"
fi

# Demo Variables, Connections and Pools, so Control Panel has something to show.
# Once per volume; AIRFLOW_OS_SEED_DEMO=false skips it, `bash /seed.sh --force` redoes it.
if [[ "${AIRFLOW_OS_SEED_DEMO:-true}" == "true" ]]; then
  bash /seed.sh
  # Trigger the demo dags once the scheduler is up, so HITL, Deadlines and the
  # stop screen have something to show without waiting for the first schedule.
  bash /kickoff.sh &
fi

exec airflow standalone
