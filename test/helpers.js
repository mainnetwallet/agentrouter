import http from 'http';

/** Start a throwaway HTTP server on a random port; returns helpers to close it. */
export async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Start a mock "upstream AgentRouter" with a request handler. */
export function startUpstream(handler) {
  return listen(http.createServer(handler));
}

/** Bind a port and immediately release it, to produce a connection-refused target. */
export async function findClosedPort() {
  const { port, close } = await listen(http.createServer((_req, res) => res.end()));
  await close();
  return port;
}

/** Temporarily set process.env values (used to point the bridge at a mock upstream). */
export async function withEnv(vars, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, Object.keys(process.env).includes(key) ? process.env[key] : undefined);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Capture console.warn output produced while `fn` runs. */
export async function captureWarnings(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines;
}
