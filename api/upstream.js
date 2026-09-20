/**
 * Shared upstream (AgentRouter) transport layer.
 *
 * Every module in this repo must use these helpers instead of calling `fetch`
 * against AgentRouter directly. The upstream base URL is configurable through
 * the AGENTROUTER_BASE_URL environment variable and is defined in exactly one
 * place (DEFAULT_AGENTROUTER_BASE_URL below).
 *
 * Design rules:
 *  - The default host is the documented API base:
 *      OpenAI-compatible: https://co.agentrouter.org/v1
 *      Anthropic:         https://co.agentrouter.org
 *  - Never log secrets: no Authorization headers, cookies, API keys or bodies.
 *  - Diagnostics are limited to URL, method, status, content-type, duration and
 *    a truncated (<= 500 char) upstream body preview.
 *  - The transport is runtime agnostic (Node >= 18 and Cloudflare Workers).
 */

export const DEFAULT_AGENTROUTER_BASE_URL = 'https://co.agentrouter.org';
export const DEFAULT_TIMEOUT_MS = 30000;
export const MIN_TIMEOUT_MS = 50;
export const MAX_PREVIEW_CHARS = 500;

/** Resolve a config value from an explicit env object (Workers) or process.env (Node). */
function envValue(name, env) {
  if (env && typeof env === 'object' && typeof env[name] === 'string' && env[name].trim()) {
    return env[name].trim();
  }
  if (typeof process !== 'undefined' && process.env && typeof process.env[name] === 'string' && process.env[name].trim()) {
    return process.env[name].trim();
  }
  return undefined;
}

/** Upstream base URL, without a trailing slash. */
export function resolveAgentRouterBaseUrl(env) {
  const raw = envValue('AGENTROUTER_BASE_URL', env) || DEFAULT_AGENTROUTER_BASE_URL;
  return raw.replace(/\/+$/, '');
}

/** Upstream request timeout in milliseconds (AGENTROUTER_TIMEOUT_MS). */
export function resolveTimeoutMs(env) {
  const raw = envValue('AGENTROUTER_TIMEOUT_MS', env);
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, parsed);
}

/** Build an absolute upstream URL for a path + optional query string. */
export function buildUpstreamUrl(path, search, env) {
  const base = resolveAgentRouterBaseUrl(env);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  let qs = typeof search === 'string' ? search.trim() : '';
  if (qs && !qs.startsWith('?')) qs = `?${qs}`;
  return `${base}${normalizedPath}${qs}`;
}

