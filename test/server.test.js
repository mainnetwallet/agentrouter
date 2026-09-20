import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { handleRequest } from '../server.js';
import { captureWarnings, findClosedPort, listen, startUpstream } from './helpers.js';

const KEY = 'test-key-not-real';

/**
 * Start the bridge with AGENTROUTER_* env vars applied for the whole lifetime of
 * the server (the upstream URL is resolved per request, at request time).
 */
async function startBridge(env) {
  const saved = new Map();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  const bridge = await listen(http.createServer(handleRequest));
  return {
    port: bridge.port,
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

async function bridgeRequest(baseUrl, path, { method = 'GET', key = KEY, body, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, contentType: res.headers.get('content-type') || '', text, json };
}

test('GET /v1/models proxies a valid JSON response unchanged', async () => {
  const payload = { object: 'list', data: [{ id: 'claude-opus-4-6', object: 'model' }] };
  const upstream = await startUpstream((req, res) => {
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
  try {
    const res = await bridgeRequest(bridge.baseUrl, '/v1/models');
    assert.equal(res.status, 200);
    assert.match(res.contentType, /application\/json/);
    assert.deepEqual(res.json, payload);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('GET /v1/models returns a clean 502 JSON error for an HTML body', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body>Aliyun WAF captcha challenge</body></html>');
  });
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
  try {
    const res = await bridgeRequest(bridge.baseUrl, '/v1/models');
    assert.equal(res.status, 502);
    assert.match(res.contentType, /application\/json/);
    assert.equal(res.json.error.type, 'upstream_error');
    assert.equal(res.json.error.code, 'non_json_response');
    assert.equal(res.json.error.status, 502);
    assert.equal(res.json.error.message, 'Upstream AgentRouter returned a non-JSON response');
    assert.equal(res.json.error.upstream_status, 200);
    assert.equal(res.json.error.upstream_content_type, 'text/html; charset=utf-8');
    assert.ok(res.json.error.preview.includes('Aliyun WAF captcha'));
    assert.ok(res.json.error.preview.length <= 503);
    // Must not be the reported crash.
    assert.doesNotMatch(res.text, /Unexpected token/);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('GET /v1/models returns 502 invalid_json for malformed JSON', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data": [');
  });
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
  try {
    const res = await bridgeRequest(bridge.baseUrl, '/v1/models');
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'invalid_json');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('GET /v1/models returns 502 empty_response for an empty body', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('');
  });
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
  try {
    const res = await bridgeRequest(bridge.baseUrl, '/v1/models');
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'empty_response');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

for (const status of [401, 403, 404, 429, 500]) {
  test(`upstream HTTP ${status} JSON error is passed through with its status`, async () => {
    const payload = { error: { message: `upstream says ${status}`, type: 'upstream_error', code: `http_${status}` } };
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
    try {
      const res = await bridgeRequest(bridge.baseUrl, '/v1/models');
      assert.equal(res.status, status);
      assert.deepEqual(res.json, payload);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });
}

test(`upstream HTML on an error status becomes 502 non_json_response, not HTML passthrough`, async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(429, { 'content-type': 'text/html' });
    res.end('<html><body>429 rate limited by WAF</body></html>');
  });
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
  try {
    const res = await bridgeRequest(bridge.baseUrl, '/v1/models');
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'non_json_response');
    assert.equal(res.json.error.upstream_status, 429);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('network failure (connection refused) returns 502 network_error', async () => {
  const port = await findClosedPort();
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: `http://127.0.0.1:${port}` });
  try {
    const res = await bridgeRequest(bridge.baseUrl, '/v1/models');
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'network_error');
    assert.equal(res.json.error.upstream_url, `http://127.0.0.1:${port}/v1/models`);
  } finally {
    await bridge.close();
  }
});

test('DNS failure returns 502 dns_error', async () => {
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: 'http://agentrouter-bridge-does-not-exist.invalid' });
  try {
    const res = await bridgeRequest(bridge.baseUrl, '/v1/models');
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'dns_error');
  } finally {
    await bridge.close();
  }
});

