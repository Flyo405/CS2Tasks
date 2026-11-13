// Twitch через tmi.js. Без токена — анонимно (justinfan), только чтение.
//
// Интерфейс ChatProvider (так же можно сделать YouTube):
//   connect(): Promise<void>
//   disconnect(): Promise<void>
//   onMessage(cb: ({ user, displayName, text, roles: Set<string> }) => void)
//   say(text): void            — молча ничего не делает, если писать нельзя
//   status: { connected, channel, canSay, error }

export function rolesFromTags(tags = {}) {
  const roles = new Set(['everyone']);
  const badges = tags.badges || {};
  if (badges.broadcaster) roles.add('broadcaster');
  if (tags.mod || badges.moderator) roles.add('moderator');
  if (badges.vip || tags.vip) roles.add('vip');
  if (tags.subscriber || badges.subscriber || badges.founder) roles.add('subscriber');
  return roles;
}

export class TwitchProvider {
  constructor({ channel, oauthToken = '', botUsername = '', log, onStatus = () => {} }) {
    this.channel = channel.trim().replace(/^#/, '').toLowerCase();
    this.oauthToken = oauthToken.trim();
    this.botUsername = botUsername.trim().toLowerCase();
    this.log = log;
    this.onStatus = onStatus;
    this.handlers = [];
    this.client = null;
    this.status = { connected: false, channel: this.channel, canSay: false, error: null };
  }

  onMessage(cb) {
    this.handlers.push(cb);
  }

  setStatus(patch) {
    Object.assign(this.status, patch);
    this.onStatus({ ...this.status });
  }

  async connect() {
    const tmi = (await import('tmi.js')).default;
    const withIdentity = !!(this.oauthToken && this.botUsername);
    const opts = {
      options: { skipUpdatingEmotesets: true, skipMembership: true },
      connection: { reconnect: true, secure: true },
      channels: [this.channel],
      logger: { info: () => {}, warn: (m) => this.log.debug('tmi:', m), error: (m) => this.log.warn('tmi:', m) },
    };
    if (withIdentity) {
      opts.identity = {
        username: this.botUsername,
        password: this.oauthToken.startsWith('oauth:') ? this.oauthToken : `oauth:${this.oauthToken}`,
      };
    }
    const client = new tmi.Client(opts);
    this.client = client;
    client.on('message', (_channel, tags, message, self) => {
      if (self) return;
      const msg = {
        user: tags.username,
        displayName: tags['display-name'] || tags.username,
        text: message,
        roles: rolesFromTags(tags),
      };
      for (const h of this.handlers) {
        try { h(msg); } catch (e) { this.log.error('Ошибка обработки сообщения чата:', e.message); }
      }
    });
    client.on('connected', () => {
      this.setStatus({ connected: true, canSay: withIdentity, error: null });
      this.log.info(`Чат Twitch подключён: #${this.channel}${withIdentity ? ` (бот ${this.botUsername})` : ' (только чтение)'}`);
    });
    client.on('disconnected', (reason) => {
      this.setStatus({ connected: false, error: reason || null });
      this.log.warn(`Чат Twitch отключён: ${reason || 'без причины'}`);
    });
    try {
      await client.connect();
    } catch (e) {
      const err = typeof e === 'string' ? e : e?.message || String(e);
      this.setStatus({ connected: false, error: err });
      throw new Error(err);
    }
  }

  async disconnect() {
    const c = this.client;
    this.client = null;
    if (c) {
      c.removeAllListeners();
      try { await c.disconnect(); } catch { /* уже отключён */ }
    }
    this.setStatus({ connected: false });
  }

  say(text) {
    if (!this.client || !this.status.canSay) return;
    this.client.say(this.channel, text.slice(0, 480)).catch((e) => this.log.warn('Не удалось написать в чат:', e?.message || e));
  }
}
