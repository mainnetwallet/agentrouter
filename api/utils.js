import { DEFAULT_TIMEOUT_MS, MAX_PREVIEW_CHARS } from './upstream.js';

/**
 * Claude Code client headers.
 *
 * NOTE: these are pre-existing behaviour of this bridge and are forwarded
 * unchanged. They are deliberately not extended here - this module only makes
 * the bridge's error handling and configuration safe.
 */
export const CLAUDE_CODE_HEADERS = {
  'user-agent': 'claude-cli/2.1.114 (external, cli)',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,effort-2025-11-24',
  'anthropic-dangerous-direct-browser-access': 'true',
  'x-app': 'cli',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'Linux',
  'x-stainless-arch': 'x64',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v24.3.0',
  'x-stainless-package-version': '0.81.0',
};

/** Headers safe to copy back from upstream (never cookies or auth headers). */
const SAFE_UPSTREAM_HEADER_PREFIXES = ['x-ratelimit-', 'anthropic-ratelimit-'];
const SAFE_UPSTREAM_HEADERS = ['retry-after', 'request-id', 'x-request-id', 'openai-processing-ms', 'anthropic-version'];

export function collectBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve(null);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta');
}

export function extractClientKey(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.substring(7);
  if (req.headers['x-api-key']) return req.headers['x-api-key'];
  return null;
}

export function buildProviderHeaders(clientApiKey, bodyBuffer) {
  const headers = {
    ...CLAUDE_CODE_HEADERS,
    'authorization': `Bearer ${clientApiKey}`,
    'content-type': 'application/json',
  };
  if (bodyBuffer && bodyBuffer.length > 0) {
    headers['content-length'] = bodyBuffer.length;
  }
  return headers;
}

export function copySafeResponseHeaders(upstreamResponse, res) {
  for (const [key, value] of upstreamResponse.headers.entries()) {
    const lower = key.toLowerCase();
    const allowed = SAFE_UPSTREAM_HEADERS.includes(lower)
      || SAFE_UPSTREAM_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
    if (allowed) res.setHeader(key, value);
  }
}

/**
 * Send a JSON error envelope. Never includes credentials or request bodies.
 * `extra` may carry non-sensitive upstream diagnostics (URL/status/content-type).
 */
export function sendError(res, status, message, type, code, extra) {
  if (res.headersSent) return;
  const body = { error: { message, type: type || 'upstream_error', status } };
  if (code) body.error.code = code;
  if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null) body.error[key] = value;
    }
  }
  res.status(status).json(body);
}

/**
 * Pipe an upstream SSE / streaming response straight through.
 *
 * Streaming is never buffered: bytes are forwarded as they arrive. An idle
 * timeout aborts a stalled upstream so the request cannot hang forever.
 */
export async function forwardStream(upstreamResponse, res, { controller, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const contentType = upstreamResponse.headers.get('content-type') || 'text/event-stream';

  res.status(upstreamResponse.status);
  res.setHeader('content-type', contentType);
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  copySafeResponseHeaders(upstreamResponse, res);

  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  const reader = upstreamResponse.body.getReader();
  let idleTimer = null;
  let aborted = false;

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      aborted = true;
      try { controller?.abort(); } catch { /* already aborted */ }
    }, timeoutMs);
  };
  const onClientClose = () => {
    clearIdle();
    aborted = true;
    try { controller?.abort(); } catch { /* already aborted */ }
    try { reader.cancel(); } catch { /* stream already closed */ }
  };

  res.on?.('close', onClientClose);

  try {
    armIdle();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearIdle();
      res.write(value);
      armIdle();
    }
  } catch (err) {
    // Headers are already on the wire, so a JSON error envelope is impossible.
    // Surface the failure as an SSE error frame when the client speaks SSE.
    console.warn(`[agentrouter] stream_interrupted: ${err?.message || err}`);
    if (!res.writableEnded && contentType.includes('text/event-stream')) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({
          error: {
            message: 'Upstream AgentRouter stream interrupted',
            type: 'upstream_error',
            code: aborted ? 'upstream_timeout' : 'stream_interrupted',
            status: 502,
          },
        })}\n\n`);
      } catch { /* client already gone */ }
    }
  } finally {
    clearIdle();
    res.off?.('close', onClientClose);
    try { res.end(); } catch { /* already ended */ }
  }
}

export { MAX_PREVIEW_CHARS };
