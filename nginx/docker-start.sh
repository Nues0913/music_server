#!/bin/sh
set -eu
export NGINX_BIND="${NGINX_BIND:-0.0.0.0}"
export API_UPSTREAM="${API_UPSTREAM:-api:3000}"
export AUDIO_ROOT="${AUDIO_ROOT:-/srv/music-audio}"
export SERVER_NAME="${SERVER_NAME:-}"
export ACME_DIRECTORY="${ACME_DIRECTORY:-https://acme-v02.api.letsencrypt.org/directory}"
export ACME_STATE="${ACME_STATE:-/var/lib/nginx/acme}"
export ACME_TRUSTED_CERT="${ACME_TRUSTED_CERT:-/etc/ssl/certs/ca-certificates.crt}"
if [ -n "$SERVER_NAME" ]; then
    case "$SERVER_NAME" in
        *[!a-zA-Z0-9.-]*) echo 'SERVER_NAME must be a single domain, without a scheme or port.' >&2; exit 1 ;;
    esac
    template=domain.conf.template
else
    template=default.conf.template
fi
if [ -n "$SERVER_NAME" ]; then
    mkdir -p "$ACME_STATE"
    chown nginx:nginx "$ACME_STATE"
    chmod 700 "$ACME_STATE"
fi
envsubst '${NGINX_BIND} ${API_UPSTREAM} ${AUDIO_ROOT} ${SERVER_NAME} ${ACME_DIRECTORY} ${ACME_STATE} ${ACME_TRUSTED_CERT}' \
    < "/opt/music-nginx/$template" > /etc/nginx/conf.d/default.conf
