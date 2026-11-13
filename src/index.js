// Точка входа (и для node src/index.js, и для CS2Tasks.exe). Флаги: --data <папка>  --port <порт>  --no-install  --no-open
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DEFAULT_DATA_DIR, IS_SEA, extractDefaultFiles, readAssetText } from './paths.js';
import { checkForUpdate } from './updates.js';
import { loadConfig, ConfigError, DEFAULT_CONFIG } from './config.js';
import { loadTemplates, migrateTemplates, TEMPLATES_VERSION } from './tasks/templates.js';
import { writeJsonAtomic } from './store.js';
import { Core } from './core.js';
import { createServer } from './server.js';
import { createRecorder } from './gsi/recorder.js';
import { installGsiCfg } from './gsi/installer.js';
import { log, setLogLevel } from './log.js';
import { RETIRED_TYPES } from './tasks/taskTypes.js';
import { InputService, resolveHelperPath } from './input/inputService.js';

function parseArgs(argv) {
  const args = { data: null, port: null, install: true, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data') args.data = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--no-install') args.install = false;
    else if (a === '--no-open') args.open = false;
  }
  return args;
}

/** Если exe запущен двойным кликом и упал — не закрываем окно сразу, чтобы была видна ошибка. */
async function pauseBeforeExit() {
  if (!IS_SEA || !process.stdin.isTTY) return;
  console.log('\nНажмите Enter, чтобы закрыть окно...');
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });
}

