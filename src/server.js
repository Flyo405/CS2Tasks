// HTTP (express) + WebSocket: GSI, оверлей, панель, REST API.
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { SOUNDS_DIR, readAsset } from './paths.js';
import { createGsiHandler } from './gsi/receiver.js';
import { installGsiCfg } from './gsi/installer.js';
import { TaskError, describeTypes, DIFFICULTIES } from './tasks/taskTypes.js';
import { WEAPONS, WEAPON_TYPES } from './tasks/weapons.js';
import { ConfigError } from './config.js';
import { log } from './log.js';
import { localizeTypes, localizeTask, translate } from './i18n.js';
import { isPrivateIPv4, overlayInterfaces, overlayMessage } from './overlayNetwork.js';

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostAllowed(hostHeader) {
  const host = String(hostHeader || '').replace(/:\d+$/, '').toLowerCase();
  return ALLOWED_HOSTS.has(host);
}

/** Раздача встроенных файлов (из public/ или из exe). */
function assetStatic(dir) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel;
    try { rel = decodeURIComponent(req.path).replace(/^\/+/, ''); } catch { return next(); }
    if (!rel || rel.includes('..') || rel.includes('\\')) return next();
    const buf = readAsset(`${dir}/${rel}`);
    if (!buf) return next();
    res.set('Cache-Control', 'no-cache').type(path.extname(rel)).send(buf);
  };
}

