import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { startUpstream } from './helpers.js';

const KEY = 'test-key-not-real';
const BRIDGE = 'https://bridge.test';

async function callWorker(env, path, { method = 'GET', key = KEY, body } = {}) {
  const request = new Request(`${BRIDGE}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body,
  });
  const res = await worker.fetch(request, env);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, contentType: res.headers.get('content-type') || '', text, json };
}

test('worker: /health is preserved', async () => {
  const res = await callWorker({}, '/health', { key: null });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, service: 'agentrouter-bridge' });
});

test('worker: /v1/models proxies valid JSON', async () => {
  const payload = { object: 'list', data: [{ id: 'glm-4.6' }] };
  const upstream = await startUpstream((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  try {
    const res = await callWorker({ AGENTROUTER_BASE_URL: upstream.baseUrl }, '/v1/models');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, payload);
  } finally {
    await upstream.close();
  }
});

test('worker: HTML upstream returns 502 non_json_response instead of HTML/parse crash', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html>captcha</html>');
  });
  try {
    const res = await callWorker({ AGENTROUTER_BASE_URL: upstream.baseUrl }, '/v1/models');
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'non_json_response');
    assert.equal(res.json.error.status, 502);
    assert.match(res.contentType, /application\/json/);
  } finally {
    await upstream.close();
  }
});

test('worker: timeout returns 504 upstream_timeout', async () => {
  const upstream = await startUpstream(() => { /* never responds */ });
  try {
    const res = await callWorker({ AGENTROUTER_BASE_URL: upstream.baseUrl, AGENTROUTER_TIMEOUT_MS: '250' }, '/v1/models');
    assert.equal(res.status, 504);
    assert.equal(res.json.error.code, 'upstream_timeout');
  } finally {
    await upstream.close();
  }
});

test('worker: /v1/chat/completions streams SSE through unbuffered', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const res = await callWorker({ AGENTROUTER_BASE_URL: upstream.baseUrl }, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'glm-4.6', stream: true, messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/event-stream/);
    assert.match(res.text, /\[DONE\]/);
  } finally {
    await upstream.close();
  }
});

test('worker: /api/models without a configured key returns a clear 503 config error', async () => {
  const res = await callWorker({}, '/api/models', { key: null });
  assert.equal(res.status, 503);
  assert.equal(res.json.error.code, 'models_key_not_configured');
  assert.equal(res.json.error.type, 'configuration_error');
});

test('worker: /api/models uses the server-side key from env (never a committed key)', async () => {
  let seenAuth;
  const upstream = await startUpstream((req, res) => {
    seenAuth = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'glm-4.6' }] }));
  });
  try {
    const res = await callWorker(
      { AGENTROUTER_BASE_URL: upstream.baseUrl, AGENTROUTER_MODELS_API_KEY: 'server-side-key-not-real' },
      '/api/models',
      { key: null },
    );
    assert.equal(res.status, 200);
    assert.equal(seenAuth, 'Bearer server-side-key-not-real');
  } finally {
    await upstream.close();
  }
});

test('worker: missing API key returns 401', async () => {
  const res = await callWorker({}, '/v1/models', { key: null });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.type, 'invalid_request_error');
});