function openInBrowser(url) {
  if (process.platform !== 'win32') return;
  spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function main() {
  process.title = 'CS2 Tasks';
  const args = parseArgs(process.argv.slice(IS_SEA ? 1 : 2));
  extractDefaultFiles(log);
  const dataDir = path.resolve(args.data || DEFAULT_DATA_DIR);

  let loaded;
  try {
    loaded = loadConfig(dataDir);
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
    await pauseBeforeExit();
    return;
  }
  const { config, file: configFile, created } = loaded;
  if (args.port) config.port = args.port;
  setLogLevel(config.debug.logLevel);
  if (created) log.info(`Создан ${configFile} (токен GSI сгенерирован)`);

  // Новые типы заданий из обновлений — дописываем в templates.json стримера один раз.
  if (!created && (config.templatesVersion || 1) < TEMPLATES_VERSION) {
    const added = migrateTemplates(dataDir, config.templatesVersion || 1);
    if (added) log.info(`В templates.json добавлены шаблоны новых заданий: ${added}`);
  }
  if (config.templatesVersion !== TEMPLATES_VERSION) {
    if ((config.templatesVersion || 1) < 3) {
      for (const code of ['streak', 'alive', 'winstreak', 'fullhp', 'smoke', 'fire', 'weapons', 'ecowin']) {
        if (!Object.hasOwn(config.twitch.aliases, code)) {
          config.twitch.aliases[code] = structuredClone(DEFAULT_CONFIG.twitch.aliases[code]);
        }
      }
    }
    if ((config.templatesVersion || 1) < 4) {
      for (const code of ["jumpns", "360ns", "360jump", "360jumpns", "jumphs", "jumpflash", "nshs", "nsflash", "smokehs", "firehs", "lowhphs"]) {
        if (!Object.hasOwn(config.twitch.aliases, code)) config.twitch.aliases[code] = structuredClone(DEFAULT_CONFIG.twitch.aliases[code]);
      }
    }
    if ((config.templatesVersion || 1) < 5 && !Object.hasOwn(config.twitch.aliases, 'lastbullet')) {
      config.twitch.aliases.lastbullet = structuredClone(DEFAULT_CONFIG.twitch.aliases.lastbullet);
    }
    config.templatesVersion = TEMPLATES_VERSION;
    writeJsonAtomic(configFile, config);
  }
  let aliasesCleaned = false;
  for (const [code, alias] of Object.entries(config.twitch.aliases)) {
    if (RETIRED_TYPES.includes(alias.type)) { delete config.twitch.aliases[code]; aliasesCleaned = true; }
  }
  if (aliasesCleaned) writeJsonAtomic(configFile, config);
  const templates = loadTemplates(dataDir);
  for (const err of templates.errors) log.warn(`templates.json: ${err}`);
  log.info(`Шаблонов заданий: ${templates.templates.length}`);

  let core = null;
  let lastTurnBroadcastAt = -Infinity;
  const input = new InputService({
    getConfig: () => (core ? core.config : config),
    getSteamId: () => core?.lastSteamId ?? null,
    dataDir,
    log,
    onEvent: (kind, info) => {
      if (kind === 'inspect' || kind === 'graffiti') {
        core?.handleStyleInput(kind, info.at);
        return;
      }
      if (kind === 'spin') log.info(`360°: ${Math.abs(info.deg)}° за ${(info.ms / 1000).toFixed(2)} с`);
      if (kind === 'turn') {
        if (info.at - lastTurnBroadcastAt < 250) return;
        lastTurnBroadcastAt = info.at;
      }
      core?.changed({ persist: false });
    },
  });
  core = new Core({ config, configFile, dataDir, templates, input });
  const recorder = createRecorder({ dataDir, isEnabled: () => core.config.debug.recordGsi });
  const srv = createServer(core, { recorder });

  try {
    await srv.listen(config.port);
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      log.error(`Порт ${config.port} занят. Возможно, программа уже запущена. Закройте её или поменяйте port в ${configFile} (и переустановите GSI cfg).`);
    } else {
      log.error('Не удалось запустить сервер:', e.message);
    }
    process.exitCode = 1;
    await pauseBeforeExit();
    return;
  }

  const base = `http://127.0.0.1:${config.port}`;
  log.info('──────────────────────────────────────────────');
  log.info(`Панель управления: ${base}/panel`);
  log.info(`Оверлей для OBS:   ${base}/overlay`);
  log.info('──────────────────────────────────────────────');

  if (args.install) {
    const res = await installGsiCfg(config);
    core.gsiInstall = { ...res, at: Date.now() };
    if (res.ok) {
      log.info(`${res.message}: ${res.path}`);
      if (res.changed) log.warn('ВАЖНО: если CS2 сейчас запущена — перезапустите игру, иначе данные не придут.');
    } else {
      log.warn(res.message);
    }
  } else {
    core.gsiInstall = { ok: false, path: null, changed: false, message: 'Установка cfg пропущена (--no-install)', at: Date.now() };
  }

  if (core.config.twitch.enabled || core.config.twitch.taskVoting) core.restartChat();
  await input.start().catch((e) => log.warn('Ввод мыши и клавиатуры не запущен:', e.message));
  // Стартовый набор — когда ввод мыши уже работает (иначе задания 360/прыжок/ноускоп не могли бы выпасть).
  for (let i = 0; i < 20 && input.status.state === 'starting'; i++) await new Promise((r) => setTimeout(r, 100));
  core.ensureInitialTasks();
  core.obs.start();

  const timer = setInterval(() => core.tick(), 2000);
  if (args.open && config.openPanelOnStart) openInBrowser(`${base}/panel`);

  let stopping = false;
  let tray = null;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    tray?.stdin.end();
    log.info('Остановка...');
    clearInterval(timer);
    recorder.close();
    await core.shutdown();
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (IS_SEA && process.platform === 'win32') {
    const helper = await resolveHelperPath(dataDir, log);
    if (helper) {
      let trayLanguage = core.config.language;
      tray = spawn(helper, ['--tray', trayLanguage], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      tray.on('error', (error) => log.error('Tray:', error.message));
      tray.stdin.on('error', () => {});
      const unsubscribe = core.subscribe((message) => {
        if (message.type !== 'state' || !tray.stdin.writable || trayLanguage === core.config.language) return;
        trayLanguage = core.config.language;
        tray.stdin.write(`LANGUAGE ${trayLanguage}\n`);
      });
      tray.once('close', unsubscribe);
      createInterface({ input: tray.stdout }).on('line', (command) => {
        if (command === 'PANEL') openInBrowser(`${base}/panel`);
        if (command === 'OVERLAY') openInBrowser(`${base}/overlay`);
        if (command === 'UPDATE' && core.update) openInBrowser(core.update.url);
        if (command === 'EXIT') void stop();
      });
    }
  }
  if (IS_SEA) {
    const { version, repository } = JSON.parse(readAssetText('release-info.json') || '{}');
    void checkForUpdate(process.env.CS2TASKS_UPDATE_REPO || repository, version).then((update) => {
      if (!update || stopping) return;
      core.update = update;
      core.changed({ persist: false });
      if (tray?.stdin.writable) tray.stdin.write(`UPDATE ${update.version}\n`);
    });
  }
}

main().catch(async (e) => {
  log.error(e instanceof ConfigError ? e.message : e.stack || e.message);
  process.exitCode = 1;
  await pauseBeforeExit();
});