function servePage(name) {
  return (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(readAsset(`public/${name}/index.html`));
}

function mountOverlays(app) {
  for (const name of ['overlay', 'bonuses', 'summary']) {
    app.get(['/' + name, '/' + name + '/'], servePage(name));
    app.use('/' + name, assetStatic('public/' + name));
  }
  app.use('/shared', assetStatic('public/shared'));
  app.use('/sounds', express.static(SOUNDS_DIR));
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function attachWebSocket(server, core, verifyClient, project = (message) => message) {
  const wss = new WebSocketServer({ server, path: '/ws', verifyClient });
  wss.on('connection', (ws) => {
    ws.on('error', () => {});
    ws.send(JSON.stringify(project({ type: 'state', state: core.getState() })));
  });
  const unsubscribe = core.subscribe((message) => {
    if (!wss.clients.size) return;
    const data = JSON.stringify(project(message));
    for (const client of wss.clients) if (client.readyState === 1) client.send(data);
  });
  return () => {
    unsubscribe();
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
}

export function createServer(core, { recorder }) {
  const app = express();
  app.disable('x-powered-by');
  let lanServer = null;
  let closeLanSocket = null;
  const lan = { origin: null, error: null };

  // Защита от DNS-rebinding: принимаем только локальные имена хоста.
  app.use((req, res, next) => {
    if (!hostAllowed(req.headers.host)) return res.status(403).send('Forbidden host');
    next();
  });

  app.post('/gsi', express.text({ type: () => true, limit: '1mb' }), createGsiHandler({
    getConfig: () => core.config,
    onPacket: (raw, at) => core.ingest(raw, at),
    recorder,
  }));

  // Страницы. Отдаём index.html и по /overlay, и по /overlay/ — URL для OBS короткий.
  // Файлы берутся из папки public/ (или изнутри exe).
  mountOverlays(app);
  app.get(['/panel', '/panel/'], servePage('panel'));
  app.get('/', (req, res) => res.redirect('/panel'));
  app.use('/panel', assetStatic('public/panel'));

  // REST API. Изменяющие запросы требуют заголовок X-CS2Tasks — чужой сайт не сможет их отправить.
  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));
  api.use((req, res, next) => {
    if (req.method !== 'GET' && req.headers['x-cs2tasks'] !== '1') return res.status(403).json({ error: translate('Нет заголовка X-CS2Tasks', core.config.language) });
    next();
  });
  const wrap = (fn) => async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out?.task) out.task = localizeTask(out.task, core.config.language);
      if (Array.isArray(out?.tasks)) out.tasks = out.tasks.map((t) => localizeTask(t, core.config.language));
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      next(e);
    }
  };

  api.get('/state', wrap(() => core.getState()));
  api.get('/overlay-network', wrap(() => ({ ...lan, addresses: overlayInterfaces() })));
  api.get('/match-reports', wrap(() => core.reports.history));
  api.post('/obs/connect', wrap(() => { core.obs.restart(); return core.obs.publicState(); }));
  api.get('/meta', wrap(() => ({
    language: core.config.language,
    types: localizeTypes(describeTypes(), core.config.language),
    weapons: Object.entries(WEAPONS).map(([id, w]) => ({ id, ...w, name: translate(w.name, core.config.language) })),
    weaponTypes: Object.entries(WEAPON_TYPES).map(([id, w]) => ({ id, ...w, name: translate(w.name, core.config.language) })),
    difficulties: DIFFICULTIES,
  })));

  api.use('/tasks', (req, res, next) => {
    try { core.requireClassic(); next(); }
    catch (error) { next(error); }
  });

  api.post('/tasks', wrap((req) => {
    const b = req.body || {};
    if (b.random) return { tasks: core.tasks.generate(1).map((task) => localizeTask(task, core.config.language)) };
    return { task: core.tasks.add({ type: b.type, params: b.params, source: 'streamer' }) };
  }));
  api.post('/tasks/generate', wrap((req) => {
    const mode = req.body?.mode === 'replace' ? 'replace' : 'fill';
    return { tasks: mode === 'replace' ? core.tasks.regenerateAll() : core.tasks.fill() };
  }));
  api.post('/tasks/:id/progress', wrap((req) => ({ task: core.tasks.adjustProgress(req.params.id, req.body?.delta) })));
  api.post('/tasks/:id/complete', wrap((req) => ({ task: core.tasks.complete(req.params.id) })));
  api.post('/tasks/:id/skip', wrap((req) => ({ task: core.tasks.skip(req.params.id) })));
  api.post('/tasks/:id/regenerate', wrap((req) => ({ task: core.tasks.regenerateOne(req.params.id) })));
  api.delete('/tasks/:id', wrap((req) => ({ task: core.tasks.remove(req.params.id) })));

  api.post('/match/new', wrap(() => { core.startNewMatch(); }));

  api.post('/suggestions/:id/approve', wrap((req) => ({ task: core.approveSuggestion(req.params.id) })));
  api.post('/suggestions/:id/reject', wrap((req) => ({ item: core.rejectSuggestion(req.params.id) })));

  api.get('/config', wrap(() => core.config));
  api.put('/config', wrap(async (req) => core.updateConfig(req.body)));

  api.get('/templates', wrap(() => ({ templates: core.templatesRaw, errors: core.templateErrors })));
  api.put('/templates', wrap((req) => {
    const list = Array.isArray(req.body) ? req.body : req.body?.templates;
    core.setTemplates(list);
    return { templates: core.templatesRaw, errors: [] };
  }));

  api.get('/gsi', wrap(() => ({
    token: core.config.gsiToken,
    port: core.config.port,
    cs2CfgPath: core.config.cs2CfgPath,
    install: core.gsiInstall,
  })));
  api.post('/gsi/install', wrap(async () => {
    core.gsiInstall = { ...(await installGsiCfg(core.config)), at: Date.now() };
    (core.gsiInstall.ok ? log.info : log.warn)(core.gsiInstall.message, core.gsiInstall.path || '');
    core.changed();
    return core.gsiInstall;
  }));

  api.post('/gsi/dump', wrap(() => {
    const file = core.dumpRawBuffer('manual');
    if (!file) throw new TaskError('Пакетов от CS2 ещё не было');
    return { file, count: core.rawBuffer.length };
  }));

  api.post('/test/sound', wrap((req) => { core.playTestSound(req.body?.sound); }));
  api.post('/test/overlay', wrap(() => { core.runOverlayTest(); }));
  api.post('/bonuses/reset', wrap(() => { core.bonuses.reset(); core.changed(); }));
  api.post('/test/bonuses', wrap(() => {
    // Предпросмотр не начисляет очки и не меняет настоящую серию.
    core.emitEvent({ kind: 'kill_bonus', preview: true, popup: {
      id: `preview-${Date.now()}`, at: Date.now(), points: 1062, base: 60, bonus: 1002, riskMultiplier: 1.25, riskBonus: 202, diversityBonus: 50,
      label: 'DOUBLE KILL', combo: 2, kills: 1, multiplier: 1.2,
      parts: [{ key: 'air', label: 'AIR', points: 250, count: 1 }, { key: 'noscope', label: 'NOSCOPE', points: 500, count: 1 }, { key: 'risk', label: 'RISK ×1.25', points: 202, count: 1 }, { key: 'diversity', label: 'VARIETY', points: 50, count: 1 }],
      bonusCount: 4, total: core.bonuses.total,
    } });
  }));
  api.post('/test/summary', wrap(() => {
    const report = core.reports.history[0] || {
      matchId: 'preview', mapName: 'de_mirage', result: 'win', myScore: 13, enemyScore: 9,
      stats: { kills: 24, deaths: 14, assists: 6, mvps: 3 }, headshots: 12, bestStreak: 7,
      bestRoundKills: 4, bonusPoints: 3450, taskCounts: { completed: 8, failed: 2, skipped: 1 },
    };
    const goal = core.config.tasks.points.goal;
    const points = report.points ?? (core.config.tasks.mode === 'points' ? { score: goal, goal, reached: true } : undefined);
    core.emitEvent({ kind: 'match_report', preview: true, report: { ...report, points, matchId: `preview-${Date.now()}`, endedAt: Date.now() } });
  }));

  api.use((req, res) => res.status(404).json({ error: translate('Нет такого метода API', core.config.language) }));
  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, _next) => {
    if (err instanceof TaskError || err instanceof ConfigError) {
      return res.status(400).json({ error: translate(err.message, core.config.language), details: err.details?.map((s) => translate(s, core.config.language)) });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: translate('Некорректный JSON', core.config.language) });
    log.error('API:', err.stack || err.message);
    res.status(500).json({ error: translate(err.message, core.config.language) });
  });
  app.use('/api', api);

  const server = http.createServer(app);
  const closeLocalSocket = attachWebSocket(server, core, ({ req }) => hostAllowed(req.headers.host));

  return {
    server,
    async listen(port, host = '127.0.0.1') {
      await listenOn(server, port, host);
      const address = core.config.overlayLanAddress;
      if (!address) return;
      try {
        if (!overlayInterfaces().some((entry) => entry.address === address)) {
          throw new Error(`IP ${address} не найден на игровом ПК. Выберите актуальный адрес в настройках.`);
        }
        const authority = new URL(`http://${address}:${server.address().port}`).host;
        const origin = `http://${authority}`;
        const allowed = (req) => req.headers.host === authority && isPrivateIPv4(req.socket.remoteAddress);
        const overlayApp = express();
        overlayApp.disable('x-powered-by');
        overlayApp.use((req, res, next) => {
          if (!allowed(req) || !['GET', 'HEAD'].includes(req.method)) return res.sendStatus(403);
          next();
        });
        mountOverlays(overlayApp);
        lanServer = http.createServer(overlayApp);
        await listenOn(lanServer, server.address().port, address);
        closeLanSocket = attachWebSocket(lanServer, core, ({ req }) =>
          allowed(req) && (!req.headers.origin || req.headers.origin === origin), overlayMessage);
        lan.origin = origin;
      } catch (error) {
        lan.error = error.message;
        log.warn('Оверлей по локальной сети:', error.message);
      }
    },
    async close() {
      closeLocalSocket();
      closeLanSocket?.();
      await Promise.all([server, lanServer].filter((entry) => entry?.listening)
        .map((entry) => new Promise((resolve) => entry.close(() => resolve()))));
    },
  };
}
