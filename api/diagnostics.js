/**
 * Authentication diagnostics for the AgentRouter bridge.
 *
 * Answers "is the key MiniiChat sends the same key that works directly against
 * the upstream API?" WITHOUT ever revealing the key: only presence, length,
 * first/last 3 characters and a non-reversible fingerprint are reported, and
 * every upstream body preview is scrubbed of the key before it is returned.
 *
 * Disabled unless AGENTROUTER_DEBUG_AUTH=1. When disabled the route is a 404,
 * so it is indistinguishable from any other unknown path.
 */

import {
  describeApiKey,
  fetchUpstream,
  hasUnsafeKeyChars,
  normalizeApiKey,
  previewBody,
  readResponseText,
  resolveTimeoutMs,
  resolveAgentRouterBaseUrl,
  scrubSecret,
} from './upstream.js';
import { sendError, setCorsHeaders } from './utils.js';

/**
 * Environment variables that could plausibly hold an AgentRouter key.
 * Only the NAMES and non-secret metadata of the ones that are set are reported.
 */
export const CANDIDATE_KEY_ENV_VARS = [
  'AGENTROUTER_API_KEY',
  'AGENTROUTER_KEY',
  'AGENTROUTER_TOKEN',
  'AGENTROUTER_SECRET',
  'AGENTROUTER_MODELS_API_KEY',
  'PUBLIC_MODELS_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
];

/**
 * Known AgentRouter API hosts. The published docs use agentrouter.org, while
 * co.agentrouter.org serves the same API surface; behaviour differs per host and
 * per network, so the diagnostic probes both (and the configured base URL).
 * This is a fixed allow-list - the endpoint never fetches an arbitrary URL.
 */
export const PROBE_HOSTS = [
  { name: 'agentrouter.org', base_url: 'https://agentrouter.org', documented: true },
  { name: 'co.agentrouter.org', base_url: 'https://co.agentrouter.org', documented: false },
];

