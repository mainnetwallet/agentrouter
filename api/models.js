import { proxyAgentRouter } from './proxy.js';

export default async function handler(req, res) {
  return proxyAgentRouter(req, res, {
    method: 'GET',
    upstreamPath: '/v1/models',
    extraHeaders: { accept: 'application/json' },
    label: 'models',
  });
}
