import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { handleRequest } from '../server.js';
import {
  describeApiKey,
  hasUnsafeKeyChars,
  normalizeApiKey,
  scrubSecret,
} from '../api/upstream.js';
import { captureWarnings, listen, startUpstream } from './helpers.js';

// Clearly fake, test-only key material. Not a real credential.
const FAKE_KEY = 'sk-fake-abcdefghijklmnopqrstuvwxyz0123456789';
const OTHER_FAKE_KEY = 'sk-fake-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';

async function startBridge(env) {
  const saved = new Map();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  const bridge = await listen(http.createServer(handleRequest));
  return {
    baseUrl: bridge.baseUrl,
    async close() {
      await bridge.close();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

/** Capture the Authorization header the bridge actually sent upstream. */
function captureAuthUpstream(responder) {
  const seen = { authorization: null, xApiKey: null, count: 0 };
  const server = startUpstream((req, res) => {
    seen.count += 1;
    seen.authorization = req.headers.authorization ?? null;
    seen.xApiKey = req.headers['x-api-key'] ?? null;
    responder(req, res);
  });
  return { seen, server };
}

test('normalizeApiKey: trims whitespace/newlines, quotes and duplicate Bearer prefixes', () => {
  assert.deepEqual(normalizeApiKey(FAKE_KEY), { key: FAKE_KEY, issues: [] });

  const spaced = normalizeApiKey(`  ${FAKE_KEY}  `);
  assert.equal(spaced.key, FAKE_KEY);
  assert.ok(spaced.issues.includes('key_had_surrounding_whitespace'));

  const quoted = normalizeApiKey(`"${FAKE_KEY}"`);
  assert.equal(quoted.key, FAKE_KEY);
  assert.ok(quoted.issues.includes('key_was_quoted'));

  const singleQuoted = normalizeApiKey(`'${FAKE_KEY}'`);
  assert.equal(singleQuoted.key, FAKE_KEY);
  assert.ok(singleQuoted.issues.includes('key_was_quoted'));

  const bearer = normalizeApiKey(`Bearer ${FAKE_KEY}`);
  assert.equal(bearer.key, FAKE_KEY);
  assert.ok(bearer.issues.includes('key_included_bearer_prefix'));

  const doubleBearer = normalizeApiKey(`Bearer Bearer ${FAKE_KEY}`);
  assert.equal(doubleBearer.key, FAKE_KEY);
  assert.ok(doubleBearer.issues.includes('duplicate_bearer_prefix'));

  const newline = normalizeApiKey(`${FAKE_KEY}\n`);
  assert.equal(newline.key, FAKE_KEY);
  assert.ok(newline.issues.includes('key_contains_newline'));

  assert.equal(normalizeApiKey('   ').key, '');
  assert.ok(normalizeApiKey('   ').issues.includes('key_empty_after_sanitization'));
  assert.equal(normalizeApiKey(undefined).key, '');
  assert.ok(normalizeApiKey(undefined).issues.includes('key_not_a_string'));
});

test('hasUnsafeKeyChars: rejects whitespace, control characters and non-ASCII', () => {
  assert.equal(hasUnsafeKeyChars(FAKE_KEY), false);
  assert.equal(hasUnsafeKeyChars('sk-key with space'), true);
  assert.equal(hasUnsafeKeyChars('sk-key\ninjection'), true);
  assert.equal(hasUnsafeKeyChars('sk-key-ünicode'), true);
  assert.equal(hasUnsafeKeyChars(''), true);
});

test('describeApiKey: reports metadata only, never the key', () => {
  const descriptor = describeApiKey(FAKE_KEY);
  assert.equal(descriptor.key_present, true);
  assert.equal(descriptor.key_length, FAKE_KEY.length);
  assert.equal(descriptor.key_first3, FAKE_KEY.slice(0, 3));
  assert.equal(descriptor.key_last3, FAKE_KEY.slice(-3));
  assert.match(descriptor.key_fingerprint, /^[0-9a-f]{8}$/);

  const serialized = JSON.stringify(descriptor);
  assert.ok(!serialized.includes(FAKE_KEY));
  assert.notEqual(descriptor.key_fingerprint, describeApiKey(OTHER_FAKE_KEY).key_fingerprint);
  assert.equal(descriptor.key_fingerprint, describeApiKey(FAKE_KEY).key_fingerprint);

  const missing = describeApiKey('');
  assert.equal(missing.key_present, false);
  assert.equal(missing.key_length, 0);
  assert.equal(missing.key_fingerprint, null);
});

test('scrubSecret: removes key material from previews', () => {
  assert.equal(scrubSecret(`invalid key ${FAKE_KEY} supplied`, FAKE_KEY), 'invalid key <redacted> supplied');
  assert.equal(scrubSecret('no secret here', FAKE_KEY), 'no secret here');
  assert.equal(scrubSecret('body', ''), 'body');
});

test('bridge forwards Authorization: Bearer <key> exactly', async () => {
  const { seen, server } = captureAuthUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[]}');
  });
  try {
    const upstream = await server;
    const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
    const res = await fetch(`${bridge.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${FAKE_KEY}` } });
    assert.equal(res.status, 200);
    assert.equal(seen.authorization, `Bearer ${FAKE_KEY}`);
    await bridge.close();
  } finally {
    await (await server).close();
  }
});