/** Error type used for every upstream failure so callers can respond consistently. */
export class UpstreamError extends Error {
  constructor(message, { status = 502, type = 'upstream_error', code = 'upstream_error', details = {}, cause } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

export function isJsonContentType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return type === 'application/json' || type === 'text/json' || type.endsWith('+json');
}

export function isEventStream(contentType) {
  return String(contentType || '').toLowerCase().includes('text/event-stream');
}

/** Collapse + truncate an upstream body for logging / diagnostics. */
export function previewBody(text, limit = MAX_PREVIEW_CHARS) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

function errorCodeOf(err) {
  const candidates = [
    err,
    err && err.cause,
    ...(err && err.cause && Array.isArray(err.cause.errors) ? err.cause.errors : []),
  ].filter(Boolean);

  // Real errno codes first; `name` is only a last resort so that a generic
  // TypeError wrapper never masks the underlying cause code.
  for (const candidate of candidates) {
    const code = candidate.code || candidate.errno;
    if (code) return String(code).toUpperCase();
  }
  for (const candidate of candidates) {
    if (candidate.name) return String(candidate.name).toUpperCase();
  }
  return '';
}

/** Map a thrown fetch/abort error to a client-safe UpstreamError. */
export function classifyFetchError(err, url) {
  const code = errorCodeOf(err);
  const details = { upstream_url: url };

  if (err && (err.name === 'AbortError' || err.name === 'TimeoutError') || code.includes('ABORT') || code.includes('TIMEOUT')) {
    return new UpstreamError('Upstream AgentRouter request timed out', {
      status: 504, code: 'upstream_timeout', details, cause: err,
    });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ERR_INVALID_URL') {
    return new UpstreamError('Could not reach upstream AgentRouter (DNS/resolution error)', {
      status: 502, code: 'dns_error', details, cause: err,
    });
  }
  if (/TLS|SSL|CERT|SELF_SIGNED|UNABLE_TO_VERIFY|WRONG_VERSION|HANDSHAKE/.test(code)) {
    return new UpstreamError('TLS handshake with upstream AgentRouter failed', {
      status: 502, code: 'tls_error', details, cause: err,
    });
  }
  if (/ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR|SOCKET|FETCH_FAILED/.test(code)) {
    return new UpstreamError('Network error while contacting upstream AgentRouter', {
      status: 502, code: 'network_error', details, cause: err,
    });
  }
  return new UpstreamError('Upstream AgentRouter request failed', {
    status: 502, code: 'network_error', details, cause: err,
  });
}

/**
 * Safe diagnostic log for an upstream exchange.
 * Only whitelisted, non-secret fields are ever printed.
 */
export function logUpstreamDiagnostics({ event, url, method, status, contentType, durationMs, preview, note }) {
  const fields = [
    `event=${event}`,
    method ? `method=${method}` : null,
    `url=${url}`,
    Number.isFinite(status) ? `status=${status}` : 'status=n/a',
    `content-type=${contentType || 'none'}`,
    Number.isFinite(durationMs) ? `duration_ms=${durationMs}` : null,
    note ? `note=${note}` : null,
  ].filter(Boolean);
  console.warn(`[agentrouter] ${fields.join(' ')}`);
  if (preview) {
    console.warn(`[agentrouter] body_preview(<=${MAX_PREVIEW_CHARS} chars): ${preview}`);
  }
}

/** Log an upstream failure without leaking credentials or request bodies. */
export function logUpstreamFailure(err, { url, method, event = 'upstream_error' }) {
  logUpstreamDiagnostics({
    event,
    url,
    method,
    status: err && Number.isFinite(err.status) ? err.status : undefined,
    contentType: 'none',
    note: `${(err && err.code) || 'unknown_error'}: ${(err && err.message) || 'unknown upstream failure'}`,
  });
}

/**
 * fetch() with an AbortController deadline covering connection + response headers.
 *
 * The timer is cleared as soon as headers arrive, so long-lived streaming
 * responses are never cut off by the connect timeout.
 */
export async function fetchUpstream(url, init = {}, { env, timeoutMs } = {}) {
  const effectiveTimeout = Number.isFinite(timeoutMs) ? timeoutMs : resolveTimeoutMs(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  const startedAt = Date.now();

  let response;
  try {
    response = await fetch(url, { redirect: 'follow', ...init, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw classifyFetchError(err, url);
  }
  clearTimeout(timer);

  return { response, controller, durationMs: Date.now() - startedAt, timeoutMs: effectiveTimeout };
}

/**
 * Read a response body as text with a deadline. Used for non-streaming bodies
 * only; streaming bodies are piped directly so they are not buffered.
 */
export async function readResponseText(response, timeoutMs = DEFAULT_TIMEOUT_MS, controller) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) {
        try { controller.abort(); } catch { /* already aborted */ }
      }
      reject(new UpstreamError('Upstream AgentRouter response body read timed out', {
        status: 504, code: 'upstream_timeout',
      }));
    }, timeoutMs);
  });

  try {
    return await Promise.race([response.text(), timeout]);
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw classifyFetchError(err, response.url);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate an upstream body before it is handed to the client.
 * Returns parsed JSON, or throws an UpstreamError with a diagnostic code.
 */
export function parseAgentRouterJson(text, { url, status, contentType } = {}) {
  const details = {
    upstream_url: url,
    upstream_status: status,
    upstream_content_type: contentType || 'none',
  };
  const trimmed = typeof text === 'string' ? text.trim() : '';

  if (!trimmed) {
    throw new UpstreamError('Upstream AgentRouter returned an empty response body', {
      status: 502, code: 'empty_response', details,
    });
  }

  const declaredJson = isJsonContentType(contentType);
  // Markup, plain text and gateway error pages never start like a JSON value,
  // even when upstream mislabels them as application/json.
  const looksLikeJson = /^[[{"]/.test(trimmed) || /^-?\d/.test(trimmed) || /^(true|false|null)\b/.test(trimmed);

  if (!looksLikeJson) {
    // WAF / captcha / HTML error page / plain-text gateway error.
    throw new UpstreamError('Upstream AgentRouter returned a non-JSON response', {
      status: 502, code: 'non_json_response', details,
    });
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    if (!declaredJson) {
      throw new UpstreamError('Upstream AgentRouter returned a non-JSON response', {
        status: 502, code: 'non_json_response', details,
      });
    }
    throw new UpstreamError('Upstream AgentRouter returned invalid JSON', {
      status: 502, code: 'invalid_json', details,
    });
  }
}

/** Build the OpenAI/Anthropic-compatible error envelope used across the bridge. */
export function upstreamErrorBody(err) {
  return {
    error: {
      message: err.message,
      type: err.type || 'upstream_error',
      code: err.code || 'upstream_error',
      status: err.status || 502,
      ...(err.details || {}),
    },
  };
}
