import { proxyAgentRouter } from './proxy.js';

export default async function handler(req, res) {
  return proxyAgentRouter(req, res, {
    method: 'POST',
    upstreamPath: '/v1/messages',
    passQuery: true,
    label: 'messages',
  });
}
