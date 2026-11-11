# Run inside the router container so raw exporter output stays on loopback.
# Return one unlabeled numeric sample per active/count/sum series.
BEGIN { scope = "{otel_scope_name=\"apollo/router\"}" }

NF != 2 || $2 !~ /^[0-9]+([.][0-9]+)?([eE][-+]?[0-9]+)?$/ { next }

$1 == ("http_server_active_requests" scope) {
  active++
  active_value = $2
}

$1 == ("http_server_request_duration_seconds_count" scope) ||
$1 == ("http_server_request_duration_count" scope) {
  count++
  count_value = $2
}

$1 == ("http_server_request_duration_seconds_sum" scope) ||
$1 == ("http_server_request_duration_sum" scope) {
  sum++
  sum_value = $2
}

END {
  # A missing or duplicate gauge is an incomplete sample, never zero.
  if (active != 1 || count > 1 || sum > 1 || count != sum) exit 1
  print "active_requests", active_value
  if (count == 1) {
    print "request_duration_count", count_value
    print "request_duration_sum", sum_value
  }
}
