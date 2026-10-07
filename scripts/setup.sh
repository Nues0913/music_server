#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v openssl >/dev/null || { echo 'Install openssl first.' >&2; exit 1; }
umask 077
mkdir -p "$project_root"/data/{db,audio,inbox,container/db,container/audio,container/inbox}
chmod 755 "$project_root/data" "$project_root/data/audio" "$project_root/data/container" "$project_root/data/container/audio"
if [ ! -e "$project_root/.env" ]; then
  export SETUP_API_TOKEN="$(openssl rand -hex 32)" SETUP_ADMIN_TOKEN="$(openssl rand -hex 32)"
  awk '/^API_TOKEN=/ {$0="API_TOKEN=" ENVIRON["SETUP_API_TOKEN"]} /^ADMIN_TOKEN=/ {$0="ADMIN_TOKEN=" ENVIRON["SETUP_ADMIN_TOKEN"]} {print}' \
    "$project_root/.env.example" > "$project_root/.env"
fi
export SETUP_API_TOKEN="$(sed -n 's/^API_TOKEN=//p' "$project_root/.env" | head -n 1)"
export SETUP_ADMIN_TOKEN="$(sed -n 's/^ADMIN_TOKEN=//p' "$project_root/.env" | head -n 1)"
[ -n "$SETUP_API_TOKEN" ] || { echo '.env must define API_TOKEN.' >&2; exit 1; }
if [ -z "$SETUP_ADMIN_TOKEN" ]; then
  SETUP_ADMIN_TOKEN="$(openssl rand -hex 32)"
  printf '\nADMIN_TOKEN=%s\n' "$SETUP_ADMIN_TOKEN" >> "$project_root/.env"
fi
if [ ! -e "$project_root/api/.env" ]; then
  awk '/^API_TOKEN=/ {$0="API_TOKEN=" ENVIRON["SETUP_API_TOKEN"]} /^ADMIN_TOKEN=/ {$0="ADMIN_TOKEN=" ENVIRON["SETUP_ADMIN_TOKEN"]} {print}' \
    "$project_root/api/.env.example" > "$project_root/api/.env"
elif [ -z "$(sed -n 's/^ADMIN_TOKEN=//p' "$project_root/api/.env" | head -n 1)" ]; then
  printf '\nADMIN_TOKEN=%s\n' "$SETUP_ADMIN_TOKEN" >> "$project_root/api/.env"
fi
printf '%s\n' 'Created data directories and missing environment files; existing settings preserved.'