for (const [label, header] of [
  ['surrounding whitespace', `Bearer   ${FAKE_KEY}  `],
  ['duplicate Bearer', `Bearer Bearer ${FAKE_KEY}`],
  ['wrapping double quotes', `Bearer "${FAKE_KEY}"`],
  ['wrapping single quotes', `Bearer '${FAKE_KEY}'`],
  ['lowercase scheme', `bearer ${FAKE_KEY}`],
]) {
  test(`bridge normalises a key with ${label}`, async () => {
    const { seen, server } = captureAuthUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
    });
    try {
      const upstream = await server;
      const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
      const res = await fetch(`${bridge.baseUrl}/v1/models`, { headers: { authorization: header } });
      assert.equal(res.status, 200);
      assert.equal(seen.authorization, `Bearer ${FAKE_KEY}`);
      await bridge.close();
    } finally {
      await (await server).close();
    }
  });
}

test('bridge forwards x-api-key as Authorization: Bearer <key>', async () => {
  const { seen, server } = captureAuthUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[]}');
  });
  try {
    const upstream = await server;
    const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
    const res = await fetch(`${bridge.baseUrl}/v1/models`, { headers: { 'x-api-key': FAKE_KEY } });
    assert.equal(res.status, 200);
    assert.equal(seen.authorization, `Bearer ${FAKE_KEY}`);
    await bridge.close();
  } finally {
    await (await server).close();
  }
});

test('bridge rejects a key that cannot be sent as a header instead of forwarding it', async () => {
  const { seen, server } = captureAuthUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[]}');
  });
  const upstream = await server;
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
  try {
    // A space inside a header value is legal HTTP, so this reaches the bridge.
    // Newlines/tabs are covered by the normalizeApiKey / hasUnsafeKeyChars unit tests.
    const res = await fetch(`${bridge.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${FAKE_KEY.slice(0, 10)} extra${FAKE_KEY.slice(10)}` },
    });
    const body = await res.json();
    assert.equal(res.status, 401);
    assert.equal(body.error.code, 'malformed_api_key');
    assert.equal(body.error.key_source, 'authorization');
    assert.equal(body.error.key_length, FAKE_KEY.length + 6);
    assert.ok(!JSON.stringify(body).includes(FAKE_KEY));
    assert.equal(seen.count, 0, 'upstream must not be contacted with an unsendable key');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('bridge rejects an empty/whitespace-only key without contacting upstream', async () => {
  const { seen, server } = captureAuthUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[]}');
  });
  const upstream = await server;
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/models`, { headers: { authorization: 'Bearer    ' } });
    const body = await res.json();
    assert.equal(res.status, 401);
    assert.equal(body.error.code, 'malformed_api_key');
    assert.equal(seen.count, 0);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('upstream 401 triggers key diagnostics with metadata only (no key logged)', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"code":401,"msg":"Invalid API Key!","data":null}');
  });
  try {
    const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
    const warnings = await captureWarnings(() =>
      fetch(`${bridge.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${FAKE_KEY}` } }),
    );
    const output = warnings.join('\n');
    assert.match(output, /event=auth_diagnostic/);
    assert.match(output, /upstream_status=401/);
    assert.match(output, /key_source=authorization/);
    assert.match(output, /key_present=true/);
    assert.match(output, new RegExp(`key_length=${FAKE_KEY.length}`));
    assert.match(output, new RegExp(`key_first3=${FAKE_KEY.slice(0, 3)}`));
    assert.match(output, new RegExp(`key_last3=${FAKE_KEY.slice(-3)}`));
    assert.match(output, /authorization_header_constructed=true/);
    assert.ok(output.includes(describeApiKey(FAKE_KEY).key_fingerprint));
    assert.ok(!output.includes(FAKE_KEY), 'the full key must never be logged');
    await bridge.close();
  } finally {
    await upstream.close();
  }
});

test('an upstream body echoing the key is scrubbed in logs and in the 502 preview', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`gateway rejected credential ${FAKE_KEY} at the edge`);
  });
  try {
    const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
    let responseText = '';
    const warnings = await captureWarnings(async () => {
      const res = await fetch(`${bridge.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${FAKE_KEY}` } });
      responseText = await res.text();
    });
    const output = warnings.join('\n');
    assert.ok(!output.includes(FAKE_KEY), 'logs must not contain the key');
    assert.ok(!responseText.includes(FAKE_KEY), 'the error preview must not contain the key');
    assert.ok(responseText.includes('<redacted>'));
    await bridge.close();
  } finally {
    await upstream.close();
  }
});

test('auth diagnostics endpoint is a 404 unless AGENTROUTER_DEBUG_AUTH=1', async () => {
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: 'http://127.0.0.1:1' });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/debug/auth`, { headers: { authorization: `Bearer ${FAKE_KEY}` } });
    assert.equal(res.status, 404);
  } finally {
    await bridge.close();
  }
});

