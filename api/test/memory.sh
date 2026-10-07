#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_root"
docker compose stats --no-stream
free -m
awk '/^MemTotal:/ {total=$2} /^MemAvailable:/ {available=$2}
  END {used=(total-available)*1024; printf "Host used: %.0f bytes; below 500 MB: %s\n", used, used<500000000 ? "yes" : "no"}' /proc/meminfo
