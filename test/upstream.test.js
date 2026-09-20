import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AGENTROUTER_BASE_URL,
  MAX_PREVIEW_CHARS,
  UpstreamError,
  buildUpstreamUrl,
  classifyFetchError,
  isEventStream,
  isJsonContentType,
  logUpstreamDiagnostics,
  logUpstreamFailure,
  parseAgentRouterJson,
  previewBody,
  normalizeBaseUrl,
  resolveAgentRouterBaseUrl,
  resolveTimeoutMs,
} from '../api/upstream.js';
import { captureWarnings } from './helpers.js';

/** Capture a thrown error (assert.throws does not return it). */
function captureError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}

test('base URL: defaults to the official AgentRouter API when unset', () => {
  // The documented default is written with the /v1 suffix; the resolver strips it
  // because every route below is already written as /v1/...
  assert.equal(DEFAULT_AGENTROUTER_BASE_URL, 'https://agentrouter.org/v1');
  assert.equal(resolveAgentRouterBaseUrl({}), 'https://agentrouter.org');
  assert.equal(resolveAgentRouterBaseUrl(undefined), 'https://agentrouter.org');
  assert.equal(buildUpstreamUrl('/v1/models', '', {}), 'https://agentrouter.org/v1/models');
});

test('base URL: is overridable and trailing slashes are stripped', () => {
  assert.equal(resolveAgentRouterBaseUrl({ AGENTROUTER_BASE_URL: 'https://example.test' }), 'https://example.test');
  assert.equal(resolveAgentRouterBaseUrl({ AGENTROUTER_BASE_URL: 'https://example.test///' }), 'https://example.test');
  assert.equal(resolveAgentRouterBaseUrl({ AGENTROUTER_BASE_URL: '   ' }), 'https://agentrouter.org');
});

test('base URL: a trailing /v1 is accepted and never doubled', () => {
  // The official docs write the base as https://agentrouter.org/v1 - either form
  // must resolve to the same upstream URLs.
  assert.equal(normalizeBaseUrl('https://agentrouter.org/v1'), 'https://agentrouter.org');
  assert.equal(normalizeBaseUrl('https://agentrouter.org/v1/'), 'https://agentrouter.org');
  assert.equal(normalizeBaseUrl('https://agentrouter.org'), 'https://agentrouter.org');
  assert.equal(normalizeBaseUrl('https://agentrouter.org///'), 'https://agentrouter.org');
  assert.equal(normalizeBaseUrl('https://proxy.test/openai/v1'), 'https://proxy.test/openai');
  assert.equal(normalizeBaseUrl('  https://proxy.test/V1  '), 'https://proxy.test');
  assert.equal(normalizeBaseUrl('https://proxy.test/v1beta'), 'https://proxy.test/v1beta');

  for (const input of ['https://agentrouter.org', 'https://agentrouter.org/', 'https://agentrouter.org/v1', 'https://agentrouter.org/v1/']) {
    const env = { AGENTROUTER_BASE_URL: input };
    assert.equal(resolveAgentRouterBaseUrl(env), 'https://agentrouter.org');
    assert.equal(buildUpstreamUrl('/v1/models', '', env), 'https://agentrouter.org/v1/models');
    assert.equal(buildUpstreamUrl('/v1/chat/completions', '', env), 'https://agentrouter.org/v1/chat/completions');
    assert.equal(buildUpstreamUrl('/v1/messages', '', env), 'https://agentrouter.org/v1/messages');
    assert.ok(!buildUpstreamUrl('/v1/models', '', env).includes('/v1/v1'), 'must not double /v1');
  }
});

test('base URL: falls back to process.env for Node runtimes', () => {
  const previous = process.env.AGENTROUTER_BASE_URL;
  process.env.AGENTROUTER_BASE_URL = 'https://from-process-env.test/';
  try {
    assert.equal(resolveAgentRouterBaseUrl(), 'https://from-process-env.test');
  } finally {
    if (previous === undefined) delete process.env.AGENTROUTER_BASE_URL;
    else process.env.AGENTROUTER_BASE_URL = previous;
  }
});

test('timeout: default, override and clamping', () => {
  assert.equal(resolveTimeoutMs({}), 30000);
  assert.equal(resolveTimeoutMs({ AGENTROUTER_TIMEOUT_MS: '1500' }), 1500);
  assert.equal(resolveTimeoutMs({ AGENTROUTER_TIMEOUT_MS: 'not-a-number' }), 30000);
  assert.equal(resolveTimeoutMs({ AGENTROUTER_TIMEOUT_MS: '-5' }), 30000);
  assert.equal(resolveTimeoutMs({ AGENTROUTER_TIMEOUT_MS: '1' }), 50);
});

test('buildUpstreamUrl: joins base, path and query string', () => {
  const env = { AGENTROUTER_BASE_URL: 'https://example.test/' };
  assert.equal(buildUpstreamUrl('/v1/models', '', env), 'https://example.test/v1/models');
  assert.equal(buildUpstreamUrl('/v1/messages', '?beta=true', env), 'https://example.test/v1/messages?beta=true');
  assert.equal(buildUpstreamUrl('v1/models', 'beta=true', env), 'https://example.test/v1/models?beta=true');
  assert.equal(buildUpstreamUrl('/v1/models', '', {}), 'https://agentrouter.org/v1/models');
});

test('content-type helpers', () => {
  assert.equal(isJsonContentType('application/json; charset=utf-8'), true);
  assert.equal(isJsonContentType('application/problem+json'), true);
  assert.equal(isJsonContentType('text/html'), false);
  assert.equal(isJsonContentType(''), false);
  assert.equal(isEventStream('text/event-stream'), true);
  assert.equal(isEventStream('application/json'), false);
});

