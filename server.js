import http from 'http';
import { pathToFileURL } from 'url';
import { proxyAgentRouter, resolveRequestKey } from './api/proxy.js';
import { handleAuthDiagnostics, isAuthDebugEnabled } from './api/diagnostics.js';
import { resolveAgentRouterBaseUrl } from './api/upstream.js';
import { sendError } from './api/utils.js';

export const PORT = process.env.PORT || 3000;

/** Minimal express-like helpers on top of the raw Node response. */
function wrapRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (data) => { res.end(data); return res; };
  Object.defineProperty(res, 'headersSent', {
    get() { return res._header !== null && res._header !== undefined; },
    configurable: true,
  });
  return res;
}

export async function handleRequest(req, res) {
  wrapRes(res);
  const path = req.url.split('?')[0];

  try {
    if (path === '/v1/chat/completions') {
      // Streaming is preserved: SSE upstream responses are piped unbuffered.
      return await proxyAgentRouter(req, res, {
        method: 'POST',
        upstreamPath: '/v1/chat/completions',
        label: 'chat.completions',
      });
    }

    if (path === '/v1/messages') {
      // Anthropic-compatible endpoint; query string is forwarded upstream.
      return await proxyAgentRouter(req, res, {
        method: 'POST',
        upstreamPath: '/v1/messages',
        passQuery: true,
        label: 'messages',
      });
    }

    if (path === '/v1/models') {
      return await proxyAgentRouter(req, res, {
        method: 'GET',
        upstreamPath: '/v1/models',
        extraHeaders: { accept: 'application/json' },
        label: 'models',
      });
    }

    // Opt-in auth diagnostics (AGENTROUTER_DEBUG_AUTH=1). Returns key metadata
    // only - never the key. Disabled by default, in which case this 404s.
    if (path === '/v1/debug/auth' || path === '/debug/auth') {
      if (!isAuthDebugEnabled(process.env)) {
        return res.status(404).json({ error: { message: 'Not found', type: 'not_found', status: 404 } });
      }
      const resolved = resolveRequestKey(req);
      if (!resolved.extracted) {
        return sendError(res, 401, 'Missing API key. Provide your AgentRouter key via Authorization: Bearer <key> or x-api-key', 'invalid_request_error', 'missing_api_key');
      }
      return await handleAuthDiagnostics(req, res, {
        key: resolved.key,
        source: resolved.source,
        issues: resolved.issues,
        env: process.env,
        endpoint: '/v1/models',
      });
    }

    if (path === '/' || path === '/health') {
      return res.status(200).json({ ok: true, service: 'agentrouter-bridge' });
    }

    return res.status(404).json({ error: { message: 'Not found', type: 'not_found', status: 404 } });
  } catch (err) {
    // Last-resort guard: never leak a stack trace or an unhandled SyntaxError.
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[agentrouter] unhandled_handler_error: ${message}`);
    return sendError(res, 502, 'Bad Gateway - AgentRouter request failed', 'upstream_error', 'bad_gateway');
  }
}

export const server = http.createServer(handleRequest);

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  server.listen(PORT, () => {
    console.log(`AgentRouter bridge listening on port ${PORT}`);
    console.log(`[agentrouter] upstream_base_url=${resolveAgentRouterBaseUrl(process.env)}`);
    console.log(`[agentrouter] auth_model=client_supplied_key debug_auth=${isAuthDebugEnabled(process.env) ? 'enabled' : 'disabled'}`);
  });
}