function hostKeyFor(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

export function isAuthDebugEnabled(env) {
  const raw = env?.AGENTROUTER_DEBUG_AUTH ?? (typeof process !== 'undefined' ? process.env?.AGENTROUTER_DEBUG_AUTH : undefined);
  return ['1', 'true', 'yes', 'on'].includes(String(raw || '').trim().toLowerCase());
}

/**
 * Call the upstream models endpoint with a given key.
 * Returns status/content-type/preview only - never the key.
 */
export async function probeUpstreamModels(key, env, { method = 'GET', baseUrl } = {}) {
  const base = (baseUrl || resolveAgentRouterBaseUrl(env)).replace(/\/+$/, '');
  const upstreamUrl = `${base}/v1/models`;
  const timeoutMs = resolveTimeoutMs(env);
  const fingerprint = describeApiKey(key).key_fingerprint;

  try {
    const { response, controller, durationMs } = await fetchUpstream(
      upstreamUrl,
      { method, headers: { authorization: `Bearer ${key}`, accept: 'application/json' } },
      { env, timeoutMs },
    );
    const text = await readResponseText(response, timeoutMs, controller);
    return {
      upstream_url: upstreamUrl,
      key_fingerprint: fingerprint,
      status: response.status,
      content_type: response.headers.get('content-type') || 'none',
      duration_ms: durationMs,
      body_preview: scrubSecret(previewBody(text), key),
    };
  } catch (err) {
    return {
      upstream_url: upstreamUrl,
      key_fingerprint: fingerprint,
      status: null,
      error_code: err?.code || 'upstream_error',
      error_message: scrubSecret(String(err?.message || err), key),
    };
  }
}

/** List configured key-like env vars, reporting metadata only. */
export function describeKeyEnvVars(env) {
  const source = env && typeof env === 'object' ? env : (typeof process !== 'undefined' ? process.env : {});
  return CANDIDATE_KEY_ENV_VARS
    .filter((name) => typeof source?.[name] === 'string' && source[name].trim().length > 0)
    .map((name) => ({
      name,
      configured: true,
      ...describeApiKey(normalizeApiKey(source[name]).key),
    }));
}

/** agentrouter.org currently answers every request with this client check. */
export function isClientVerificationWall(bodyPreview) {
  if (typeof bodyPreview !== 'string') return false;
  return /unauthorized client detected|UNAUTHENTICATED/i.test(bodyPreview);
}

function diagnose({ callerProbe, envProbe, requestKey, envKeys, probesByHost = {} }) {
  const workingHosts = Object.values(probesByHost).filter((entry) => entry.status === 200);
  const walledHosts = Object.values(probesByHost).filter((entry) => entry.client_verification_wall);
  const configured = Object.values(probesByHost).find((entry) => entry.configured);

  if (requestKey.key_present && callerProbe?.status === 200) {
    return 'The key sent by the client is accepted by the configured upstream API. Authentication through the bridge works.';
  }

  if (workingHosts.length > 0) {
    return `The same key is accepted by ${workingHosts.map((entry) => entry.name).join(', ')} but rejected by the configured host (${configured?.name}). Change AGENTROUTER_BASE_URL to a host that accepts the key.`;
  }

  if (configured?.client_verification_wall) {
    return 'The configured host (agentrouter.org) answered with a client-verification / "unauthorized client detected" wall that is independent of the API key, so no key can authenticate against it from this network. This is an upstream restriction; the bridge must not attempt to bypass it. Use a host that serves the API properly (see probes_by_host).';
  }

  if (walledHosts.length > 0) {
    return `Every host rejected the key. Note: ${walledHosts.map((entry) => entry.name).join(', ')} blocks the client before authentication ("unauthorized client detected"), which is an upstream restriction, not a key problem. The remaining host rejected the key itself.`;
  }
  if (callerProbe?.status === 401 || callerProbe?.status === 403) {
    if (envProbe?.status === 200) {
      return 'The configured environment key is accepted upstream but the key the client sends is rejected. The client (MiniiChat) is sending a different/invalid key.';
    }
    if (envKeys.length === 0) {
      return 'The upstream API rejected the key sent by the client, and no server-side key is configured on the bridge (by design: clients supply their own key). Test the same key directly with curl to confirm it is invalid or not authorised for /v1/models.';
    }
    return 'The upstream API rejected every key tested. The key itself (or the account/endpoint authorisation) is the problem, not the bridge.';
  }
  if (callerProbe?.status === null) {
    return `The bridge could not reach the upstream API (${callerProbe?.error_code}). This is a connectivity problem, not an authentication problem.`;
  }
  return 'See probe results below.';
}

/**
 * Build the diagnostic report. `key` is the key extracted from the caller's
 * request; it is never included in the report.
 */
export async function buildAuthReport({ key, source, issues = [], env, endpoint }) {
  const envKeys = describeKeyEnvVars(env);
  const requestKey = {
    ...describeApiKey(key),
    key_source: source || 'none',
    key_issues: issues.length ? issues : [],
    key_has_unsafe_characters: hasUnsafeKeyChars(key),
  };

  const probeCallerKey = await probeUpstreamModels(key, env, { method: 'GET' });

  // Compare the configured host against the known hosts with the same key.
  const configuredBase = resolveAgentRouterBaseUrl(env);
  const candidates = new Map();
  const configuredOrigin = hostKeyFor(configuredBase);
  candidates.set(configuredOrigin, { name: configuredOrigin.replace(/^https?:\/\//, ''), base_url: configuredBase, configured: true });
  for (const host of PROBE_HOSTS) {
    const origin = hostKeyFor(host.base_url);
    const existing = candidates.get(origin);
    if (existing) {
      if (existing.configured) continue; // never clobber the configured entry
      candidates.set(origin, host);
    } else {
      candidates.set(origin, host);
    }
  }

  const probesByHost = {};
  for (const [origin, host] of candidates) {
    const result = origin === configuredOrigin
      ? probeCallerKey
      : await probeUpstreamModels(key, env, { method: 'GET', baseUrl: host.base_url });
    probesByHost[origin] = {
      name: host.name,
      configured: Boolean(host.configured),
      documented_in_docs: Boolean(host.documented),
      status: result.status,
      content_type: result.content_type ?? 'none',
      error_code: result.error_code ?? null,
      client_verification_wall: isClientVerificationWall(result.body_preview),
      body_preview: result.body_preview ?? result.error_message ?? null,
    };
  }

  // Only probe with a server-side key when the caller demonstrably holds that
  // same key, so the endpoint cannot be used as a free proxy for the server key.
  let probeEnvKey;
  const matchingEnvKey = envKeys.find((entry) => entry.key_fingerprint === requestKey.key_fingerprint);
  if (envKeys.length === 0) {
    probeEnvKey = { skipped: 'no_key_configured_in_environment' };
  } else if (!matchingEnvKey) {
    probeEnvKey = {
      skipped: 'caller_key_does_not_match_configured_env_key',
      configured_env_key_names: envKeys.map((entry) => entry.name),
      configured_env_key_fingerprints: envKeys.map((entry) => entry.key_fingerprint),
    };
  } else {
    const envName = matchingEnvKey.name;
    const rawEnvKey = (env && typeof env === 'object' ? env : process.env)[envName];
    probeEnvKey = { env_var_name: envName, ...(await probeUpstreamModels(normalizeApiKey(rawEnvKey).key, env, { method: 'GET' })) };
  }

  return {
    service: 'agentrouter-bridge',
    endpoint: endpoint || '/v1/models',
    upstream_base_url: resolveAgentRouterBaseUrl(env),
    authorization_header_constructed: true,
    authorization_scheme: 'Bearer',
    authorization_header_value: '<redacted>',
    request_key: requestKey,
    env_keys_configured: envKeys,
    probe_a_direct_upstream_with_same_key: probeCallerKey,
    probes_by_host: probesByHost,
    probe_env_key: probeEnvKey,
    diagnosis: diagnose({ callerProbe: probeCallerKey, envProbe: probeEnvKey.status ? probeEnvKey : undefined, requestKey, envKeys }),
    host_comparison: Object.values(probesByHost).map((entry) => ({
      host: entry.name,
      configured: entry.configured,
      documented_in_docs: entry.documented_in_docs,
      status: entry.status,
      client_verification_wall: entry.client_verification_wall,
    })),
    notes: [
      'agentrouter.org answers "unauthorized client detected" regardless of the API key (client verification); co.agentrouter.org performs normal key authentication.',
      'The bridge does not modify the key value: it normalises whitespace/quotes/duplicate Bearer prefixes and forwards "Authorization: Bearer <key>".',
      'No key is logged or returned: only presence, length, first/last 3 characters and a fingerprint.',
    ],
  };
}

/** GET /v1/debug/auth - enabled only when AGENTROUTER_DEBUG_AUTH=1. */
export async function handleAuthDiagnostics(req, res, { key, source, issues, env, endpoint }) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.status(204);
    return res.end();
  }
  if (!isAuthDebugEnabled(env)) {
    return sendError(res, 404, 'Not found', 'not_found', 'not_found');
  }
  try {
    const report = await buildAuthReport({ key, source, issues, env, endpoint });
    return res.status(200).json(report);
  } catch (err) {
    console.warn(`[agentrouter] auth_diagnostics_failed: ${err?.message || err}`);
    return sendError(res, 502, 'Failed to build auth diagnostics', 'upstream_error', 'diagnostics_failed');
  }
}
