#!/usr/bin/env bash
# Build the desktop bundle and stage it where the plugin's FastAPI app serves it from.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="${root}/src/airflow_os/www/dist"

cd "${root}/ui"
pnpm install --frozen-lockfile
pnpm build

rm -rf "${dist}"
mkdir -p "${dist}"
cp -R "${root}/ui/dist/." "${dist}/"

echo "Staged $(du -sh "${dist}" | cut -f1) into src/airflow_os/www/dist"
echo
echo "Restart the api-server to pick this build up: the bundle URL is fingerprinted"
echo "with the file's mtime at plugin import, which is what busts the browser cache."
