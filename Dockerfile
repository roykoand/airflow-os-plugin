# syntax=docker/dockerfile:1
#
# Airflow OS in a box: a self-contained Airflow 3 with the desktop plugin installed,
# so it can run next to (and never touch) whatever Airflow is already on the machine.
#
#   docker compose up --build        # then open http://localhost:28080  (admin / admin)
#
# Stage 1 builds the React bundle exactly as scripts/build.sh does; stage 2 stages it
# into the package and pip-installs the plugin into the official Airflow image.

ARG AIRFLOW_IMAGE=apache/airflow:3.3.1-python3.12

# ---------------------------------------------------------------------------- ui bundle
FROM node:22-bookworm-slim AS ui

RUN npm install -g pnpm@10
WORKDIR /build/ui

COPY ui/package.json ui/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY ui/ ./
RUN pnpm build

# ---------------------------------------------------------------------------- airflow
FROM ${AIRFLOW_IMAGE}

# The image runs as uid 50000 (airflow) and installs pip packages into its user site.
# .gitignore comes along because hatchling reads it: it keeps the package walk from picking up
# www/dist, which pyproject's `artifacts` then adds exactly once.
COPY --chown=airflow:root pyproject.toml README.md LICENSE .gitignore /opt/airflow-os/
COPY --chown=airflow:root src /opt/airflow-os/src
COPY --from=ui --chown=airflow:root /build/ui/dist /opt/airflow-os/src/airflow_os/www/dist

# A real (non-editable) install, so the wheel's force-include of www/dist is exercised.
# The Common AI provider powers the Clippy dag. It ships pydantic-ai-slim without model
# clients, so the Anthropic one is added for Clippy's default `anthropic:` model string.
RUN pip install --no-cache-dir "/opt/airflow-os[dev]" \
      apache-airflow-providers-common-ai \
      "pydantic-ai-slim[anthropic]"

# The Python tests run inside the container, where a real Airflow and its metadata
# database exist:  docker compose exec airflow-os pytest /opt/airflow-os/tests
COPY --chown=airflow:root tests /opt/airflow-os/tests

# Demo dags baked in, so `docker run` works without a bind mount. Compose mounts ./dags
# over this path for live editing.
COPY --chown=airflow:root dags /opt/airflow/dags

COPY --chmod=755 docker/start.sh /start.sh
COPY --chmod=755 docker/seed.sh /seed.sh
COPY --chmod=755 docker/kickoff.sh /kickoff.sh
COPY --chown=airflow:root docker/seed /opt/airflow-os/docker/seed

# Everything stateful lives under one directory so a single volume persists it.
ENV AIRFLOW__DATABASE__SQL_ALCHEMY_CONN=sqlite:////opt/airflow/data/airflow.db \
    AIRFLOW__LOGGING__BASE_LOG_FOLDER=/opt/airflow/data/logs \
    AIRFLOW__CORE__SIMPLE_AUTH_MANAGER_PASSWORDS_FILE=/opt/airflow/data/passwords.json \
    AIRFLOW__CORE__LOAD_EXAMPLES=false

# Pre-create the state directory with the airflow user as owner: a named volume mounted on
# a path missing from the image is created root-owned, and the container runs as uid 50000.
USER root
RUN mkdir -p /opt/airflow/data/logs && chown -R airflow:root /opt/airflow/data
USER airflow

EXPOSE 8080
VOLUME /opt/airflow/data

# The image entrypoint execs `bash ...` verbatim, then start.sh execs `airflow standalone`.
CMD ["bash", "/start.sh"]
