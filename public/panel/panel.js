import { renderTaskVote } from '/shared/task-vote.js';
import { renderBingo } from '/shared/bingo.js';
import { locale } from '/shared/browser.js';
// Панель управления стримера.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /** h('div', { class: 'x', onclick }, 'текст', child) */
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') el.style.cssText = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function toast(msg, isError = false) {
    const t = h('div', { class: `toast${isError ? ' err' : ''}` }, locale.t(msg));
    $('#toasts').append(t);
    setTimeout(() => t.remove(), isError ? 6000 : 3000);
  }

  async function api(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CS2Tasks': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* пусто */ }
    if (!res.ok) {
      const err = new Error(data?.error || `Ошибка ${res.status}`);
      err.details = data?.details;
      throw err;
    }
    return data;
  }

  /** Выполнить действие с уведомлением об ошибке. */
  async function act(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
      return r;
    } catch (e) {
      toast(e.details ? `${e.message}: ${e.details.join('; ')}` : e.message, true);
      return null;
    }
  }

  const DIFF = { easy: 'лёгкое', medium: 'среднее', hard: 'сложное' };
  const STATUS = { active: 'активно', completed: 'выполнено', skipped: 'пропущено', failed: 'провалено', reserve: 'резерв', replaced: 'заменено' };
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString(locale.dateLocale(), { hour: '2-digit', minute: '2-digit' }) : '—');
  const ago = (ts) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s} с назад`;
    if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
    return fmtTime(ts);
  };
  const progressText = (t) => t.display || `${t.progress} / ${t.target}`;

  let state = null;
  let meta = null;
  $('#app-language').addEventListener('change', async (e) => {
    e.target.disabled = true;
    try { await api('PUT', '/config', { language: e.target.value }); location.reload(); }
    catch (err) { toast(locale.t(err.message), true); e.target.disabled = false; }
  });

  // ================= Вкладки =================
  function showTab(name) {
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('main.tab').forEach((m) => { m.hidden = m.id !== `tab-${name}`; });
    if (name === 'settings') loadSettings();
    if (name === 'templates' && !tplLoaded) loadTemplates();
    if (name === 'gsi') loadGsi();
    try { localStorage.setItem('cs2tasks.tab', name); } catch { /* ignore */ }
  }
  $('#tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });

  // ================= Рендер состояния =================
  // Типы, которые сейчас нельзя засчитать (урон, 360°/прыжок/ноускоп без ввода мыши), недоступны в форме.
  function renderTaskOptions() {
    renderComboOptions();
    const blocked = state.blockedTypes || {};
    for (const o of $$('#add-type option')) {
      if (!o.dataset.label) o.dataset.label = o.textContent;
      const reason = blocked[o.value];
      o.disabled = !!reason;
      o.title = reason || '';
      o.textContent = reason ? `${o.dataset.label} — недоступно` : o.dataset.label;
    }
    const sel = $('#add-type');
    if (blocked[sel.value]) {
      sel.value = 'kills';
      renderAddParams();
    }
  }

  function render() {
    if (!state) return;
    if (meta) renderTaskOptions();
    renderPills();
    renderWarnings();
    renderMatch();
    renderTasks();
    renderBingo($('#bingo-board'), state.bingo, { full: true });
    $('#challenge-mode').value = state.settings.tasks.mode ?? 'classic';
    for (const id of ['classic-tasks', 'classic-add', 'queue-panel']) $('#' + id).hidden = !!state.bingo;
    for (const action of ['fill', 'replace', 'overlay-test']) $('[data-action="' + action + '"]').hidden = !!state.bingo;
    renderQueue();
    updateVote();
    renderHistory();
    renderReports();
  }

  function renderPills() {
    const g = state.gsi;
    const pg = $('#pill-gsi');
    if (g.connected) { pg.className = 'pill ok'; pg.textContent = g.inMenu ? 'GSI: в меню' : 'GSI: подключено'; }
    else if (g.everConnected) { pg.className = 'pill bad'; pg.textContent = `GSI: нет данных с ${fmtTime(g.lastPacketAt)}`; }
    else { pg.className = 'pill warn'; pg.textContent = 'GSI: ждём CS2'; }
    pg.title = g.lastPacketAt ? `Последний пакет: ${new Date(g.lastPacketAt).toLocaleTimeString(locale.dateLocale())}` : 'Пакетов ещё не было';
    const pc = $('#pill-chat');
    const c = state.chat;
    if (!c.enabled) { pc.className = 'pill'; pc.textContent = 'Чат: выкл'; }
    else if (c.connected) { pc.className = 'pill ok'; pc.textContent = `Чат: #${c.channel}${c.canSay ? '' : ' (чтение)'}`; }
    else { pc.className = 'pill bad'; pc.textContent = `Чат: не подключён${c.error ? ` (${c.error})` : ''}`; }
  }

  function renderWarnings() {
    const box = $('#warnings');
    box.innerHTML = '';
    if (state.update) {
      box.append(h('div', { class: 'warning' },
        `${locale.t('Доступна новая версия')} ${state.update.version} · `,
        h('a', { href: state.update.url, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть релиз на GitHub')));
    }
    const g = state.gsi;
    if (state.settings.lowHealth?.enabled && state.settings.lowHealth.obsSource && !state.obs.connected) {
      box.append(h('div', { class: 'warning' }, 'Для чёрно-белого эффекта HP подключите OBS на вкладке «Настройки».'));
    }
    if (state.healthEffect?.error) box.append(h('div', { class: 'warning bad' }, `Low HP / OBS: ${state.healthEffect.error}`));
    if (g.install && !g.install.ok) {
      box.append(h('div', { class: 'warning bad' }, `GSI cfg не установлен: ${g.install.message}`));
    } else if (g.install?.changed && !g.everConnected) {
      box.append(h('div', { class: 'warning' }, 'GSI cfg только что установлен — перезапустите CS2, чтобы игра начала присылать данные.'));
    }
    for (const w of state.warnings || []) {
      box.append(h('div', { class: 'warning' }, w.message, w.file ? h('div', { class: 'hint', style: 'color:inherit;margin-top:4px' }, `Пакеты для диагностики: ${w.file}`) : null));
    }
    if (g.ignoredMode) box.append(h('div', { class: 'warning' }, `Режим «${g.ignoredMode}» не входит в allowedModes — прогресс не считается.`));
    if (state.templateErrors?.length) {
      box.append(h('div', { class: 'warning' }, 'Ошибки в templates.json (эти шаблоны пропущены):', h('ul', {}, state.templateErrors.map((e) => h('li', {}, e)))));
    }
  }

  function stat(k, v, cls) {
    return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: `v ${cls || ''}` }, v));
  }

  function sessionStat() {
    const ss = state.session || { completed: 0, skipped: 0 };
    return stat('За сессию', `✓ ${ss.completed}  ⏭ ${ss.skipped} · ${state.bonuses?.total ?? 0} очк.`, 'win');
  }

  function renderMatch() {
    const box = $('#match-info');
    box.innerHTML = '';
    const m = state.match;
    const g = state.gsi;
    if (!m) {
      box.append(h('div', { class: 'empty', style: 'grid-column: 1 / -1' },
        g.everConnected ? 'Матча нет — зайдите в игру (премьер или соревновательный).' : 'Данных от CS2 пока нет. Запустите игру (после установки cfg — перезапустите её).'),
      sessionStat());
      return;
    }
    const statusText = { warmup: 'разминка', live: 'идёт', ended: 'окончен', pending: 'ждём игру' }[m.status] || m.status;
    const score = m.myScore != null ? `${m.myScore} : ${m.enemyScore}` : `${m.scoreCT} : ${m.scoreT}`;
    const scoreCls = m.myScore == null ? '' : m.myScore > m.enemyScore ? 'win' : m.myScore < m.enemyScore ? 'lose' : '';
    const s = m.stats || {};
    const kd = (s.kills / Math.max(1, s.deaths || 0)).toFixed(2);
    const result = { win: 'победа', loss: 'поражение', draw: 'ничья' }[m.result];
    box.append(
      stat('Карта', m.mapName || '—'),
      stat('Режим', m.mode || '—'),
      stat('Статус', result ? `${statusText}: ${result}` : statusText),
      stat('Счёт', score, scoreCls),
      stat('Раунд', m.round != null && m.status !== 'ended' ? m.round + 1 : '—'),
      stat('Команда', m.team || '—'),
      stat('K / D / A', `${s.kills ?? 0} / ${s.deaths ?? 0} / ${s.assists ?? 0}`),
      stat('K/D, MVP', `${kd}, ${s.mvps ?? 0}`),
      sessionStat(),
    );
    if (state.points) {
      const p = state.points;
      box.append(stat('Очки режима', `${p.score} / ${p.goal}${p.reachedAt ? ' ✓' : ''}`, p.reachedAt ? 'win' : ''));
    }
    if (g.observing) box.append(stat('Наблюдение', `${g.observing} (не считается)`));
  }

  function taskCard(t, { buttons = true } = {}) {
    const type = meta?.types.find((x) => x.id === t.type);
    const ratio = t.target ? Math.max(0, Math.min(1, t.progress / t.target)) : 0;
    const src = t.source === 'viewer' ? h('span', { class: 'src-viewer' }, `от @${t.author || 'зрителя'}`)
      : t.source === 'vote' ? locale.t('Выбор чата') : t.situational ? `ситуационное · ${t.note || 'на этот раунд'}` : t.source === 'random' ? 'случайное' : 'добавлено вручную';
    const btns = [];
    if (buttons && t.status === 'active') {
      if (t.mode !== 'end') {
        btns.push(h('button', { class: 'btn icon', title: '−1', onclick: () => act(() => api('POST', `/tasks/${t.id}/progress`, { delta: -1 })) }, '−1'));
        btns.push(h('button', { class: 'btn icon', title: '+1', onclick: () => act(() => api('POST', `/tasks/${t.id}/progress`, { delta: 1 })) }, '+1'));
      }
      btns.push(h('button', { class: 'btn sm ok', onclick: () => act(() => api('POST', `/tasks/${t.id}/complete`)) }, '✓ Выполнено'));
      btns.push(h('button', { class: 'btn sm skip', title: 'Пропустить с позорным звуком', onclick: () => act(() => api('POST', `/tasks/${t.id}/skip`)) }, '⏭ Пропустить (sfx)'));
      if (t.source === 'random') btns.push(h('button', { class: 'btn icon', title: 'Заменить другим случайным (без звука)', onclick: () => act(() => api('POST', `/tasks/${t.id}/regenerate`)) }, '↻'));
    }
    if (buttons && (t.status === 'active' || t.status === 'reserve')) {
      btns.push(h('button', { class: 'btn icon bad', title: 'Удалить без звука', onclick: () => act(() => api('DELETE', `/tasks/${t.id}`)) }, '🗑'));
    }
    const icon = h('div', { class: 'ico' });
    icon.innerHTML = window.OverlayIcons.svg(window.OverlayIcons.forTask(t));
    return h('div', { class: `task${t.status !== 'active' && t.status !== 'reserve' ? ' done' : ''}`, dataset: { diff: t.difficulty || '', source: t.source } },
      icon,
      h('div', {},
        h('div', { class: 'title', 'data-user-content': true }, t.title),
        h('div', { class: 'meta' },
          t.status !== 'active' ? h('span', { class: `status-tag ${t.status}` }, STATUS[t.status]) : null,
          h('span', {}, src),
          t.difficulty ? h('span', {}, DIFF[t.difficulty]) : null,
          type ? h('span', {}, type.name) : null,
          t.test ? h('span', {}, 'тест') : null,
          t.note ? h('span', {}, t.note) : null),
        t.bar !== 'none' || t.display ? h('div', { class: 'prog' },
          t.bar !== 'none' ? h('div', { class: `bar ${t.bar === 'danger' ? 'danger' : ''}` }, h('div', { class: 'fill', style: `width:${ratio * 100}%` })) : null,
          h('span', { class: 'num' }, progressText(t))) : null),
      h('div', { class: 'btns' }, btns));
  }

  function renderTasks() {
    const active = state.tasks.filter((t) => t.status === 'active');
    const reserve = state.tasks.filter((t) => t.status === 'reserve');
    const finished = state.tasks.filter((t) => !['active', 'reserve'].includes(t.status));
    const extra = active.filter((t) => t.situational || t.source === "vote").length;
    $('#active-count').textContent = `${active.length - extra} / макс. ${state.settings.tasks.maxActive}${extra ? ` + ${extra} доп.` : ''}`;
    const list = $('#active');
    list.innerHTML = '';
    if (!active.length) list.append(h('div', { class: 'empty' }, 'Активных заданий нет. Нажмите «Сгенерировать набор» или добавьте своё.'));
    active.forEach((t) => list.append(taskCard(t)));
    $('#reserve-wrap').hidden = !reserve.length;
    $('#reserve').replaceChildren(...reserve.map((t) => taskCard(t)));
    $('#finished-wrap').hidden = !finished.length;
    $('#finished').replaceChildren(...finished.slice().reverse().map((t) => taskCard(t, { buttons: false })));
  }

  function renderQueue() {
    const q = state.suggestions;
    $('#queue-count').textContent = q.length ? `(${q.length})` : '';
    const box = $('#queue');
    box.innerHTML = '';
    if (!q.length) {
      box.append(h('div', { class: 'empty' }, state.chat.enabled
        ? 'Пока пусто. Зрители пишут: !task hs 5, !task deagle 3, !task custom текст'
        : 'Чат Twitch выключен — включите его во вкладке «Настройки».'));
      return;
    }
    for (const s of q) {
      box.append(h('div', { class: 'suggestion' },
        h('div', {},
          h('div', {}, h('span', { class: 'who', 'data-user-content': true }, s.displayName), ' предлагает: ', h('b', { 'data-user-content': true }, s.title)),
          h('div', { class: 'when' }, ago(s.createdAt))),
        h('div', { class: 'row', style: 'margin:0' },
          h('button', { class: 'btn sm ok', onclick: () => act(() => api('POST', `/suggestions/${s.id}/approve`), (r) => (r.task.status === 'reserve' ? 'Одобрено — в резерве' : 'Одобрено')) }, 'Одобрить'),
          h('button', { class: 'btn sm bad', onclick: () => act(() => api('POST', `/suggestions/${s.id}/reject`)) }, 'Отклонить'))));
    }
  }

  function renderHistory() {
    const body = $('#history-body');
    const rows = state.history.map((t) => h('tr', {},
      h('td', {}, fmtTime(t.finishedAt)),
      h('td', {}, h('span', { class: `status-tag ${t.status}` }, STATUS[t.status])),
      h('td', { 'data-user-content': true }, t.title),
      h('td', {}, progressText(t)),
      h('td', {}, t.source === 'viewer' ? `зритель @${t.author}` : t.source === 'vote' ? 'Выбор чата' : t.source === 'random' ? 'случайное' : 'стример')));
    if (!rows.length) rows.push(h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'Пока пусто')));
    body.replaceChildren(...rows);
  }

  // ================= Кнопки матча =================
  $('#match-status').addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (!a) return;
    if (a === 'fill') act(() => api('POST', '/tasks/generate', { mode: 'fill' }), (r) => `Добавлено заданий: ${r.tasks.length}`);
    if (a === 'replace') act(() => api('POST', '/tasks/generate', { mode: 'replace' }), 'Задания перегенерированы');
    if (a === 'new-match' && confirm(locale.t('Начать новый матч? Незавершённые задания текущего матча будут провалены.'))) act(() => api('POST', '/match/new'), 'Новый матч начат');
    if (a === 'sound-skip') act(() => api('POST', '/test/sound', { sound: 'skip' }), 'Звук отправлен в оверлей');
    if (a === 'sound-complete') act(() => api('POST', '/test/sound', { sound: 'complete' }), 'Звук отправлен в оверлей');
    if (a === 'overlay-test') act(() => api('POST', '/test/overlay'), 'Тест запущен — смотрите оверлей');
  });

  // ================= Добавление задания =================
  function renderComboOptions() {
    const sel = $('#p-combo');
    if (!sel) return;
    const i = state?.input;
    for (const o of sel.options) {
      const req = o.dataset.requires;
      o.disabled = !!req && (i?.state !== 'running' || (req === 'spin' && !i?.countsPer360));
      o.title = o.disabled ? 'Нужен работающий ввод мыши и известная чувствительность для 360°' : '';
    }
    if (sel.selectedOptions[0]?.disabled) {
      const first = [...sel.options].find((o) => !o.disabled);
      if (first) sel.value = first.value;
    }
  }

  function paramInput(key, s) {
    const id = `p-${key}`;
    let input;
    if (s.kind === 'choice') {
      input = h('select', { id, name: key }, s.options.map((o) => h('option', { value: o.value, 'data-requires': o.requires || '', selected: o.value === s.default }, o.label)));
    } else if (s.kind === 'weapon') {
      input = h('select', { id, name: key }, meta.weapons.filter((w) => !['Grenade', 'C4'].includes(w.type))
        .map((w) => h('option', { value: w.id, selected: w.id === s.default }, `${w.name}`)));
    } else if (s.kind === 'weaponType') {
      input = h('select', { id, name: key }, meta.weaponTypes.map((w) => h('option', { value: w.id, selected: w.id === s.default }, w.name)));
    } else if (s.kind === 'text') {
      input = h('input', { id, name: key, maxlength: s.maxLength });
    } else {
      input = h('input', { id, name: key, type: 'number', min: s.min, max: s.max, step: s.kind === 'float' ? '0.05' : '1', value: s.default });
    }
    return h('label', {}, s.label, input);
  }

  function renderAddParams() {
    const type = meta.types.find((t) => t.id === $('#add-type').value);
    const box = $('#add-params');
    box.innerHTML = '';
    for (const [k, s] of Object.entries(type.params)) box.append(paramInput(k, s));
    renderComboOptions();
    if (!Object.keys(type.params).length) box.append(h('div', { class: 'empty' }, 'Без параметров'));
  }

  function setupAddForm() {
    const sel = $('#add-type');
    sel.replaceChildren(...meta.types.filter((t) => !t.manual).map((t) => h('option', { value: t.id }, t.name)));
    sel.addEventListener('change', renderAddParams);
    renderAddParams();
    $('#add-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const params = {};
      $$('#add-params [name]').forEach((i) => { params[i.name] = i.type === 'number' ? Number(i.value) : i.value; });
      act(() => api('POST', '/tasks', { type: sel.value, params }), (r) => (r.task.status === 'reserve' ? 'Добавлено в резерв' : 'Задание добавлено'));
    });
    $('#add-random').addEventListener('click', () => act(() => api('POST', '/tasks', { random: true }), (r) => (r.tasks.length ? `Добавлено: ${r.tasks[0].title}` : 'Нет подходящих шаблонов')));
    $('#manual-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = $('#manual-text').value;
      act(() => api('POST', '/tasks', { type: 'manual', params: { text, count: Number($('#manual-count').value) || 1 } }), 'Своё задание добавлено')
        .then((r) => { if (r) $('#manual-text').value = ''; });
    });
  }

  // ================= Шаблоны =================
  let tplLoaded = false;

  function tplRow(t = { type: 'kills', weight: 1, difficulty: 'easy', params: {} }) {
    const typeSel = h('select', { class: 'tpl-type' }, meta.types.filter((x) => !x.manual).map((x) => h('option', { value: x.id, selected: x.id === t.type }, x.name)));
    const diffSel = h('select', { class: 'tpl-diff' }, meta.difficulties.map((d) => h('option', { value: d, selected: d === (t.difficulty || 'medium') }, DIFF[d])));
    const params = h('input', { class: 'tpl-params mono', value: JSON.stringify(t.params || {}) });
    typeSel.addEventListener('change', () => {
      const type = meta.types.find((x) => x.id === typeSel.value);
      const p = {};
      for (const [k, s] of Object.entries(type.params)) p[k] = s.kind === 'int' || s.kind === 'float' ? [s.default, s.default] : s.default;
      params.value = JSON.stringify(p);
    });
    const row = h('tr', {},
      h('td', {}, h('input', { type: 'checkbox', class: 'tpl-on', checked: t.enabled !== false })),
      h('td', {}, typeSel),
      h('td', {}, diffSel),
      h('td', { class: 'w' }, h('input', { type: 'number', class: 'tpl-weight', min: '0.1', step: '0.1', value: t.weight ?? 1 })),
      h('td', { class: 'params-cell' }, params),
      h('td', {}, h('button', { class: 'btn icon bad', title: 'Удалить шаблон', onclick: () => row.remove() }, '🗑')));
    if (t.id) row.dataset.id = t.id;
    return row;
  }

  async function loadTemplates() {
    const r = await act(() => api('GET', '/templates'));
    if (!r) return;
    tplLoaded = true;
    $('#tpl-body').replaceChildren(...r.templates.map((t) => tplRow(t)));
    showTplErrors(r.errors);
  }

  function showTplErrors(errors) {
    $('#tpl-errors').replaceChildren(...(errors?.length ? [h('div', { class: 'warning bad' }, 'Ошибки:', h('ul', {}, errors.map((e) => h('li', {}, e))))] : []));
  }

  function collectTemplates() {
    const out = [];
    const errors = [];
    $$('#tpl-body tr').forEach((row, i) => {
      row.classList.remove('invalid');
      let params;
      try { params = JSON.parse($('.tpl-params', row).value || '{}'); } catch {
        errors.push(`Шаблон #${i + 1}: параметры — некорректный JSON`);
        row.classList.add('invalid');
        return;
      }
      const t = { type: $('.tpl-type', row).value, weight: Number($('.tpl-weight', row).value), difficulty: $('.tpl-diff', row).value, params };
      if (!$('.tpl-on', row).checked) t.enabled = false;
      if (row.dataset.id && !row.dataset.id.startsWith('tpl_')) t.id = row.dataset.id;
      out.push(t);
    });
    return { out, errors };
  }

  $('#tpl-add').addEventListener('click', () => { const r = tplRow(); $('#tpl-body').append(r); r.scrollIntoView({ block: 'center' }); });
  $('#tpl-reload').addEventListener('click', loadTemplates);
  $('#tpl-save').addEventListener('click', async () => {
    const { out, errors } = collectTemplates();
    if (errors.length) return showTplErrors(errors);
    try {
      await api('PUT', '/templates', { templates: out });
      showTplErrors([]);
      toast('Шаблоны сохранены');
    } catch (e) {
      showTplErrors(e.details || [e.message]);
    }
  });

  function renderTypeHelp() {
    const kinds = { int: 'целое', float: 'дробное', weapon: 'оружие (weapon_...)', weaponType: 'тип оружия', text: 'текст', choice: 'вариант' };
    $('#type-help').replaceChildren(h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'id'), h('th', {}, 'Название'), h('th', {}, 'Параметры'))),
      h('tbody', {}, meta.types.map((t) => h('tr', {},
        h('td', {}, h('code', {}, t.id)),
        h('td', {}, `${t.icon} ${t.name}`),
        h('td', {}, Object.entries(t.params).map(([k, s]) => `${k}: ${locale.t(kinds[s.kind])}${s.min != null ? ` ${s.min}..${s.max}` : ''}`).join(', ') || '—'))))),
    h('p', { class: 'hint' }, 'Оружие: ', meta.weapons.map((w) => w.id).join(', ')),
    h('p', { class: 'hint' }, 'Типы оружия: ', meta.weaponTypes.map((w) => `${w.id} (${w.name})`).join(', ')));
  }

  // ================= Настройки =================
  function renderReports() {
    const box = $('#match-reports');
    const reports = state.matchReports || [];
    if (!reports.length) { box.replaceChildren(h('div', { class: 'empty' }, 'Итоги появятся после завершения матча.')); return; }
    box.replaceChildren(...reports.map((r) => {
      const s = r.stats || {};
      const result = { win: 'Победа', loss: 'Поражение', draw: 'Ничья', unknown: 'Матч завершён' }[r.result] || r.result;
      return h('section', { class: 'panel report-card' },
        h('h3', {}, `${r.mapName} · ${locale.t(result)} · ${r.myScore ?? '?'} : ${r.enemyScore ?? '?'}`),
        h('p', { class: 'hint' }, `${new Date(r.endedAt).toLocaleString(locale.dateLocale())}${r.partial ? ' · наблюдалась часть матча' : ''}`),
        h('div', { class: 'match-info' },
          stat('K / D / A', `${s.kills || 0} / ${s.deaths || 0} / ${s.assists || 0}`),
          stat('MVP', s.mvps || 0), stat('Хедшоты', r.headshots), stat('Лучшая серия', r.bestStreak),
          stat('Убийств за раунд, максимум', r.bestRoundKills), stat('Очки бонусов', r.bonusPoints),
          stat('Задания', `✓ ${r.taskCounts.completed} · пропущено ${r.taskCounts.skipped} · провалено ${r.taskCounts.failed}`)));
    }));
  }

  const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const setPath = (obj, p, v) => {
    const keys = p.split('.');
    let o = obj;
    keys.slice(0, -1).forEach((k) => { o[k] = o[k] ?? {}; o = o[k]; });
    o[keys.at(-1)] = v;
  };

  async function loadSettings() {
    const [cfg, network] = await Promise.all([
      act(() => api('GET', '/config')), api('GET', '/overlay-network').catch(() => null),
    ]);
    if (!cfg) return;
    const addresses = network?.addresses ?? [];
    const addressSelect = $('#overlay-lan-address');
    addressSelect.replaceChildren(h('option', { value: '' }, 'Выключено'),
      ...addresses.map(({ name, address }) => h('option', { value: address }, `${name} · ${address}`)));
    if (cfg.overlayLanAddress && !addresses.some(({ address }) => address === cfg.overlayLanAddress)) {
      addressSelect.append(h('option', { value: cfg.overlayLanAddress }, cfg.overlayLanAddress));
    }
    for (const el of $$('#settings-form [data-path]')) {
      const v = getPath(cfg, el.dataset.path);
      const t = el.dataset.type;
      if (el.type === 'checkbox') el.checked = !!v;
      else if (t === 'list') el.value = (v || []).join(', ');
      else if (t === 'lines') el.value = (v || []).join('\n');
      else if (t === 'json') el.value = JSON.stringify(v ?? {}, null, 2);
      else el.value = v ?? '';
    }
    for (const el of $$('#settings-form [data-role]')) el.checked = cfg.twitch.allowedRoles.includes(el.dataset.role);
    for (const el of $$('#settings-form [data-vote-role]')) el.checked = cfg.twitch.voteAllowedRoles.includes(el.dataset.voteRole);
    $('#vol-out').textContent = `${Math.round(cfg.sounds.volume * 100)}%`;
  }

  $('[data-path="sounds.volume"]').addEventListener('input', (e) => { $('#vol-out').textContent = `${Math.round(e.target.value * 100)}%`; });
  $('#settings-reload').addEventListener('click', loadSettings);
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = {};
    try {
      for (const el of $$('#settings-form [data-path]')) {
        const t = el.dataset.type;
        let v;
        if (el.type === 'checkbox') v = el.checked;
        else if (t === 'int') v = parseInt(el.value, 10);
        else if (t === 'num') v = Number(el.value);
        else if (t === 'list') v = el.value.split(',').map((s) => s.trim()).filter(Boolean);
        else if (t === 'lines') v = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
        else if (t === 'json') {
          try { v = JSON.parse(el.value || '{}'); } catch { throw new Error('Коды команд: некорректный JSON'); }
        } else v = el.value;
        setPath(patch, el.dataset.path, v);
      }
    } catch (err) { toast(err.message, true); return; }
    patch.twitch.allowedRoles = $$('#settings-form [data-role]').filter((x) => x.checked).map((x) => x.dataset.role);
    patch.twitch.voteAllowedRoles = $$('#settings-form [data-vote-role]').filter((x) => x.checked).map((x) => x.dataset.voteRole);
    const r = await act(() => api('PUT', '/config', patch), 'Настройки сохранены');
    if (r?.restartRequired) toast('Порт изменится после перезапуска программы. Не забудьте переустановить GSI cfg.', true);
    if (r?.overlayLanRestartRequired) toast('Доступ со второго ПК обновится после перезапуска программы.');
  });

  // ================= GSI и OBS =================
  let tokenShown = false;
  let gsiData = null;
  let overlayNetwork = null;
  $('#obs-connect').addEventListener('click', () => act(() => api('POST', '/obs/connect'), 'Подключаюсь к OBS…'));
  $('#challenge-mode').addEventListener('change', (e) => act(() => api('PUT', '/config', { tasks: { mode: e.target.value } }), 'Режим выбран для следующего матча'));
  const bonusUrl = `${location.origin}/bonuses`;
  const summaryUrl = `${location.origin}/summary`;
  $('#summary-url').value = summaryUrl;
  $('#summary-open').href = summaryUrl;
  $('#summary-copy').addEventListener('click', () => navigator.clipboard.writeText(summaryUrl).then(() => toast('Ссылка скопирована')).catch(() => { $('#summary-url').select(); }));
  $('#summary-test').addEventListener('click', () => act(() => api('POST', '/test/summary'), 'Предпросмотр отправлен в оверлей'));
  $('#bonus-url').value = bonusUrl;
  $('#bonus-open').href = bonusUrl;
  $('#bonus-copy').addEventListener('click', () => navigator.clipboard.writeText(bonusUrl).then(() => toast('Ссылка скопирована')).catch(() => { $('#bonus-url').select(); }));
  $('#bonus-test').addEventListener('click', () => act(() => api('POST', '/test/bonuses'), 'Тест отправлен в оверлей бонусов'));
  $('#bonus-reset').addEventListener('click', () => {
    if (confirm(locale.t('Сбросить бонусные очки за сессию? Задания сохранятся.'))) act(() => api('POST', '/bonuses/reset'), 'Очки сброшены');
  });
  async function loadGsi() {
    [gsiData, overlayNetwork] = await Promise.all([
      act(() => api('GET', '/gsi')), api('GET', '/overlay-network').catch(() => null),
    ]);
    renderGsi();
    updateOverlayUrl();
  }
  function renderGsi() {
    if (!gsiData) return;
    const ins = state?.gsi.install || gsiData.install;
    const kv = (k, v) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)];
    const obs = state?.obs || {};
    $('#obs-info').replaceChildren(...kv('Подключение', !obs.enabled ? 'выключено в настройках' : obs.connected ? 'OBS подключён' : 'ожидаю OBS'),
      ...kv('Статус', obs.error || '—'));
    $('#gsi-info').replaceChildren(
      ...kv('Статус cfg', ins ? (ins.ok ? `✓ ${ins.message}` : `✗ ${ins.message}`) : '—'),
      ...kv('Файл', ins?.path || '—'),
      ...kv('Адрес приёма', `http://127.0.0.1:${gsiData.port}/gsi`),
      ...kv('Токен', tokenShown ? gsiData.token : '••••••••••••'),
      ...kv('Последний пакет', state?.gsi.lastPacketAt ? new Date(state.gsi.lastPacketAt).toLocaleString(locale.dateLocale()) : 'ещё не было'));
    renderInput();
  }
  const agoText = (t) => {
    if (!t) return 'ещё не было';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s} с назад` : `${Math.floor(s / 60)} мин назад`;
  };

  function renderInput() {
    const box = $('#input-info');
    if (!box) return;
    const i = state?.input;
    const kv = (k, v) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)];
    if (!i) { box.replaceChildren(...kv('Статус', 'недоступно')); return; }
    const stateText = !i.enabled ? 'выключено в настройках'
      : i.state === 'running' ? (i.focus ? '✓ работает, CS2 в фокусе' : '✓ работает (ждёт, пока CS2 будет в фокусе)')
        : i.state === 'starting' ? 'запускается…'
          : i.state === 'unavailable' ? 'только для Windows'
            : `✗ ${i.error || 'не работает'}`;
    const sens = i.sensitivity
      ? `${i.sensitivity} (${i.sensitivitySource === 'manual' ? 'из настроек программы' : 'из настроек CS2'}), 360° ≈ ${i.countsPer360} отсчётов мыши`
      : 'неизвестна — задание «360°» недоступно, укажите её в настройках';
    const spin = i.lastSpin ? `${Math.abs(i.lastSpin.deg)}° ${i.lastSpin.deg > 0 ? 'вправо' : 'влево'} за ${(i.lastSpin.ms / 1000).toFixed(2)} с — ${agoText(i.lastSpin.at)}` : 'ещё не было';
    const zoom = ['закрыт', 'открыт (x1)', 'открыт (x2)'][i.zoom] || '—';
    box.replaceChildren(
      ...kv('Статус', stateText),
      ...kv('Чувствительность', sens),
      ...kv('Прыжок на', i.jumpKeys?.length ? i.jumpKeys.join(', ') : '—'),
      ...kv('Последний разворот 360°', spin),
      ...kv('Последнее движение мыши', agoText(i.lastMouseAt)),
      ...kv('Поворот перед последним выстрелом', i.lastAttackTurn
        ? `${i.lastAttackTurn.degrees}° · ${locale.t(i.lastAttackTurn.flick ? 'Флик распознан' : 'Флик не распознан')} · ${agoText(i.lastAttackTurn.at)}`
        : '—'),
      ...kv('Поворот прямо сейчас', i.peakTurn?.deg && Date.now() - i.peakTurn.at < 3000 ? `${i.peakTurn.deg}° (допуск 320–400°)` : '—'),
      ...kv('Последний прыжок', agoText(i.lastJumpAt)),
      ...kv('Прицел снайперки', zoom),
      ...kv('Настройки CS2', i.profileDir || 'не найдены (используются стандартные бинды)'));
  }

  $('#gsi-token-toggle').addEventListener('click', () => {
    tokenShown = !tokenShown;
    $('#gsi-token-toggle').textContent = tokenShown ? 'Скрыть токен' : 'Показать токен';
    renderGsi();
  });
  $('#gsi-dump').addEventListener('click', () => act(() => api('POST', '/gsi/dump'), (r) => `Сохранено ${r.count} пакетов: ${r.file}`));
  $('#gsi-install').addEventListener('click', async () => {
    const r = await act(() => api('POST', '/gsi/install'));
    if (r) toast(r.message, !r.ok);
    loadGsi();
  });
  function updateOverlayUrl() {
    const p = new URLSearchParams();
    const scale = $('#ov-scale').value;
    if (scale && scale !== '1') p.set('scale', scale);
    if ($('#ov-align').value !== 'left') p.set('align', $('#ov-align').value);
    if ($('#ov-theme').value !== 'default') p.set('theme', $('#ov-theme').value);
    const url = `${location.origin}/overlay${p.toString() ? `?${p}` : ''}`;
    $('#ov-url').value = url;
    $('#ov-open').href = url;
    const origin = overlayNetwork?.origin;
    const error = overlayNetwork?.error;
    $('#overlay-lan-panel').hidden = !origin && !error;
    $('#overlay-lan-links').hidden = !origin;
    $('#overlay-lan-error').hidden = !error;
    $('#overlay-lan-error').textContent = error || '';
    if (origin) {
      $('#lan-overlay-url').value = origin + '/overlay' + new URL(url).search;
      $('#lan-bonus-url').value = origin + '/bonuses';
      $('#lan-summary-url').value = origin + '/summary';
    }
  }
  ['#ov-scale', '#ov-align', '#ov-theme'].forEach((s) => $(s).addEventListener('input', updateOverlayUrl));
  $('#ov-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#ov-url').value); toast('Ссылка скопирована'); } catch {
      $('#ov-url').select(); document.execCommand('copy'); toast('Ссылка скопирована');
    }
  });

  let voteClockOffset = 0;
  function updateVote() { renderTaskVote($('#task-vote'), state?.taskVote, Date.now() + voteClockOffset); }

  // ================= WebSocket =================
  function connect() {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    const pill = $('#pill-ws');
    ws.onopen = () => { pill.className = 'pill ok'; pill.textContent = 'Панель: онлайн'; };
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === 'state') {
        if (meta && msg.state.settings.language !== meta.language) { location.reload(); return; }
        state = msg.state;
        voteClockOffset = state.serverTime - Date.now();
        render();
        if (!$('#tab-gsi').hidden) renderGsi();
      }
    };
    ws.onclose = () => {
      pill.className = 'pill bad';
      pill.textContent = 'Панель: нет связи с программой';
      setTimeout(connect, 2000);
    };
    ws.onerror = () => ws.close();
  }

  async function init() {
    meta = await api('GET', '/meta').catch(() => null);
    if (!meta) { toast('Не удалось загрузить данные — программа запущена?', true); setTimeout(init, 2000); return; }
    locale.setLanguage(meta.language);
    $('#app-language').value = meta.language;
    setupAddForm();
    renderTypeHelp();
    connect();
    setInterval(updateVote, 500);
    let tab = 'match';
    try { tab = localStorage.getItem('cs2tasks.tab') || 'match'; } catch { /* ignore */ }
    showTab(['match', 'templates', 'history', 'reports', 'settings', 'gsi'].includes(tab) ? tab : 'match');
    setInterval(() => { if (state?.suggestions.length) renderQueue(); }, 15000);
  }
  init();
})();
