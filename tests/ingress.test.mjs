import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = readFileSync(join(root, 'router.yaml'), 'utf8');
const pins = {
  RAILWAY_PROJECT_ID: 'c1b88b1c-eab3-492d-917d-d9a6d2dbf830',
  RAILWAY_ENVIRONMENT_ID: '5117a6fe-f2be-442c-9f4a-9e3a038bed2e',
  RAILWAY_ENVIRONMENT_NAME: 'integration',
  RAILWAY_SERVICE_ID: 'd9295452-f8f4-44fa-ae96-ded72ac9744d',
};
// Deliberately do not inherit APOLLO_KEY, graph refs, telemetry or Railway env.
const cleanEnv = { PATH: '/usr/bin:/bin:/usr/local/bin', APOLLO_TELEMETRY_DISABLED: 'true' };
const binary = process.env.ROUTER_TEST_BINARY;
const dockerImage = process.env.ROUTER_TEST_IMAGE;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'comet-ingress-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function render(directory, overrides = {}, source = baseline) {
  const input = join(directory, 'base.yaml');
  const output = join(directory, 'rendered.yaml');
  writeFileSync(input, source);
  const env = { ...cleanEnv, ...pins, ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const result = spawnSync('/bin/sh', [join(root, 'integration/render-config.sh'), input, output], { env, encoding: 'utf8' });
  return { ...result, output };
}

test('off, observe and unset modes preserve baseline bytes and restrictive permissions', (t) => {
  for (const mode of [undefined, 'off', 'observe']) {
    const result = render(fixture(t), { COMET_ROUTER_INGRESS_MODE: mode });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(result.output, 'utf8'), baseline);
    assert.equal(statSync(result.output).mode & 0o777, 0o600);
    assert.equal(result.stdout, '');
  }
});

test('enforce appends the exact native policy at both allowed boundaries', (t) => {
  for (const limit of ['1', '10000']) {
    const result = render(fixture(t), {
      COMET_ROUTER_INGRESS_MODE: 'enforce',
      COMET_ROUTER_INGRESS_RATE_PER_SECOND: limit,
      COMET_ROUTER_INGRESS_MAX_IN_FLIGHT: limit,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(result.output, 'utf8'), `${baseline}\ntraffic_shaping:\n  router:\n    global_rate_limit:\n      capacity: ${limit}\n      interval: 1s\n    concurrency_limit: ${limit}\n`);
  }
});

test('every pin fails closed when missing or incorrect without mutating output', (t) => {
  for (const key of Object.keys(pins)) {
    for (const value of [undefined, 'wrong-pin-secret-marker']) {
      const directory = fixture(t);
      writeFileSync(join(directory, 'rendered.yaml'), 'existing-output');
      const result = render(directory, { [key]: value });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'COMET_ROUTER_INGRESS_CONFIG_INVALID\n');
      assert.equal(readFileSync(result.output, 'utf8'), 'existing-output');
    }
  }
});

test('invalid mode and noncanonical capacities fail with a secret-free error', (t) => {
  const valid = { COMET_ROUTER_INGRESS_MODE: 'enforce', COMET_ROUTER_INGRESS_RATE_PER_SECOND: '10', COMET_ROUTER_INGRESS_MAX_IN_FLIGHT: '10' };
  const cases = ['', 'ENFORCE', 'secret-marker\ntraffic_shaping:'].map((mode) => ({ ...valid, COMET_ROUTER_INGRESS_MODE: mode }));
  for (const name of ['COMET_ROUTER_INGRESS_RATE_PER_SECOND', 'COMET_ROUTER_INGRESS_MAX_IN_FLIGHT']) {
    for (const value of [undefined, '', '0', '-1', '01', '+1', '1.0', '1e2', ' 1', '1 ', '10001', '99999999999999999999999999', '1\nsecret-marker: yes']) {
      cases.push({ ...valid, [name]: value });
    }
  }
  for (const env of cases) {
    const directory = fixture(t);
    writeFileSync(join(directory, 'rendered.yaml'), 'existing-output');
    const result = render(directory, env);
    assert.equal(result.status, 1, JSON.stringify(env));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'COMET_ROUTER_INGRESS_CONFIG_INVALID\n');
    assert.equal(readFileSync(result.output, 'utf8'), 'existing-output');
  }
});

test('DEV_MODE cannot bypass the rendered configuration', (t) => {
  for (const value of ['true', 'false', '0', 'secret-marker']) {
    const result = render(fixture(t), { DEV_MODE: value });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'COMET_ROUTER_INGRESS_CONFIG_INVALID\n');
  }
});

