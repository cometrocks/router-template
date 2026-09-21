# Integration-only GraphQL admission controls

This opt-in image adds per-router rate and concurrency limits **before GraphQL body aggregation and JSON parsing**. It is not an authentication mechanism or a universal HTTP/WAF layer. IAM's shared seven-operation QA quotas must remain enabled when QA is eventually activated.

The default `Dockerfile` and `router.yaml` are unchanged. Select `Dockerfile.integration` only for Comet's integration router after review/merge authorization. Never change the production service's build settings. The wrapper validates fixed project, environment name/ID, and router service IDs, rejects development-mode overrides, renders the runtime configuration, validates it using the pinned Router 2.7.0 binary, then executes the original `/init` supervisor. MCP and other runtime services retain their original startup path.

## Modes and explicit budgets

| Variable | Meaning |
| --- | --- |
| `COMET_ROUTER_INGRESS_MODE` | `off` (default), `observe`, or `enforce`; any other value fails startup. |
| `COMET_ROUTER_INGRESS_RATE_PER_SECOND` | Required only in enforce: native shared capacity for a one-second interval, canonical integer 1–10000. |
| `COMET_ROUTER_INGRESS_MAX_IN_FLIGHT` | Required only in enforce: native concurrency capacity, canonical integer 1–10000. |

These validation ceilings are not recommended deployment values or measured capacity. There are no default enforcement budgets. Each router process owns its limits; adding replicas multiplies aggregate capacity. The native interval budget is not a smooth global request distribution.

`off` and `observe` preserve the baseline YAML exactly and add no native limits. Router observe mode adds no new telemetry: use existing payload-free aggregate provider metrics and controlled local measurements. It must not be described as enforcement. Available CPU/memory samples and sparse edge requests do not justify capacities, and bucketed counts/duration percentiles do not establish instantaneous concurrency.

Do not pass secrets in these settings. Errors are fixed diagnostic labels, never environment/configuration dumps. `DEV_MODE` must be absent or empty. The pinned runtime hardcodes `/config/router_config.yaml`; `APOLLO_ROUTER_CONFIG_PATH` alone does not choose an alternate configuration. Arbitrary nested `APOLLO_ROUTER_*__*` variable names are not a substitute for the explicit configuration in this image.

## Scope and residual risk

Router 2.7 applies these controls to its configured GraphQL GET/POST route and returns HTTP 503 with `RATE_LIMITED` or `CONCURRENCY_LIMITED` under saturation. Malformed JSON on that route consumes admission capacity before parsing. Native timeout/body/complexity settings remain unchanged.

Unknown routes, CORS preflights, health/plugin endpoints, TCP connections and HTTP header reception are outside this plugin limiter. Routing/decompression/telemetry middleware also sits outside it. These controls are not edge bandwidth protection, a total listener-connection cap, tenant fairness, or a guarantee that disconnected downstream work is cancelled. Direct IAM requires its separate pre-parser guard. Keep QA disabled until the scoped protection and remaining rollout checks have been explicitly accepted and verified.

## Rollout

1. Run renderer tests and pinned-binary tests, review both router and IAM changes, then merge through the normal process. Default-image behavior remains unchanged even if the main branch triggers an existing build.
2. With QA disabled, set only the integration router's build Dockerfile to `Dockerfile.integration`. Verify immutable revision, hosting IDs, and successful deployment. Start with `observe`; do not install a runner credential as part of this step.
3. Collect a named observation window covering normal Dashboard and internal/helper traffic. Document sample coverage, expected parallel QA workload, selected headroom and the remaining uncertainty. Review explicit numeric rate/concurrency budgets alongside IAM budgets.
4. Enable `enforce` only after that review. Check effective rendered configuration and native validation, then verify ordinary requests and local negative-test evidence. Do not flood a live deployment to prove rejection.
5. Only after both paths' enforcement and compatibility checks pass may the separate QA provisioning/activation workflow continue.

Rollback: leave QA disabled, restore router mode `off` or the prior integration Dockerfile, and verify the resulting deployment. Do not change production, remove shared IAM auth quotas, delete a brand, or delete/disconnect/reconfigure its parent store or commerce connection.

## Validation

Run `node --test tests/ingress.test.mjs`. Set `ROUTER_TEST_BINARY` to a verified Router 2.7.0 executable and `REQUIRE_ROUTER_INTEGRATION=1` to require native tests rather than allow a local skip. Tests use synthetic schema/services only. Never supply GraphOS credentials for local tests. Tests verify base-file preservation, strict scope/settings, atomic rendering, native schema acceptance and observable admission behavior. CI additionally builds the integration image and tests the actual wrapper; a stopped local Docker daemon is not started by these tests.

Verified upstream boundaries: [router plugin wrapping](https://github.com/apollographql/router/blob/v2.7.0/apollo-router/src/services/router/service.rs#L892), [body aggregation](https://github.com/apollographql/router/blob/v2.7.0/apollo-router/src/services/router/service.rs#L742), [native load shedding](https://github.com/apollographql/router/blob/v2.7.0/apollo-router/src/plugins/traffic_shaping/mod.rs#L264).
