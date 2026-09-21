#!/bin/sh
set -eu

/bin/sh /opt/comet/render-config.sh /config/router_base.yaml /config/router_config.yaml
if ! /opt/router config validate /config/router_config.yaml >/dev/null 2>&1; then
  printf '%s\n' 'COMET_ROUTER_INGRESS_CONFIG_INVALID' >&2
  exit 1
fi
exec /init "$@"
