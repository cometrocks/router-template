#!/bin/sh
# Only non-secret, fixed hosting identifiers and bounded numeric settings are read.
set -eu
umask 077

fail() {
  # Callers pass only fixed labels, never environment values or file contents.
  printf 'COMET_ROUTER_INGRESS_%s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 2 ] || fail ARGUMENTS_INVALID
[ "${RAILWAY_PROJECT_ID-}" = 'c1b88b1c-eab3-492d-917d-d9a6d2dbf830' ] || fail SCOPE_INVALID
[ "${RAILWAY_ENVIRONMENT_ID-}" = '5117a6fe-f2be-442c-9f4a-9e3a038bed2e' ] || fail SCOPE_INVALID
[ "${RAILWAY_ENVIRONMENT_NAME-}" = 'integration' ] || fail SCOPE_INVALID
[ "${RAILWAY_SERVICE_ID-}" = 'd9295452-f8f4-44fa-ae96-ded72ac9744d' ] || fail SCOPE_INVALID
[ -z "${DEV_MODE-}" ] || fail DEV_MODE_INVALID

mode=${COMET_ROUTER_INGRESS_MODE-off}
case "$mode" in
  off|observe|enforce) ;;
  *) fail MODE_INVALID ;;
esac

observe_metrics=${COMET_ROUTER_OBSERVE_METRICS-0}
case "$observe_metrics" in
  0) ;;
  1) [ "$mode" = observe ] || fail METRICS_MODE_INVALID ;;
  *) fail METRICS_MODE_INVALID ;;
esac

positive_capacity() {
  # Canonical integers only: avoids shell overflow, YAML injection and coercion.
  case "$1" in
    ''|0*|*[!0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 5 ] && [ "$1" -le 10000 ]
}

if [ "$mode" = enforce ]; then
  positive_capacity "${COMET_ROUTER_INGRESS_RATE_PER_SECOND-}" || fail RATE_INVALID
  positive_capacity "${COMET_ROUTER_INGRESS_MAX_IN_FLIGHT-}" || fail CONCURRENCY_INVALID
fi

base=$1
output=$2
[ -f "$base" ] && [ -r "$base" ] || fail BASE_UNREADABLE
# Avoid silently appending a duplicate policy if the baseline evolves.
# The baseline is repository-controlled, never request-supplied YAML.
if grep -Eq '^[[:space:]]*traffic_shaping[[:space:]]*:' "$base" 2>/dev/null; then
  fail BASE_CONFLICT
else
  # grep status 1 means no match; I/O errors must not be treated as a safe base.
  [ "$?" -eq 1 ] || fail BASE_UNREADABLE
fi

# Create beside the destination so publication is atomic on the same filesystem.
temporary=$(mktemp "${output}.tmp.XXXXXX" 2>/dev/null) || fail RENDER_FAILED
trap 'rm -f "$temporary" 2>/dev/null' EXIT HUP INT TERM
cp "$base" "$temporary" 2>/dev/null || fail RENDER_FAILED
if [ "$observe_metrics" = 1 ]; then
  # Insert only into the checked-in layout. Refuse duplicate settings or a
  # changed layout rather than silently replacing existing telemetry.
  awk '
    /^telemetry:$/ {
      telemetry++
      print
      print "  exporters:"
      print "    metrics:"
      print "      common:"
      print "        views:"
      print "          - name: http.server.active_requests"
      print "            allowed_attribute_keys: []"
      print "          - name: http.server.request.duration"
      print "            allowed_attribute_keys: []"
      print "          - name: \"*\""
      print "            aggregation: drop"
      print "      prometheus:"
      print "        enabled: true"
      print "        listen: 127.0.0.1:19091"
      print "        path: /metrics"
      print "        resource_selector: none"
      next
    }
    /^  instrumentation:$/ {
      instrumentation++
      print
      print "    instruments:"
      print "      router:"
      print "        http.server.active_requests: true"
      print "        http.server.request.duration: true"
      next
    }
    /^[[:space:]]*["\047]?(exporters|instruments|prometheus)["\047]?[[:space:]]*:/ { conflict = 1 }
    { print }
    END { if (conflict || telemetry != 1 || instrumentation != 1) exit 1 }
  ' "$base" > "$temporary" 2>/dev/null || fail METRICS_BASE_CONFLICT
fi
if [ "$mode" = enforce ]; then
  (printf '\ntraffic_shaping:\n  router:\n    global_rate_limit:\n      capacity: %s\n      interval: 1s\n    concurrency_limit: %s\n' \
    "$COMET_ROUTER_INGRESS_RATE_PER_SECOND" \
    "$COMET_ROUTER_INGRESS_MAX_IN_FLIGHT" >> "$temporary") 2>/dev/null || fail RENDER_FAILED
fi
mv "$temporary" "$output" 2>/dev/null || fail RENDER_FAILED
trap - EXIT HUP INT TERM
