import {
  CLAUDE_CODE_HEADERS,
  buildProviderHeaders,
  collectBody,
  copySafeResponseHeaders,
  extractClientKey,
  forwardStream,
  sendError,
  setCorsHeaders,
} from './utils.js';
import {
  buildUpstreamUrl,
  fetchUpstream,
  isEventStream,
  logUpstreamDiagnostics,
  logUpstreamFailure,
  parseAgentRouterJson,
  previewBody,
  readResponseText,
  resolveTimeoutMs,
  UpstreamError,
} from './upstream.js';

function queryStringOf(url = '') {
  const index = url.indexOf('?');
  return index === -1 ? '' : url.slice(index + 1);
}

/**
 * Forward a request to AgentRouter with defensive response handling.
 *
 * Behaviour:
 *  - Streaming (text/event-stream) responses are piped through unbuffered.
 *  - JSON responses are validated before being handed to the client.
 *  - HTML / non-JSON / empty / invalid JSON bodies become a clean 502 JSON
 *    error instead of an uncaught SyntaxError.
 *  - 4xx/5xx JSON responses are passed through with their original status so
 *    OpenAI/Anthropic clients keep their expected error semantics.
 */
export async function proxyAgentRouter(req, res, options) {
  const {
    method = 'POST',
    upstreamPath,
    passQuery = false,
    extraHeaders = {},
    requireKey = true,
    env,
    label = upstreamPath,
  } = options;

  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.status(204);
    return res.end();
  }

  const clientKey = extractClientKey(req);
  if (requireKey && !clientKey) {
    return sendError(
      res, 401,
      'Missing API key. Provide your AgentRouter key via Authorization: Bearer <key> or x-api-key',
      'invalid_request_error', 'missing_api_key',
    );
  }

  const upstreamUrl = buildUpstreamUrl(upstreamPath, passQuery ? queryStringOf(req.url) : '', env);
  const timeoutMs = resolveTimeoutMs(env);

  let body = null;
  let headers;
  try {
    if (method === 'GET' || method === 'HEAD') {
      headers = { ...CLAUDE_CODE_HEADERS, 'authorization': `Bearer ${clientKey}` };
    } else {
      body = await collectBody(req);
      headers = buildProviderHeaders(clientKey, body);
    }
    Object.assign(headers, extraHeaders);
  } catch (err) {
    console.warn(`[agentrouter] request_body_read_failed: ${err?.message || err}`);
    return sendError(res, 400, 'Failed to read request body', 'invalid_request_error', 'invalid_body');
  }

  let upstream;
  let controller;
  let durationMs;
  try {
    ({ response: upstream, controller, durationMs } = await fetchUpstream(
      upstreamUrl,
      { method, headers, body: body && body.length > 0 ? body : undefined },
      { env, timeoutMs },
    ));
  } catch (err) {
    logUpstreamFailure(err, { url: upstreamUrl, method, event: 'upstream_unreachable' });
    return sendError(res, err.status, err.message, err.type, err.code, err.details);
  }

  const contentType = upstream.headers.get('content-type') || '';
  const baseDetails = {
    upstream_url: upstreamUrl,
    upstream_status: upstream.status,
    upstream_content_type: contentType || 'none',
  };

  if (upstream.redirected) {
    logUpstreamDiagnostics({
      event: 'upstream_redirect_followed',
      url: upstreamUrl,
      method,
      status: upstream.status,
      contentType,
      durationMs,
      note: `final_url=${upstream.url}`,
    });
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    const err = new UpstreamError('Upstream AgentRouter returned an unexpected redirect', {
      status: 502,
      code: 'unexpected_redirect',
      details: { ...baseDetails, upstream_location: upstream.headers.get('location') || 'none' },
    });
    logUpstreamFailure(err, { url: upstreamUrl, method, event: 'upstream_redirect' });
    return sendError(res, err.status, err.message, err.type, err.code, err.details);
  }

  if (isEventStream(contentType)) {
    logUpstreamDiagnostics({
      event: 'upstream_stream_open',
      url: upstreamUrl,
      method,
      status: upstream.status,
      contentType,
      durationMs,
      note: `${label} streaming`,
    });
    return forwardStream(upstream, res, { controller, timeoutMs });
  }

  let text;
  try {
    text = await readResponseText(upstream, timeoutMs, controller);
  } catch (err) {
    const failure = err instanceof UpstreamError ? err : new UpstreamError('Upstream AgentRouter response could not be read', {
      status: 502, code: 'network_error',
    });
    logUpstreamFailure(failure, { url: upstreamUrl, method, event: 'upstream_body_read_failed' });
    return sendError(res, failure.status, failure.message, failure.type, failure.code, { ...baseDetails, ...failure.details });
  }

  const preview = previewBody(text);
  logUpstreamDiagnostics({
    event: 'upstream_response',
    url: upstreamUrl,
    method,
    status: upstream.status,
    contentType,
    durationMs,
    preview,
  });

  try {
    parseAgentRouterJson(text, { url: upstreamUrl, status: upstream.status, contentType });
  } catch (err) {
    const failure = err instanceof UpstreamError ? err : new UpstreamError('Upstream AgentRouter returned an unexpected response', {
      status: 502, code: 'upstream_error',
    });
    logUpstreamFailure(failure, { url: upstreamUrl, method, event: 'upstream_invalid_payload' });
    return sendError(res, failure.status, failure.message, failure.type, failure.code, {
      ...baseDetails,
      ...failure.details,
      preview,
    });
  }

  res.status(upstream.status);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  copySafeResponseHeaders(upstream, res);
  return res.send(text);
}
