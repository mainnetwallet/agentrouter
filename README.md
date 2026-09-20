# AgentRouter Bridge

Public OpenAI + Anthropic compatible bridge for [AgentRouter](https://co.agentrouter.org/).

**Bring your own API key** — stateless bridge. Clients pass their own AgentRouter key in
`Authorization: Bearer <key>` (or `x-api-key`). No server-side key is required (see
[Environment variables](#environment-variables) for the one optional exception).

## Endpoints

| Path | Method | Format | Description |
|---|---|---|---|
| `/v1/chat/completions` | `POST` | OpenAI | Chat completions (streaming and non-streaming) |
| `/v1/messages` | `POST` | Anthropic | Messages API |
| `/v1/models` | `GET` | OpenAI | Model list |
| `/health` | `GET` | — | Health check |

All upstream calls share one hardened transport (`api/upstream.js`), so every endpoint gets the
same timeout, status/content-type handling and diagnostics.

## Environment variables

Every variable is optional. The defaults work out of the box.

| Variable | Default | Required | Description |
|---|---|---|---|
| `AGENTROUTER_BASE_URL` | `https://co.agentrouter.org` | No | Upstream AgentRouter API base URL. Defined in exactly one place (`api/upstream.js`). OpenAI-compatible routes append `/v1` (`https://co.agentrouter.org/v1/models`); the Anthropic route appends `/v1/messages`. Override this only if AgentRouter changes hosts. |
| `AGENTROUTER_TIMEOUT_MS` | `30000` | No | Upstream timeout in ms. Covers connection + response headers, and the body read for non-streaming responses. For streaming responses it is the idle timeout between chunks. |
| `PORT` | `3000` | No | Node/Render listen port. Render sets this automatically. |
| `AGENTROUTER_DEBUG_AUTH` | *(unset)* | No | Set to `1` to enable `GET /v1/debug/auth` (authentication diagnostics). Off by default; when off the route returns `404`. |
| `AGENTROUTER_MODELS_API_KEY` | *(unset)* | No | **Cloudflare Worker only.** Server-side key used to serve the public `/api/models` list on the landing page. If unset, `/api/models` returns a `503 models_key_not_configured` error. Never commit a real key. |

```bash
cp .env.example .env   # then edit if you need a non-default upstream
```

## Deploy to Render

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → **New +** → **Web Service**.
3. Connect GitHub and pick this repo.
4. Configure:
   - **Environment**: Node
   - **Build Command**: *(leave blank — no dependencies)*
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
   - **Instance Type**: Free
5. (Optional) Add `AGENTROUTER_BASE_URL` and/or `AGENTROUTER_TIMEOUT_MS` under
   **Environment → Environment Variables**. Do **not** put an AgentRouter API key here: keys are
   supplied per request by clients.
6. Click **Create Web Service**.

Render assigns a URL like `https://your-service.onrender.com`.

## Local development

```bash
npm start
# listens on PORT (default 3000)
```

```bash
npm test     # 43 tests: JSON/HTML/invalid/empty bodies, 401/403/404/429/500, DNS, network, timeout, streaming
npm run check  # node --check on every source file
```

## Usage

### OpenAI-compatible clients (including MiniiChat)

```
Base URL: https://your-service.onrender.com/v1
API Key:  YOUR_AGENTROUTER_KEY
```

### Claude Code

```bash
export ANTHROPIC_BASE_URL=https://your-service.onrender.com/
export ANTHROPIC_AUTH_TOKEN=YOUR_AGENTROUTER_KEY
export ANTHROPIC_MODEL="claude-opus-4-6"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5-20251001"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-6"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-6"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
unset ANTHROPIC_API_KEY
claude
```

### curl

```bash
curl https://your-service.onrender.com/health

curl https://your-service.onrender.com/v1/models \
  -H "Authorization: Bearer YOUR_AGENTROUTER_KEY"

curl https://your-service.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_AGENTROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"Hello!"}],"max_tokens":50,"stream":true}'

curl https://your-service.onrender.com/v1/messages \
  -H "Authorization: Bearer YOUR_AGENTROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"Hello!"}],"max_tokens":50}'
```

## Response handling contract

The bridge reads the upstream **status and `content-type` first**, then the body as text, and only
parses JSON when the body really is JSON.

- **Streaming** upstream responses (`text/event-stream`) are piped straight through, unbuffered.
  An idle timeout aborts a stalled stream.
- **Upstream JSON** responses are passed through with the upstream status — including `4xx`/`5xx`,
  so OpenAI/Anthropic error semantics are preserved (`401`, `403`, `404`, `429`, `500`, …).
- **Non-JSON, empty or malformed** upstream bodies become a clean `502` JSON error. The client
  never receives an HTML body and never sees `SyntaxError: Unexpected token '<'`.

Error envelope:

```json
{
  "error": {
    "message": "Upstream AgentRouter returned a non-JSON response",
    "type": "upstream_error",
    "code": "non_json_response",
    "status": 502,
    "upstream_url": "https://co.agentrouter.org/v1/models",
    "upstream_status": 200,
    "upstream_content_type": "text/html; charset=utf-8",
    "preview": "<!doctype html> ..."
  }
}
```

| `error.code` | HTTP | Meaning |
|---|---|---|
| `non_json_response` | 502 | Upstream returned HTML/plain text (typically a WAF/captcha or gateway error page). |
| `invalid_json` | 502 | Upstream claimed JSON but the body was malformed. |
| `empty_response` | 502 | Upstream returned an empty body. |
| `unexpected_redirect` | 502 | Upstream answered with a `3xx` instead of a payload. |
| `dns_error` | 502 | Upstream host could not be resolved. |
| `network_error` | 502 | Connection refused/reset, unreachable host, or other transport failure. |
| `tls_error` | 502 | TLS handshake failure. |
| `upstream_timeout` | 504 | Upstream did not answer within `AGENTROUTER_TIMEOUT_MS`. |
| `bad_gateway` | 502 | Last-resort handler guard (unexpected internal failure). |

Missing client key returns `401 invalid_request_error` without contacting upstream.

## Authentication model

The bridge is **stateless with respect to credentials**: there is no server-side AgentRouter key
in the Node/Render path. Every request must carry the caller's own key, which the bridge
normalises and forwards as:

```
Authorization: Bearer <AGENTROUTER_API_KEY>
```

Normalisation (so a mangled key is not a mysterious 401):

| Case | Behaviour |
|---|---|
| `Bearer   <key>  ` (extra whitespace) | trimmed, forwarded as `Bearer <key>` |
| `Bearer "<key>"` / `Bearer '<key>'` | wrapping quotes removed, forwarded as `Bearer <key>` |
| `Bearer Bearer <key>` | duplicated prefix collapsed to a single `Bearer <key>` |
| `Bearer` with no credential | `401 malformed_api_key`, upstream not contacted |
| key containing whitespace/control/non-ASCII chars | `401 malformed_api_key`, upstream not contacted (cannot be placed in a header) |
| `x-api-key: <key>` | forwarded as `Authorization: Bearer <key>` |

The key value is never modified beyond that, never logged, and never stored.

### Which key is at fault?

Enable diagnostics temporarily (Render → Environment → `AGENTROUTER_DEBUG_AUTH=1`), then:

```bash
curl -s "https://your-service.onrender.com/v1/debug/auth" \
  -H "Authorization: Bearer YOUR_AGENTROUTER_KEY"
```

The report performs the A/B comparison for you and contains **no key material** — only
`key_present`, `key_length`, `key_first3`, `key_last3`, a non-reversible `key_fingerprint`,
`key_source`, `key_issues`, and whether the Authorization header was constructed:

```jsonc
{
  "authorization_scheme": "Bearer",
  "authorization_header_constructed": true,
  "request_key": { "key_present": true, "key_length": 45, "key_first3": "sk-", "key_last3": "xyz",
                   "key_fingerprint": "1a2b3c4d", "key_source": "authorization", "key_issues": [] },
  "env_keys_configured": [],
  "probe_a_direct_upstream_with_same_key": { "status": 401, "content_type": "application/json",
                                             "body_preview": "{\"code\":401,\"msg\":\"Invalid API Key!\"}" },
  "diagnosis": "The upstream API rejected the key sent by the client..."
}
```

Interpretation:

- `probe_a...status: 200` and `/v1/models` also working → all good.
- `probe_a...status: 401` → the key itself (or the account's access to `/v1/models`) is the problem;
  the bridge is irrelevant.
- `probe_a...status: 200` but `/v1/models` returns 401 → the bridge is mangling auth (report it).
- `request_key.key_issues` non-empty → the client is sending a mangled key (whitespace, quotes,
  duplicate `Bearer`); the bridge normalises it, so compare `key_fingerprint` with your known-good key.
- `key_fingerprint` differs from the key you configured → MiniiChat is sending a **different key**.

`probe_env_key` only runs when the caller's key fingerprint matches a configured server-side key,
so the endpoint cannot be used as a free proxy for a server key. Turn `AGENTROUTER_DEBUG_AUTH` off
again when you are done.

To compare against the upstream directly without the bridge:

```bash
curl -i "https://co.agentrouter.org/v1/models" -H "Authorization: Bearer YOUR_AGENTROUTER_KEY"
```

### Diagnostics

An upstream `401`/`403` logs a single line with key metadata only:

```
[agentrouter] event=auth_diagnostic method=GET url=https://co.agentrouter.org/v1/models upstream_status=401 \
  key_source=authorization key_present=true key_length=45 key_first3=sk- key_last3=xyz \
  key_fingerprint=1a2b3c4d key_issues=none authorization_header_constructed=true \
  authorization_scheme=Bearer authorization_header_value=<redacted>
```

Upstream body previews are scrubbed of the key before being logged or returned, in case the
upstream echoes the credential back in an error message.

## Diagnosing an upstream non-JSON response

A `502 non_json_response` means the bridge worked and **AgentRouter** returned a non-JSON body.
The goal is to surface that failure, not hide it.

1. **Read the error body.** `upstream_status` shows what AgentRouter answered; `preview` shows the
   first 500 characters of the body. An HTML `<!doctype html>` body with `upstream_status: 200` is
   a WAF/captcha or interstitial page, not an API response.
2. **Check the logs.** Every upstream call logs one line, and failures log a second:
   ```
   [agentrouter] event=upstream_response method=GET url=https://co.agentrouter.org/v1/models status=200 content-type=text/html duration_ms=214
   [agentrouter] body_preview(<=500 chars): <!doctype html><html>...
   ```
   Logs contain **only** URL, method, status, content-type, duration and a 500-character body
   preview. API keys, `Authorization` headers, cookies and request bodies are never logged.
3. **Reproduce upstream directly** (bypassing the bridge) with your own key:
   ```bash
   curl -i "$AGENTROUTER_BASE_URL/v1/models" -H "Authorization: Bearer YOUR_KEY"
   ```
   If that also returns HTML, the problem is upstream-side (provider outage, WAF/IP blocking,
   expired key, changed host) — not the bridge.
4. **Confirm the configured host.** The start-up log prints
   `[agentrouter] upstream_base_url=...`. Set `AGENTROUTER_BASE_URL` if it is wrong.
5. **Slow or hanging requests.** Raise/lower `AGENTROUTER_TIMEOUT_MS`. A `504 upstream_timeout`
   means upstream never answered within that budget.

## Project layout

```
server.js           # Node HTTP server (Render entry point)
api/
├── upstream.js     # Upstream URL resolution, timeout, JSON validation, safe diagnostics
├── proxy.js        # Single hardened proxy used by every HTTP endpoint
├── utils.js        # Headers, CORS, body collection, JSON error envelope, SSE piping
├── chat.js         # Legacy Vercel handler (Render uses server.js)
├── messages.js     # Legacy Vercel handler
└── models.js       # Legacy Vercel handler
worker.js           # Cloudflare Worker implementation (imports api/upstream.js)
test/               # node:test suites
```

The upstream base URL default lives in `api/upstream.js` only. `server.js`, the `api/*` handlers
and `worker.js` all resolve it at request time from `AGENTROUTER_BASE_URL`.

## Security notes

- No API keys are stored or committed. Clients send their own key per request.
- The bridge does not log secrets: no `Authorization` headers, cookies, keys or request bodies.
- Rotate any AgentRouter key that has ever been committed to this repository or shared in plain text.

## Files

See [Project layout](#project-layout).

## License

MIT