test('upstream timeout returns 504 upstream_timeout via AbortController', async () => {
  const upstream = await startUpstream(() => { /* never responds */ });
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl, AGENTROUTER_TIMEOUT_MS: '250' });
  try {
    const startedAt = Date.now();
    const res = await bridgeRequest(bridge.baseUrl, '/v1/models');
    const elapsed = Date.now() - startedAt;
    assert.equal(res.status, 504);
    assert.equal(res.json.error.code, 'upstream_timeout');
    assert.ok(elapsed < 5000, `timed out too slowly: ${elapsed}ms`);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('a redirect that lands on HTML is reported as non_json_response (not followed blindly)', async () => {
  let hits = 0;
  const upstream = await startUpstream((req, res) => {
    hits += 1;
    if (req.url === '/v1/models') {
      res.writeHead(302, { location: '/captcha' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html>challenge</html>');
  });
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
  try {
    const res = await bridgeRequest(bridge.baseUrl, '/v1/models');
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'non_json_response');
    assert.ok(hits >= 2, 'redirect should have been followed to the captcha page');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('POST /v1/chat/completions preserves streaming SSE responses unbuffered', async () => {
  let upstreamFinished = false;
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      upstreamFinished = true;
    }, 150);
  });
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
  try {
    const res = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = '';
    let firstChunkBeforeUpstreamFinished = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received === '') firstChunkBeforeUpstreamFinished = !upstreamFinished;
      received += decoder.decode(value, { stream: true });
    }
    assert.equal(firstChunkBeforeUpstreamFinished, true, 'first chunk must arrive before upstream finishes (streaming, not buffered)');
    assert.match(received, /Hel/);
    assert.match(received, /\[DONE\]/);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('POST /v1/chat/completions returns 502 non_json_response when upstream sends HTML', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html>blocked</html>');
  });
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
  try {
    const res = await bridgeRequest(bridge.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
    });
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'non_json_response');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('POST /v1/chat/completions passes through upstream JSON error statuses', async () => {
  const payload = { error: { message: 'invalid api key', type: 'invalid_request_error', code: 'invalid_api_key' } };
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
  try {
    const res = await bridgeRequest(bridge.baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, payload);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('POST /v1/messages keeps Anthropic compatibility and forwards the query string', async () => {
  const payload = { id: 'msg_1', type: 'message', content: [{ type: 'text', text: 'hi' }] };
  let seenUrl;
  let seenBeta;
  const upstream = await startUpstream((req, res) => {
    seenUrl = req.url;
    seenBeta = req.headers['anthropic-beta'];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
  try {
    const res = await bridgeRequest(bridge.baseUrl, '/v1/messages?beta=true', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, payload);
    assert.equal(seenUrl, '/v1/messages?beta=true');
    assert.match(seenBeta, /claude-code/);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('POST /v1/messages returns 502 for a non-JSON upstream body', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html>bad gateway</html>');
  });
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
  try {
    const res = await bridgeRequest(bridge.baseUrl, '/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 10, messages: [] }),
    });
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'non_json_response');
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('missing API key returns 401 without contacting upstream', async () => {
  let hits = 0;
  const upstream = await startUpstream((_req, res) => { hits += 1; res.end('{}'); });
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
  try {
    const res = await bridgeRequest(bridge.baseUrl, '/v1/models', { key: null });
    assert.equal(res.status, 401);
    assert.equal(res.json.error.type, 'invalid_request_error');
    assert.equal(hits, 0);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test('health check and 404 behaviour are unchanged', async () => {
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: 'http://127.0.0.1:1' });
  try {
    const health = await bridgeRequest(bridge.baseUrl, '/health', { key: null });
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { ok: true, service: 'agentrouter-bridge' });

    const notFound = await bridgeRequest(bridge.baseUrl, '/nope', { key: null });
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.error.type, 'not_found');
  } finally {
    await bridge.close();
  }
});

test('diagnostics never log the client API key or Authorization header', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html>upstream html</html>');
  });
  const bridge = await startBridge({ AGENTROUTER_BASE_URL: upstream.baseUrl });
  try {
    const warnings = await captureWarnings(() => bridgeRequest(bridge.baseUrl, '/v1/models'));
    const output = warnings.join('\n');
    assert.match(output, /event=upstream_response/);
    assert.match(output, /status=200/);
    assert.match(output, /content-type=text\/html/);
    assert.match(output, /body_preview/);
    assert.doesNotMatch(output, new RegExp(KEY));
    assert.doesNotMatch(output, /authorization/i);
    assert.doesNotMatch(output, /bearer /i);
    assert.doesNotMatch(output, /cookie/i);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});