test('auth diagnostics endpoint reports A vs B without exposing the key', async () => {
  let upstreamHits = 0;
  const upstream = await startUpstream((_req, res) => {
    upstreamHits += 1;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"code":401,"msg":"Invalid API Key!","data":null}');
  });
  try {
    const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl, AGENTROUTER_DEBUG_AUTH: '1' });
    const res = await fetch(`${bridge.baseUrl}/v1/debug/auth`, { headers: { authorization: `Bearer ${FAKE_KEY}` } });
    const report = await res.json();
    const serialized = JSON.stringify(report);

    assert.equal(res.status, 200);
    assert.equal(report.authorization_scheme, 'Bearer');
    assert.equal(report.authorization_header_constructed, true);
    assert.equal(report.request_key.key_present, true);
    assert.equal(report.request_key.key_length, FAKE_KEY.length);
    assert.equal(report.request_key.key_first3, FAKE_KEY.slice(0, 3));
    assert.equal(report.request_key.key_last3, FAKE_KEY.slice(-3));
    assert.equal(report.probe_a_direct_upstream_with_same_key.status, 401);
    assert.equal(upstreamHits, 1, 'direct probe should hit upstream once');
    assert.match(report.diagnosis, /rejected/i);

    assert.ok(!serialized.includes(FAKE_KEY), 'the report must never contain the key');
    await bridge.close();
  } finally {
    await upstream.close();
  }
});

test('auth diagnostics probes a configured env key only when it matches the caller key', async () => {
  let sawEnvProbe = false;
  const upstream = await startUpstream((req, res) => {
    if (req.headers.authorization === `Bearer ${FAKE_KEY}` && req.url === '/v1/models') {
      sawEnvProbe = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[{"id":"glm-4.6"}]}');
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"code":401,"msg":"Invalid API Key!","data":null}');
  });
  try {
    const bridge = await startBridge({
      AGENTROUTER_BASE_URL: upstream.baseUrl,
      AGENTROUTER_DEBUG_AUTH: '1',
      AGENTROUTER_API_KEY: FAKE_KEY,
    });
    const res = await fetch(`${bridge.baseUrl}/v1/debug/auth`, { headers: { authorization: `Bearer ${FAKE_KEY}` } });
    const report = await res.json();
    assert.equal(res.status, 200);
    assert.equal(sawEnvProbe, true);
    assert.equal(report.env_keys_configured.length, 1);
    assert.equal(report.env_keys_configured[0].name, 'AGENTROUTER_API_KEY');
    assert.equal(report.probe_env_key.status, 200);
    assert.equal(report.env_keys_configured[0].key_fingerprint, report.request_key.key_fingerprint);
    assert.ok(!JSON.stringify(report).includes(FAKE_KEY));
    await bridge.close();
  } finally {
    await upstream.close();
  }
});

test('auth diagnostics does not use the server key when the caller sends a different key', async () => {
  const upstream = await startUpstream((req, res) => {
    if (req.headers.authorization === `Bearer ${FAKE_KEY}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"code":401,"msg":"Invalid API Key!","data":null}');
  });
  try {
    const bridge = await startBridge({
      AGENTROUTER_BASE_URL: upstream.baseUrl,
      AGENTROUTER_DEBUG_AUTH: '1',
      AGENTROUTER_API_KEY: FAKE_KEY,
    });
    const res = await fetch(`${bridge.baseUrl}/v1/debug/auth`, { headers: { authorization: `Bearer ${OTHER_FAKE_KEY}` } });
    const report = await res.json();
    assert.equal(res.status, 200);
    assert.match(report.probe_env_key.skipped, /does_not_match/);
    assert.equal(report.probe_a_direct_upstream_with_same_key.status, 401);
    assert.ok(!JSON.stringify(report).includes(FAKE_KEY));
    assert.ok(!JSON.stringify(report).includes(OTHER_FAKE_KEY));
    await bridge.close();
  } finally {
    await upstream.close();
  }
});
