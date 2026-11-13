import { it, expect, afterEach, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { ObsConnection, obsAuthentication } from '../src/obs/connection.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const sessions = [];
afterEach(async () => {
  for (const { client, server } of sessions.splice(0)) {
    client.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});
async function setup() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.obs, { enabled: true, port: server.address().port, password: 'password' });
  const calls = [];
  server.on('connection', (socket) => {
    const send = (op, d) => socket.send(JSON.stringify({ op, d }));
    send(0, { rpcVersion: 1, authentication: { salt: 'salt', challenge: 'challenge' } });
    socket.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.op === 1) {
        if (m.d.authentication !== 'zTM5ki6L2vVvBQiTG9ckH1Lh64AbnCf6XZ226UmnkIA=') { socket.close(4009); return; }
        send(2, { negotiatedRpcVersion: 1 }); return;
      }
      if (m.op !== 6) return;
      const { requestType, requestId, requestData } = m.d;
      calls.push({ requestType, requestData });
      send(7, { requestId, requestStatus: { result: true, code: 100 }, responseData: { filters: [] } });

    });
  });
  const client = new ObsConnection({ getConfig: () => cfg });
  sessions.push({ client, server }); client.start();
  await vi.waitFor(() => expect(client.status.connected).toBe(true));
  return { client, calls };
}

it('authenticates to OBS and forwards filter requests without replay commands', async () => {
  expect(obsAuthentication('password', 'salt', 'challenge')).toBe('zTM5ki6L2vVvBQiTG9ckH1Lh64AbnCf6XZ226UmnkIA=');
  const { client, calls } = await setup();
  await expect(client.request('GetSourceFilterList', { sourceName: 'CS2' })).resolves.toEqual({ filters: [] });
  expect(calls).toEqual([{ requestType: 'GetSourceFilterList', requestData: { sourceName: 'CS2' } }]);
  expect(client.publicState()).not.toHaveProperty('password');
});
