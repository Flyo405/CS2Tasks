// Локальное подключение к OBS WebSocket v5.
import crypto from 'node:crypto';
import WebSocket from 'ws';

export function obsAuthentication(password, salt, challenge) {
  const hash = (s) => crypto.createHash('sha256').update(s).digest('base64');
  return hash(hash(password + salt) + challenge);
}

export class ObsConnection {
  constructor({ getConfig, onChange = () => {} }) {
    Object.assign(this, { getConfig, onChange });
    this.socket = null;
    this.pending = new Map();
    this.status = { connected: false, error: null };
    this.stopped = true;
  }
  get cfg() { return this.getConfig().obs; }
  change(patch) { Object.assign(this.status, patch); this.onChange(); }
  start() {
    this.stopped = false;
    if (this.cfg?.enabled) this.connect();
  }
  connect() {
    if (this.stopped || !this.cfg.enabled) return;
    const socket = new WebSocket(`ws://127.0.0.1:${this.cfg.port}`);
    this.socket = socket;
    this.handshakeTimer = setTimeout(() => socket.terminate(), 7000);
    socket.on('message', (raw) => {
      if (this.socket !== socket) return;
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      const d = m.d || {};
      if (m.op === 0) {
        const auth = d.authentication;
        socket.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0,
          ...(auth ? { authentication: obsAuthentication(this.cfg.password, auth.salt, auth.challenge) } : {}) } }));
      } else if (m.op === 2) {
        clearTimeout(this.handshakeTimer);
        this.change({ connected: true, error: null });
      } else if (m.op === 7) {
        const request = this.pending.get(d.requestId);
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(d.requestId);
        if (d.requestStatus?.result) request.resolve(d.responseData || {});
        else request.reject(new Error(d.requestStatus?.comment || `OBS: ошибка ${d.requestStatus?.code}`));
      }
    });
    socket.on('error', () => {
      if (this.socket === socket) this.change({ error: `Нет связи с OBS на порту ${this.cfg.port}. Проверьте WebSocket и пароль.` });
    });
    socket.on('close', (code) => {
      if (this.socket !== socket) return;
      clearTimeout(this.handshakeTimer);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('OBS отключился')); }
      this.pending.clear();
      this.change({ connected: false, error: this.stopped ? null
        : [4005, 4009].includes(code) ? 'OBS: ошибка авторизации, проверьте пароль' : `OBS отключён (код ${code})` });
      if (!this.stopped) this.retryTimer = setTimeout(() => this.connect(), 5000);
    });
  }
  request(requestType, requestData = {}) {
    if (!this.status.connected || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('OBS не подключён'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`OBS не ответил: ${requestType}`)); }, 5000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer); clearTimeout(this.handshakeTimer);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('OBS подключение остановлено')); }
    this.pending.clear();
    const socket = this.socket; this.socket = null;
    socket?.terminate();
    this.change({ connected: false, error: null });
  }
  restart() { this.stop(); this.start(); }
  publicState() { return { enabled: !!this.cfg?.enabled, ...this.status }; }
}
