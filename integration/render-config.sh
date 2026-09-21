#!/bin/sh
# Only non-secret, fixed hosting identifiers and bounded numeric settings are read.
set -eu
umask 077

fail() {
  printf '%s\n' 'COMET_ROUTER_INGRESS_CONFIG_INVALID' >&2
  exit 1
}

[ "$#" -eq 2 ] || fail
[ "${RAILWAY_PROJECT_ID-}" = 'c1b88b1c-eab3-492d-917d-d9a6d2dbf830' ] || fail
[ "${RAILWAY_ENVIRONMENT_ID-}" = '5117a6fe-f2be-442c-9f4a-9e3a038bed2e' ] || fail
[ "${RAILWAY_ENVIRONMENT_NAME-}" = 'integration' ] || fail
[ "${RAILWAY_SERVICE_ID-}" = 'd9295452-f8f4-44fa-ae96-ded72ac9744d' ] || fail
[ -z "${DEV_MODE-}" ] || fail

mode=${COMET_ROUTER_INGRESS_MODE-off}
case "$mode" in
  off|observe|enforce) ;;
  *) fail ;;
esac

positive_capacity() {
  # Canonical integers only: avoids shell overflow, YAML injection and coercion.
  case "$1" in
    ''|0*|*[!0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 5 ] && [ "$1" -le 10000 ]
}

if [ "$mode" = enforce ]; then
  positive_capacity "${COMET_ROUTER_INGRESS_RATE_PER_SECOND-}" || fail
  positive_capacity "${COMET_ROUTER_INGRESS_MAX_IN_FLIGHT-}" || fail
fi

base=$1
output=$2
[ -r "$base" ] || fail
# Avoid silently appending a duplicate policy if the baseline evolves.
# The baseline is repository-controlled, never request-supplied YAML.
if grep -Eq '^[[:space:]]*traffic_shaping[[:space:]]*:' "$base"; then
  fail
fi

# Create beside the destination so publication is atomic on the same filesystem.
temporary=$(mktemp "${output}.tmp.XXXXXX" 2>/dev/null) || fail
trap 'rm -f "$temporary"' EXIT HUP INT TERM
cp "$base" "$temporary" 2>/dev/null || fail
if [ "$mode" = enforce ]; then
  printf '\ntraffic_shaping:\n  router:\n    global_rate_limit:\n      capacity: %s\n      interval: 1s\n    concurrency_limit: %s\n' \
    "$COMET_ROUTER_INGRESS_RATE_PER_SECOND" \
    "$COMET_ROUTER_INGRESS_MAX_IN_FLIGHT" >> "$temporary" || fail
fi
mv "$temporary" "$output" 2>/dev/null || fail
trap - EXIT HUP INT TERM
