#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v openssl >/dev/null || { echo 'Install openssl first.' >&2; exit 1; }
umask 077
mkdir -p "$project_root"/data/{db,audio,inbox,container/db,container/audio,container/inbox}
chmod 755 "$project_root/data" "$project_root/data/audio" "$project_root/data/container" "$project_root/data/container/audio"
if [ ! -e "$project_root/.env" ]; then
  export SETUP_API_TOKEN="$(openssl rand -hex 32)" SETUP_ADMIN_TOKEN="$(openssl rand -hex 32)" SETUP_PLAYLIST_TOKEN="$(openssl rand -hex 32)"
  awk '/^PLAYLIST_BOT_TOKEN=/ {$0="PLAYLIST_BOT_TOKEN=" ENVIRON["SETUP_PLAYLIST_TOKEN"]} /^API_TOKEN=/ {$0="API_TOKEN=" ENVIRON["SETUP_API_TOKEN"]} /^ADMIN_TOKEN=/ {$0="ADMIN_TOKEN=" ENVIRON["SETUP_ADMIN_TOKEN"]} {print}' \
    "$project_root/.env.example" > "$project_root/.env"
fi
export SETUP_API_TOKEN="$(sed -n 's/^API_TOKEN=//p' "$project_root/.env" | head -n 1)"
export SETUP_ADMIN_TOKEN="$(sed -n 's/^ADMIN_TOKEN=//p' "$project_root/.env" | head -n 1)"
[ -n "$SETUP_API_TOKEN" ] || { echo '.env must define API_TOKEN.' >&2; exit 1; }
if [ -z "$SETUP_ADMIN_TOKEN" ]; then
  SETUP_ADMIN_TOKEN="$(openssl rand -hex 32)"
  printf '\nADMIN_TOKEN=%s\n' "$SETUP_ADMIN_TOKEN" >> "$project_root/.env"
fi
if ! grep -q '^PLAYLIST_BOT_TOKEN=' "$project_root/.env"; then
  printf '\nPLAYLIST_BOT_TOKEN=%s\n' "$(openssl rand -hex 32)" >> "$project_root/.env"
fi
export SETUP_PLAYLIST_TOKEN="$(sed -n 's/^PLAYLIST_BOT_TOKEN=//p' "$project_root/.env" | head -n 1)"
if [ ! -e "$project_root/api/.env" ]; then
  awk '/^PLAYLIST_BOT_TOKEN=/ {$0="PLAYLIST_BOT_TOKEN=" ENVIRON["SETUP_PLAYLIST_TOKEN"]} /^API_TOKEN=/ {$0="API_TOKEN=" ENVIRON["SETUP_API_TOKEN"]} /^ADMIN_TOKEN=/ {$0="ADMIN_TOKEN=" ENVIRON["SETUP_ADMIN_TOKEN"]} {print}' \
    "$project_root/api/.env.example" > "$project_root/api/.env"
elif [ -z "$(sed -n 's/^ADMIN_TOKEN=//p' "$project_root/api/.env" | head -n 1)" ]; then
  printf '\nADMIN_TOKEN=%s\n' "$SETUP_ADMIN_TOKEN" >> "$project_root/api/.env"
fi
# Add an independent playlist credential without printing or replacing existing keys.
# Respect deliberately empty values (disabled) in files that already define the key.
if ! grep -q '^PLAYLIST_BOT_TOKEN=' "$project_root/api/.env"; then
  playlist_setup_token="$(sed -n 's/^PLAYLIST_BOT_TOKEN=//p' "$project_root/.env" | head -n 1)"
  printf '\nPLAYLIST_BOT_TOKEN=%s\n' "$playlist_setup_token" >> "$project_root/api/.env"
fi
printf '%s\n' 'Created data directories and missing environment files; existing settings preserved.'
