// Команды чата (!task ...). Не зависит от конкретной платформы — работает с любым ChatProvider.
import { translate, localizeTask } from '../i18n.js';
import { getType } from '../tasks/taskTypes.js';
import { isRange } from '../tasks/templates.js';

const LINK_RE = /(https?:\/\/|www\.|\b[\p{L}\d-]+\.(ru|com|net|org|tv|gg|io|me|xyz|ly|su|ua|by|kz|рф|info|link|click|site|online|shop)\b)/iu;

/** Роли пользователя: everyone, subscriber, vip, moderator, broadcaster. */
export function isAllowed(roles, allowedRoles) {
  if (roles?.has('broadcaster') || allowedRoles.includes('everyone')) return true;
  return allowedRoles.some((r) => roles?.has(r));
}

export function containsBanned(text, bannedWords) {
  const low = text.toLowerCase();
  return bannedWords.some((w) => w && low.includes(String(w).toLowerCase()));
}

/** Диапазон параметра для алиаса: из подходящего шаблона, иначе из схемы типа. */
export function paramRange(alias, templates) {
  const type = getType(alias.type);
  const schema = type?.params?.[alias.param];
  if (!schema) return null;
  const fixed = alias.params || {};
  const matching = templates.filter((t) => t.type === alias.type && Object.entries(fixed).every(([k, v]) => {
    const tv = t.params?.[k];
    return tv === undefined || tv === v || (Array.isArray(tv) && tv.includes(v));
  }) && isRange(t.params?.[alias.param]));
  const ranges = matching.map((t) => t.params[alias.param]);
  let [min, max] = ranges.length ? [Math.min(...ranges.map(([lo]) => lo)), Math.max(...ranges.map(([, hi]) => hi))]
    : [schema.min, schema.max];
  if (typeof alias.min === 'number') min = alias.min;
  if (typeof alias.max === 'number') max = alias.max;
  return { min, max, fromTemplate: ranges.length > 0 };
}

export function createCommandHandler({ checkType = () => null, getConfig, getTemplates, suggestions, getActiveTasks, say, onChange, log }) {
  return function handle(msg) {
    const language = getConfig().language;
    const en = language === 'en';
    const cfg = getConfig().twitch;
    const prefix = cfg.command.trim().toLowerCase();
    const text = String(msg.text || '').trim();
    const lower = text.toLowerCase();
    if (lower !== prefix && !lower.startsWith(`${prefix} `)) return;
    const name = msg.displayName || msg.user;
    const reply = (s) => say(`@${name}, ${translate(s, language)}`);
    if (!isAllowed(msg.roles, cfg.allowedRoles)) {
      reply((en ? 'challenges can only be suggested by: ' : 'предлагать задания сейчас могут только: ') + cfg.allowedRoles.join(', '));
      return;
    }
    const args = text.slice(prefix.length).trim().split(/\s+/).filter(Boolean);

    if (!args.length) {
      const tasks = getActiveTasks();
      if (!tasks.length) say(en ? 'No active challenges yet.' : 'Активных заданий пока нет.');
      else say(`${en ? 'Challenges' : 'Задания'}: ${tasks.map((t, i) => `${i + 1}) ${t.title} — ${t.display || `${t.progress}/${t.target}`}`).join('; ')}`);
      return;
    }

    const sub = args[0].toLowerCase();
    if (sub === 'list' || sub === 'help') {
      const codes = Object.keys(cfg.aliases);
      say(en ? `Codes: ${codes.join(', ')}. Example: ${prefix} ${codes[0] || 'hs'} 5 or ${prefix} custom your text` : `Коды: ${codes.join(', ')}. Пример: ${prefix} ${codes[0] || 'hs'} 5 или ${prefix} custom свой текст`);
      return;
    }

    let type;
    let params;
    if (sub === 'custom') {
      const custom = args.slice(1).join(' ').replace(/\s+/g, ' ').trim();
      if (!custom) return reply(en ? `write: ${prefix} custom <up to 80 characters>` : `напиши текст: ${prefix} custom <текст до 80 символов>`);
      if (custom.length > 80) return reply('текст длиннее 80 символов');
      if (LINK_RE.test(custom)) return reply('ссылки в заданиях запрещены');
      if (containsBanned(custom, cfg.bannedWords)) return reply('в тексте есть запрещённые слова');
      type = 'manual';
      params = { text: custom, count: 1 };
    } else {
      const alias = cfg.aliases[sub];
      if (!alias || !getType(alias.type)) return reply(en ? `unknown code "${sub}". List: ${prefix} list` : `не знаю код «${sub}». Список: ${prefix} list`);
      type = alias.type;
      params = { ...(alias.params || {}) };
      if (alias.param) {
        const range = paramRange(alias, getTemplates());
        let n = args[1] != null ? parseInt(args[1], 10) : NaN;
        if (!Number.isFinite(n)) n = range ? Math.round((range.min + range.max) / 2) : undefined;
        if (range && n != null) n = Math.min(range.max, Math.max(range.min, n));
        params[alias.param] = n;
      }
    }

    const blocked = checkType(type, params);
    if (blocked) return reply(blocked);
    const res = suggestions.propose({ user: msg.user, displayName: name, type, params });
    if (!res.ok) return reply(res.error);
    log.info(`Предложение от ${name}: ${res.item.title}`);
    onChange();
    reply(en ? `challenge "${localizeTask(res.item, language).title}" submitted for moderation` : `задание «${res.item.title}» отправлено на модерацию`);
  };
}