test('an existing traffic_shaping key is rejected for every mode', (t) => {
  for (const mode of ['off', 'observe', 'enforce']) {
    const directory = fixture(t);
    writeFileSync(join(directory, 'rendered.yaml'), 'existing-output');
    const result = render(directory, { COMET_ROUTER_INGRESS_MODE: mode, COMET_ROUTER_INGRESS_RATE_PER_SECOND: '10', COMET_ROUTER_INGRESS_MAX_IN_FLIGHT: '10' }, `${baseline}\ntraffic_shaping: {}\n`);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'COMET_ROUTER_INGRESS_CONFIG_INVALID\n');
    assert.equal(readFileSync(result.output, 'utf8'), 'existing-output');
  }
});

test('missing input and wrong argument counts preserve the existing output', (t) => {
  const directory = fixture(t);
  const output = join(directory, 'rendered.yaml');
  writeFileSync(output, 'existing-output');
  for (const args of [[], [join(root, 'router.yaml')], [join(root, 'router.yaml'), output, 'extra'], [join(directory, 'missing-input'), output]]) {
    const result = spawnSync('/bin/sh', [join(root, 'integration/render-config.sh'), ...args], { env: { ...cleanEnv, ...pins }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'COMET_ROUTER_INGRESS_CONFIG_INVALID\n');
    assert.equal(readFileSync(output, 'utf8'), 'existing-output');
  }
});

test('integration uses the default runtime image and leaves default tracked files unchanged', () => {
  const standard = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const integration = readFileSync(join(root, 'Dockerfile.integration'), 'utf8');
  assert.equal(integration.match(/^FROM (.+)$/m)?.[1], standard.match(/^FROM (.+)$/m)?.[1]);
  for (const name of ['Dockerfile', 'router.yaml']) {
    const committed = spawnSync('git', ['show', `HEAD:${name}`], { cwd: root, encoding: 'utf8' });
    assert.equal(committed.status, 0, committed.stderr);
    assert.equal(readFileSync(join(root, name), 'utf8'), committed.stdout);
  }
});

test('CI requires an explicit Router binary', () => {
  if (process.env.REQUIRE_ROUTER_INTEGRATION === '1') assert.ok(binary, 'ROUTER_TEST_BINARY is required');
});

test('pinned image wrapper renders, validates and forwards arguments to init', { skip: !dockerImage, timeout: 60000 }, (t) => {
  const directory = fixture(t);
  const init = join(directory, 'init');
  writeFileSync(init, '#!/bin/sh\nprintf "INIT_REACHED:%s\\n" "$*"\ncat /config/router_config.yaml\n', { mode: 0o755 });
  const args = ['run', '--rm', '--network', 'none', '--mount', `type=bind,source=${init},target=/init,readonly`];
  for (const [key, value] of Object.entries(pins)) args.push('--env', `${key}=${value}`);
  args.push('--env', 'APOLLO_TELEMETRY_DISABLED=true');
  for (const mode of ['off', 'observe', 'enforce']) {
    const result = spawnSync('docker', [...args, '--env', `COMET_ROUTER_INGRESS_MODE=${mode}`, '--env', 'COMET_ROUTER_INGRESS_RATE_PER_SECOND=1', '--env', 'COMET_ROUTER_INGRESS_MAX_IN_FLIGHT=1', dockerImage, 'forwarded-argument'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const rendered = render(fixture(t), { COMET_ROUTER_INGRESS_MODE: mode, COMET_ROUTER_INGRESS_RATE_PER_SECOND: '1', COMET_ROUTER_INGRESS_MAX_IN_FLIGHT: '1' });
    assert.equal(result.stdout, `INIT_REACHED:forwarded-argument\n${readFileSync(rendered.output, 'utf8')}`);
  }
  const invalid = join(directory, 'invalid.yaml');
  writeFileSync(invalid, 'secret-marker: [invalid-yaml\n');
  const result = spawnSync('docker', [...args, '--mount', `type=bind,source=${invalid},target=/config/router_base.yaml,readonly`, dockerImage], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'COMET_ROUTER_INGRESS_CONFIG_INVALID\n');
});

async function listen(server) {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return server.address().port;
}

async function startRouter(t, limits) {
  const directory = fixture(t);
  let subgraphCalls = 0;
  let pending;
  let hold = false;
  const stub = createServer(async (request, response) => {
    for await (const _ of request) { /* consume only the synthetic local request */ }
    subgraphCalls += 1;
    if (hold) await new Promise((done) => { pending = done; });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { me: { name: 'Local fixture' } } }));
  });
  const subgraphPort = await listen(stub);
  t.after(() => { pending?.(); stub.closeAllConnections(); stub.close(); });
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((done) => reservation.close(done));
  const schema = readFileSync(join(root, '.github/workflows/supergraph.graphql'), 'utf8')
    .replaceAll('http://localhost:4001/', `http://127.0.0.1:${subgraphPort}/`)
    .replaceAll('http://localhost:4002/', `http://127.0.0.1:${subgraphPort}/`);
  writeFileSync(join(directory, 'supergraph.graphql'), schema);
  const source = `supergraph:\n  listen: 127.0.0.1:${port}\nhealth_check:\n  enabled: false\ntelemetry:\n  instrumentation:\n    spans:\n      mode: spec_compliant\n`;
  const rendered = render(directory, limits, source);
  assert.equal(rendered.status, 0, rendered.stderr);
  const child = spawn(binary, ['--config', rendered.output, '--supergraph', join(directory, 'supergraph.graphql')], { env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((done) => child.once('exit', done)), delay(2000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
  const url = `http://127.0.0.1:${port}/`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) assert.fail(`Router exited: ${logs}`);
    try { await fetch(`${url}not-a-graphql-route`, { signal: AbortSignal.timeout(500) }); ready = true; break; } catch { await delay(50); }
  }
  assert.ok(ready, `Router did not become ready: ${logs}`);
  const post = (body = JSON.stringify({ query: '{ me { name } }' })) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
  return { url, post, calls: () => subgraphCalls, hold: () => { hold = true; }, release: () => { hold = false; pending?.(); } };
}

test('Router 2.7.0 validates every rendered mode and capacity boundary', { skip: !binary }, (t) => {
  const version = spawnSync(binary, ['--version'], { env: cleanEnv, encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^2\.7\.0\s*$/);
  for (const mode of ['off', 'observe', 'enforce']) {
    for (const limit of ['1', '10000']) {
      const result = render(fixture(t), { COMET_ROUTER_INGRESS_MODE: mode, COMET_ROUTER_INGRESS_RATE_PER_SECOND: limit, COMET_ROUTER_INGRESS_MAX_IN_FLIGHT: limit });
      const validated = spawnSync(binary, ['config', 'validate', result.output], { env: cleanEnv, encoding: 'utf8' });
      assert.equal(validated.status, 0, `${mode}/${limit}: ${validated.stderr}${validated.stdout}`);
    }
  }
});

test('native rate limiting rejects malformed GraphQL HTTP bodies before JSON parsing and recovers', { skip: !binary, timeout: 15000 }, async (t) => {
  const router = await startRouter(t, { COMET_ROUTER_INGRESS_MODE: 'enforce', COMET_ROUTER_INGRESS_RATE_PER_SECOND: '1', COMET_ROUTER_INGRESS_MAX_IN_FLIGHT: '10' });
  const first = await router.post('{ invalid-json');
  assert.equal(first.status, 400);
  await first.text();
  const rejected = await router.post('{ invalid-json');
  assert.equal(rejected.status, 503);
  assert.match(await rejected.text(), /RATE_LIMITED/);
  const rejectedGet = await fetch(`${router.url}?query=%7B__typename%7D`);
  assert.equal(rejectedGet.status, 503);
  assert.match(await rejectedGet.text(), /RATE_LIMITED/);
  const unknownRoute = await fetch(`${router.url}not-a-graphql-route`);
  assert.equal(unknownRoute.status, 404);
  assert.equal(router.calls(), 0);
  await delay(1100);
  const recovered = await router.post();
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { data: { me: { name: 'Local fixture' } } });
  assert.equal(router.calls(), 1);
});

for (const mode of ['off', 'observe']) {
  test(`${mode} leaves malformed GraphQL HTTP requests unthrottled`, { skip: !binary, timeout: 15000 }, async (t) => {
    const router = await startRouter(t, { COMET_ROUTER_INGRESS_MODE: mode, COMET_ROUTER_INGRESS_RATE_PER_SECOND: '1', COMET_ROUTER_INGRESS_MAX_IN_FLIGHT: '1' });
    for (let index = 0; index < 3; index += 1) {
      const response = await router.post('{ invalid-json');
      assert.equal(response.status, 400);
      await response.text();
    }
    assert.equal(router.calls(), 0);
  });
}

test('native concurrency limiting rejects before JSON parsing and recovers when a request completes', { skip: !binary, timeout: 15000 }, async (t) => {
  const router = await startRouter(t, { COMET_ROUTER_INGRESS_MODE: 'enforce', COMET_ROUTER_INGRESS_RATE_PER_SECOND: '10000', COMET_ROUTER_INGRESS_MAX_IN_FLIGHT: '1' });
  router.hold();
  const first = router.post();
  for (let attempt = 0; attempt < 100 && router.calls() === 0; attempt += 1) await delay(20);
  assert.equal(router.calls(), 1);
  const rejected = await router.post('{ invalid-json');
  assert.equal(rejected.status, 503);
  assert.match(await rejected.text(), /CONCURRENCY_LIMITED/);
  assert.equal(router.calls(), 1);
  router.release();
  assert.equal((await first).status, 200);
  const recovered = await router.post();
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { data: { me: { name: 'Local fixture' } } });
  assert.equal(router.calls(), 2);
});
