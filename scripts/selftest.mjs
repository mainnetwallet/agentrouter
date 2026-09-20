#!/usr/bin/env node
/**
 * AgentRouter end-to-end self test.
 *
 *   AGENTROUTER_KEY='<your key>' node scripts/selftest.mjs [bridgeBaseUrl] [--model <id>]
 *
 * - A: calls the upstream AgentRouter API directly, once per known host.
 * - B: calls the same endpoints through the deployed bridge.
 *
 * The key is read from the environment only (never from argv, so it does not end
 * up in shell history or in `ps`), and it is scrubbed from every line printed.
 */

import {
  describeApiKey,
  fetchUpstream,
  normalizeApiKey,
  previewBody,
  readResponseText,
  resolveTimeoutMs,
  scrubSecret,
} from '../api/upstream.js';
import { PROBE_HOSTS } from '../api/diagnostics.js';

const args = process.argv.slice(2);
const modelFlag = args.indexOf('--model');
const model = modelFlag === -1 ? 'glm-5.3' : args[modelFlag + 1];
const positional = args.filter((arg, i) => !arg.startsWith('--') && i !== modelFlag + 1);
const bridgeBase = (positional[0] || '').replace(/\/+$/, '');

const raw = process.env.AGENTROUTER_KEY || process.env.AGENTROUTER_API_KEY || '';
const { key, issues } = normalizeApiKey(raw);

const label = (text) => `\n=== ${text} ===`;

function reportLine(name, result) {
  const status = result.status === null ? `ERROR(${result.error_code})` : result.status;
  console.log(`  ${name.padEnd(28)} ${String(status).padEnd(10)} ${result.content_type || ''}`);
  if (result.body_preview) console.log(`      ${result.body_preview}`);
  if (result.error_message) console.log(`      ${result.error_message}`);
}

async function callUpstream(baseUrl, path, init) {
  try {
    const { response, controller, durationMs } = await fetchUpstream(
      `${baseUrl}${path}`,
      { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${key}` } },
      { timeoutMs: resolveTimeoutMs(process.env) },
    );
    const text = await readResponseText(response, resolveTimeoutMs(process.env), controller);
    return {
      status: response.status,
      content_type: response.headers.get('content-type') || 'none',
      duration_ms: durationMs,
      body_preview: scrubSecret(previewBody(text), key),
    };
  } catch (err) {
    return { status: null, content_type: 'none', error_code: err?.code || 'error', error_message: scrubSecret(String(err?.message || err), key) };
  }
}

async function callBridge(path, init) {
  try {
    const res = await fetch(`${bridgeBase}${path}`, {
      ...init,
      headers: { ...(init.headers || {}), authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(resolveTimeoutMs(process.env)),
    });
    const text = await res.text();
    return {
      status: res.status,
      content_type: res.headers.get('content-type') || 'none',
      body_preview: scrubSecret(previewBody(text), key),
    };
  } catch (err) {
    return { status: null, content_type: 'none', error_code: err?.name || 'error', error_message: scrubSecret(String(err?.message || err), key) };
  }
}

console.log('AgentRouter self test');
console.log(`  key: present=${key.length > 0} length=${key.length} first3=${key.slice(0, 3) || 'none'} last3=${key.slice(-3) || 'none'} fingerprint=${describeApiKey(key).key_fingerprint || 'none'}`);
if (issues.length) console.log(`  key issues (fixed automatically): ${issues.join(', ')}`);
if (!key) {
  console.error('\nNo key supplied. Set AGENTROUTER_KEY (or AGENTROUTER_API_KEY) in the environment.');
  process.exit(2);
}
if (bridgeBase) console.log(`  bridge: ${bridgeBase}`);
console.log(`  model:  ${model}`);

const directResults = [];
console.log(label('A) Direct upstream'));
for (const host of PROBE_HOSTS) {
  process.stdout.write(`\n[${host.name}]\n`);
  const models = await callUpstream(host.base_url, '/v1/models', { method: 'GET' });
  reportLine('GET /v1/models', models);
  const chat = await callUpstream(host.base_url, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
  });
  reportLine('POST /v1/chat/completions', chat);
  directResults.push({ host: host.name, models: models.status, chat: chat.status, wall: /unauthorized client detected|UNAUTHENTICATED/i.test(models.body_preview || '') });
}

let bridgeResult = null;
if (bridgeBase) {
  console.log(label('B) Through the bridge'));
  const models = await callBridge('/v1/models', { method: 'GET' });
  reportLine('GET /v1/models', models);
  const chat = await callBridge('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
  });
  reportLine('POST /v1/chat/completions', chat);
  bridgeResult = models;
}

console.log(label('Verdict'));
const working = directResults.filter((r) => r.models === 200);
const walled = directResults.filter((r) => r.wall);

if (working.length > 0) {
  console.log(`  Key is VALID on: ${working.map((r) => r.host).join(', ')}`);
  console.log(`  -> Set AGENTROUTER_BASE_URL to one of those hosts (without /v1).`);
} else {
  console.log('  Key was rejected by every host tested: the key (or its access to these endpoints) is the problem.');
}
for (const r of walled) {
  console.log(`  ${r.host} is behind a client-verification wall (rejects before authentication) - not a key problem, and the bridge must not bypass it.`);
}
if (bridgeResult) {
  console.log(`  Bridge returned ${bridgeResult.status} for GET /v1/models.`);
  if (bridgeResult.status === 200 && working.length === 0) {
    console.log('  Bridge succeeded where the direct probes did not - unexpected, please report this.');
  }
  if (bridgeResult.status !== 200 && working.length > 0) {
    console.log('  Bridge failed while a direct call with the same key succeeded - the bridge is mangling auth; report this.');
  }
}
process.exit(working.length > 0 ? 0 : 1);