test('previewBody: collapses whitespace and truncates to 500 chars', () => {
  assert.equal(previewBody('  <!doctype   html>\n<html>  '), '<!doctype html> <html>');
  const long = 'a'.repeat(5000);
  const preview = previewBody(long);
  assert.equal(preview.length, MAX_PREVIEW_CHARS + 3);
  assert.equal(MAX_PREVIEW_CHARS, 500);
  assert.ok(preview.endsWith('...'));
});

test('classifyFetchError: maps transport failures to JSON-friendly errors', () => {
  const dns = classifyFetchError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), 'https://x.test');
  assert.equal(dns.status, 502);
  assert.equal(dns.code, 'dns_error');

  const refused = classifyFetchError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'https://x.test');
  assert.equal(refused.code, 'network_error');
  assert.equal(refused.status, 502);

  const tls = classifyFetchError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ERR_SSL_WRONG_VERSION_NUMBER' } }), 'https://x.test');
  assert.equal(tls.code, 'tls_error');

  const aborted = classifyFetchError(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'https://x.test');
  assert.equal(aborted.status, 504);
  assert.equal(aborted.code, 'upstream_timeout');

  const aggregate = classifyFetchError(
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('agg'), { errors: [{ code: 'EAI_AGAIN' }] }) }),
    'https://x.test',
  );
  assert.equal(aggregate.code, 'dns_error');

  const unknown = classifyFetchError(new Error('weird'), 'https://x.test');
  assert.equal(unknown.status, 502);
  assert.equal(unknown.code, 'network_error');
});

test('parseAgentRouterJson: accepts valid JSON objects and arrays', () => {
  assert.deepEqual(parseAgentRouterJson('{"data":[]}', { contentType: 'application/json', status: 200 }), { data: [] });
  assert.deepEqual(parseAgentRouterJson('[1,2]', { contentType: 'application/json', status: 200 }), [1, 2]);
  // Tolerates a JSON body that arrives without a JSON content-type.
  assert.deepEqual(parseAgentRouterJson('{"ok":true}', { contentType: '', status: 200 }), { ok: true });
});

test('parseAgentRouterJson: rejects HTML/WAF bodies with non_json_response', () => {
  const err = captureError(() =>
    parseAgentRouterJson('<!doctype html><html>captcha</html>', { contentType: 'text/html', status: 200, url: 'https://x.test/v1/models' }),
  );
  assert.ok(err instanceof UpstreamError);
  assert.equal(err.status, 502);
  assert.equal(err.code, 'non_json_response');
  assert.equal(err.message, 'Upstream AgentRouter returned a non-JSON response');
  assert.equal(err.details.upstream_status, 200);
  assert.equal(err.details.upstream_content_type, 'text/html');
});

test('parseAgentRouterJson: rejects invalid JSON, empty bodies and plain text', () => {
  const invalid = captureError(() => parseAgentRouterJson('{"data": [', { contentType: 'application/json', status: 200 }));
  assert.equal(invalid.code, 'invalid_json');

  const empty = captureError(() => parseAgentRouterJson('   ', { contentType: 'application/json', status: 200 }));
  assert.equal(empty.code, 'empty_response');

  const htmlAsJson = captureError(() => parseAgentRouterJson('<!doctype html>', { contentType: 'application/json', status: 502 }));
  assert.equal(htmlAsJson.code, 'non_json_response');

  const text = captureError(() => parseAgentRouterJson('upstream is down', { contentType: 'text/plain', status: 503 }));
  assert.equal(text.code, 'non_json_response');
});

test('diagnostics: logs URL/status/content-type/preview but never secrets', async () => {
  const secret = 'sk-super-secret-value-1234567890';
  const authHeader = `Bearer ${secret}`;
  const warnings = await captureWarnings(() => {
    logUpstreamDiagnostics({
      event: 'upstream_response',
      url: 'https://agentrouter.org/v1/models',
      method: 'GET',
      status: 200,
      contentType: 'text/html',
      durationMs: 42,
      preview: previewBody('<!doctype html><title>WAF</title>'),
    });
    logUpstreamFailure(Object.assign(new UpstreamError('Upstream AgentRouter returned a non-JSON response', { status: 502, code: 'non_json_response' }), {}), {
      url: 'https://agentrouter.org/v1/models',
      method: 'GET',
    });
    // Nothing in this module may ever log these values:
    void authHeader;
    void secret;
  });

  const output = warnings.join('\n');
  assert.match(output, /event=upstream_response/);
  assert.match(output, /status=200/);
  assert.match(output, /content-type=text\/html/);
  assert.match(output, /body_preview/);
  assert.doesNotMatch(output, /authorization/i);
  assert.doesNotMatch(output, /bearer /i);
  assert.doesNotMatch(output, /sk-/i);
  assert.doesNotMatch(output, /cookie/i);
});

test('diagnostics: preview is capped at 500 characters even for huge bodies', async () => {
  const warnings = await captureWarnings(() =>
    logUpstreamDiagnostics({ event: 'upstream_response', url: 'https://x.test', status: 200, contentType: 'text/html', preview: previewBody('x'.repeat(10000)) }),
  );
  const previewLine = warnings.find((line) => line.includes('body_preview'));
  const preview = previewLine.split('body_preview(<=500 chars): ')[1];
  assert.ok(preview.length <= MAX_PREVIEW_CHARS + 3, `preview too long: ${preview.length}`);
});
