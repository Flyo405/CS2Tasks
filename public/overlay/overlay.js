import { renderTaskVote } from '/shared/task-vote.js';
import { renderBingo } from '/shared/bingo.js';
import { locale } from '/shared/browser.js';
// Оверлей для OBS: получает состояние по WebSocket и рисует карточки заданий.
(() => {
  const qs = new URLSearchParams(location.search);
  const scale = parseFloat(qs.get('scale')) || 1;
  const align = qs.get('align') === 'right' ? 'right' : 'left';
  const theme = ['default', 'compact', 'clean'].includes(qs.get('theme')) ? qs.get('theme') : 'default';
  document.documentElement.style.setProperty('--scale', String(scale));
  document.body.classList.add(`align-${align}`, `theme-${theme}`);

  const $ = (id) => document.getElementById(id);
  const $cards = $('cards');
  const $fx = $('fx');
  const icons = window.OverlayIcons;
  $('counter-icon').innerHTML = icons.svg('trophy');

  const SKIP_MS = 2000;       // сколько живёт пропущенная карточка (тряска → штамп → осколки)
  const SHATTER_AT = 1250;    // когда она разлетается
  const MIN_DONE_MS = 2600;   // минимум показа выполненной/проваленной
  const DIFF_LABEL = { easy: 'лёгкое', medium: 'среднее', hard: 'сложное' };
  const CONFETTI = ['#2ee68a', '#ffc53d', '#ffffff', '#4cc9ff', '#b07cff'];

  let state = null;
  let offset = 0; // serverTime - Date.now()
  let firstRender = true;
  let lastCounter = null;
  let lastPoints = null; // { matchId, score, reached }
  let headerKey = null;
  let expiryTimer = null;
  const cards = new Map(); // id → { el, status, progress, target }
  const lastSoundAt = {};

  const now = () => Date.now() + offset;
  const rnd = (a, b) => a + Math.random() * (b - a);

  const mapTitle = (name) => {
    if (!name) return '';
    const s = name.replace(/^(de|cs|ar|dz|gd)_/, '').replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  // ---------- Звук ----------
  function playSound(kind) {
    if (!state || !kind) return;
    const s = state.settings.sounds;
    const file = s[kind];
    if (!file) return;
    const t = Date.now();
    if (t - (lastSoundAt[kind] || 0) < 600) return; // несколько провалов разом — один звук
    lastSoundAt[kind] = t;
    const audio = new Audio(`/sounds/${encodeURIComponent(file)}`);
    audio.volume = Math.max(0, Math.min(1, Number(s.volume) || 0));
    audio.play().catch(() => {});
  }

  // ---------- Видимость ----------
  function windowFor(t) {
    if (t.status === 'skipped') return SKIP_MS;
    if (t.status === 'replaced') return MIN_DONE_MS + 600;
    const showFor = (Number(state.settings.overlay.showCompletedFor) || 0) * 1000;
    return Math.max(MIN_DONE_MS, showFor);
  }
  const finishedShown = (t) => t.status !== 'active' && now() - (t.finishedAt || 0) < windowFor(t);

  function visibleTasks() {
    if (state.gsi.inMenu) {
      return state.tasks.filter((task) => task.test && (task.status === 'active' || finishedShown(task)));
    }
    if (state.bingo) {
      const cells = state.bingo.cells;
      const finishing = cells.filter((task) => cards.has(task.id) && finishedShown(task));
      return [...finishing, ...state.bingo.focus.map((index) => cells[index])].slice(0, 3);
    }
    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    return state.tasks.filter((t) => {
      if (t.status === 'reserve') return false;
      if (t.status !== 'active') return finishedShown(t);
      // Замена появляется, когда карточка старого задания доиграла анимацию.
      const old = t.replaces ? byId.get(t.replaces) : null;
      return !(old && finishedShown(old));
    });
  }

  // ---------- Карточка ----------
  function createCard(t) {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.id = t.id;
    el.innerHTML = '<div class="icon"><span></span></div>'
      + '<div class="info"><div class="title"></div><div class="tags"><span class="tag points"></span><span class="tag diff"></span><span class="tag author"></span></div></div>'
      + '<div class="count"></div>'
      + '<div class="progress"></div>'
      + '<div class="ribbon">НОВОЕ</div>'
      + `<div class="stamp"></div><div class="fail-x">${icons.svg('close')}</div>`;
    return el;
  }

  const usePips = (t) => t.mode === 'counter' && t.bar === 'normal' && t.target >= 1 && t.target <= 10;

  function renderCount(entry, t) {
    const box = entry.el.querySelector('.count');
    if (t.display) {
      if (box.dataset.k !== `d:${t.display}`) {
        box.dataset.k = `d:${t.display}`;
        box.innerHTML = '';
        const s = document.createElement('span');
        s.className = 'txt';
        s.textContent = t.display;
        box.append(s);
      }
      return;
    }
    const key = `n:${t.progress}/${t.target}`;
    if (box.dataset.k === key) return;
    box.dataset.k = key;
    box.innerHTML = `<span class="cur"></span><span class="of"></span>`;
    box.querySelector('.cur').textContent = t.progress;
    box.querySelector('.of').textContent = `/ ${t.target}`;
  }

  function renderProgress(entry, t) {
    const box = entry.el.querySelector('.progress');
    box.hidden = t.bar === 'none';
    if (box.hidden) return;
    const done = t.status === 'completed';
    if (usePips(t)) {
      if (box.dataset.mode !== `pips${t.target}`) {
        box.dataset.mode = `pips${t.target}`;
        box.innerHTML = `<div class="pips">${'<div class="pip"></div>'.repeat(t.target)}</div>`;
      }
      const filled = done ? t.target : Math.min(t.progress, t.target);
      box.querySelectorAll('.pip').forEach((p, i) => p.classList.toggle('on', i < filled));
    } else {
      if (box.dataset.mode !== 'bar') {
        box.dataset.mode = 'bar';
        box.innerHTML = '<div class="bar"><div class="fill"></div></div>';
      }
      const ratio = done ? 1 : t.target ? Math.max(0, Math.min(1, t.progress / t.target)) : 0;
      box.querySelector('.fill').style.width = `${ratio * 100}%`;
    }
  }

  function bumpProgress(entry, t, delta) {
    const count = entry.el.querySelector('.count');
    count.classList.remove('bump');
    void count.offsetWidth;
    count.classList.add('bump');
    if (!t.display && delta > 0) {
      const plus = document.createElement('span');
      plus.className = 'plus';
      plus.textContent = `+${delta}`;
      count.append(plus);
      setTimeout(() => plus.remove(), 1000);
    }
    const pips = entry.el.querySelectorAll('.pip.on');
    for (let i = Math.max(0, pips.length - delta); i < pips.length; i++) {
      pips[i].classList.remove('just');
      void pips[i].offsetWidth;
      pips[i].classList.add('just');
    }
  }

  function confettiAt(el) {
    const r = el.getBoundingClientRect();
    for (let i = 0; i < 18; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = `${r.left + r.width * rnd(0.25, 0.75)}px`;
      c.style.top = `${r.top + r.height / 2}px`;
      c.style.background = CONFETTI[i % CONFETTI.length];
      c.style.setProperty('--dx', `${rnd(-7, 7)}em`);
      c.style.setProperty('--dy', `${rnd(-4.5, 2.5)}em`);
      c.style.setProperty('--r', `${rnd(-540, 540)}deg`);
      c.style.animationDelay = `${rnd(0, 0.12)}s`;
      $fx.append(c);
      setTimeout(() => c.remove(), 1400);
    }
  }

  // Карточка разлетается на осколки (пропуск).
  const SHARDS = [
    'polygon(0 0, 36% 0, 28% 48%, 0 62%)',
    'polygon(36% 0, 71% 0, 61% 55%, 28% 48%)',
    'polygon(71% 0, 100% 0, 100% 72%, 61% 55%)',
    'polygon(0 62%, 28% 48%, 44% 100%, 0 100%)',
    'polygon(28% 48%, 61% 55%, 100% 72%, 100% 100%, 44% 100%)',
  ];
  function shatter(entry) {
    const el = entry.el;
    if (!el.isConnected || entry.shattered) return;
    const r = el.getBoundingClientRect();
    SHARDS.forEach((clip, i) => {
      const s = el.cloneNode(true);
      s.classList.remove('anim-skipped', 'is-new', 'collapsing');
      s.classList.add('shard');
      Object.assign(s.style, {
        left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, boxSizing: 'border-box', clipPath: clip,
      });
      const side = i % 3 === 0 ? -1 : i % 3 === 2 ? 1 : (Math.random() < 0.5 ? -1 : 1);
      s.style.setProperty('--dx', `${side * rnd(1.5, 4.5)}em`);
      s.style.setProperty('--dy', `${rnd(5, 9)}em`);
      s.style.setProperty('--r', `${side * rnd(15, 55)}deg`);
      s.style.animationDelay = `${i * 0.03}s`;
      $fx.append(s);
      setTimeout(() => s.remove(), 1300);
    });
    entry.shattered = true;
    el.classList.add('shattered');
  }

  function updateCard(entry, t, animate) {
    const { el } = entry;
    el.dataset.diff = t.difficulty || '';
    el.dataset.source = t.source;
    el.dataset.bar = t.bar || 'normal';
    const iconName = icons.forTask(t);
    const icon = el.querySelector('.icon span');
    if (icon.dataset.name !== iconName) {
      icon.innerHTML = icons.svg(iconName);
      icon.dataset.name = iconName;
    }
    el.querySelector('.title').textContent = t.title;
    el.querySelector('.title').setAttribute('data-user-content', '');
    el.querySelector('.tag.diff').textContent = DIFF_LABEL[t.difficulty] || '';
    // Режим «Очки»: сколько стоит задание.
    el.querySelector('.tag.points').textContent = t.points > 0 ? `+${t.points}` : '';
    el.querySelector('.tag.points').title = t.penalty > 0 ? `пропуск −${t.penalty}` : '';
    el.querySelector('.tag.author').textContent = t.status === 'replaced' && t.note ? t.note
      : t.source === 'bingo' ? `${locale.t('Клетка')} ${state.bingo.cells.indexOf(t) + 1}`
      : t.source === 'vote' ? locale.t('Выбор чата')
      : t.situational ? `СИТУАЦИОННОЕ · ${t.note || 'на этот раунд'}`
      : t.source === 'viewer' && t.author ? `от @${t.author}` : '';
    el.querySelector('.stamp').textContent = { completed: 'ВЫПОЛНЕНО', skipped: 'ПРОПУЩЕНО', replaced: 'ЗАМЕНЕНО' }[t.status] || '';
    renderCount(entry, t);
    renderProgress(entry, t);

    if (animate && t.status === 'active' && entry.progress != null && t.progress > entry.progress && !t.display) {
      bumpProgress(entry, t, t.progress - entry.progress);
    } else if (animate && t.status === 'active' && t.display && entry.display != null && entry.display !== t.display) {
      bumpProgress(entry, t, 0);
    }
    entry.progress = t.progress;
    entry.display = t.display;

    if (entry.status !== t.status) {
      el.classList.remove('st-active', 'st-completed', 'st-skipped', 'st-failed', 'st-replaced');
      el.classList.add(`st-${t.status}`);
      if (animate && entry.status === 'active' && t.status !== 'active') {
        el.classList.add(`anim-${t.status}`);
        if (t.status === 'completed') requestAnimationFrame(() => confettiAt(el));
        if (t.status === 'skipped') setTimeout(() => shatter(entry), SHATTER_AT);
      } else if (t.status === 'skipped' && !animate) {
        // Перезагрузка оверлея во время пропуска — просто доигрываем осколки.
        setTimeout(() => shatter(entry), 200);
      }
      entry.status = t.status;
    }
  }

  // ---------- Шапка ----------
  function renderHeader() {
    const m = state.match;
    const ov = state.settings.overlay;
    const showMatch = !!(ov.showHeader && m && m.mapName && state.gsi.connected && m.status !== 'pending');
    const showCounter = ov.showCounter !== false;
    const n = state.session?.completed ?? 0;
    const key = JSON.stringify([state.gsi.inMenu, showMatch, showCounter, n, m?.mapName, m?.myScore,
      m?.enemyScore, m?.scoreCT, m?.scoreT, m?.phase, m?.status, m?.round]);
    if (key === headerKey) return;
    headerKey = key;
    $('header').hidden = state.gsi.inMenu || (!showMatch && !showCounter);
    $('hdr-match').hidden = !showMatch;
    $('counter').hidden = !showCounter;
    if (showMatch) {
      $('hdr-map').textContent = mapTitle(m.mapName);
      const sc = $('hdr-score');
      if (m.myScore != null) {
        const cls = m.myScore > m.enemyScore ? 'win' : m.myScore < m.enemyScore ? 'lose' : '';
        sc.innerHTML = `<span class="${cls}"></span> : <span></span>`;
        sc.children[0].textContent = m.myScore;
        sc.children[1].textContent = m.enemyScore;
      } else {
        sc.textContent = `${m.scoreCT} : ${m.scoreT}`;
      }
      $('hdr-round').textContent = m.phase === 'warmup' ? 'разминка'
        : m.status === 'ended' ? 'итог'
          : m.round != null ? `раунд ${m.round + 1}` : '';
    }
    $('counter-num').textContent = n;
    if (lastCounter != null && n > lastCounter) {
      const c = $('counter');
      c.classList.remove('bump');
      void c.offsetWidth;
      c.classList.add('bump');
    }
    lastCounter = n;
  }

  // ---------- Режим «Очки» ----------
  function burstAt(el) {
    const r = el.getBoundingClientRect();
    for (let i = 0; i < 26; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = `${r.left + r.width * rnd(0.05, 0.95)}px`;
      c.style.top = `${r.top + r.height / 2}px`;
      c.style.background = CONFETTI[i % CONFETTI.length];
      c.style.setProperty('--dx', `${rnd(-6, 6)}em`);
      c.style.setProperty('--dy', `${rnd(-3, 5)}em`);
      c.style.setProperty('--r', `${rnd(-540, 540)}deg`);
      c.style.animationDelay = `${rnd(0, 0.2)}s`;
      $fx.append(c);
      setTimeout(() => c.remove(), 1600);
    }
  }

  function renderPoints(animate) {
    const p = state.points;
    const box = $('points');
    box.hidden = !p || state.gsi.inMenu;
    if (!p) { lastPoints = null; return; }
    const reached = !!p.reachedAt;
    const same = lastPoints && lastPoints.matchId === p.matchId;
    if (same && p.score === lastPoints.score && reached === lastPoints.reached && p.goal === lastPoints.goal) return;
    $('points-score').textContent = p.score;
    $('points-goal').textContent = `/ ${p.goal}`;
    $('points-label').textContent = reached ? 'ЦЕЛЬ ДОСТИГНУТА' : 'ОЧКИ';
    $('points-fill').style.width = `${Math.max(0, Math.min(1, p.goal ? p.score / p.goal : 0)) * 100}%`;
    box.classList.toggle('reached', reached);
    box.classList.toggle('negative', p.score < 0);
    if (animate && same && p.score !== lastPoints.score) {
      const diff = p.score - lastPoints.score;
      const plus = document.createElement('span');
      plus.className = `points-plus${diff < 0 ? ' minus' : ''}`;
      plus.textContent = diff > 0 ? `+${diff}` : `−${-diff}`;
      box.append(plus);
      setTimeout(() => plus.remove(), 1300);
      const cls = diff > 0 ? 'bump' : 'drop';
      box.classList.remove('bump', 'drop');
      void box.offsetWidth;
      box.classList.add(cls);
    }
    if (animate && same && reached && !lastPoints.reached) {
      box.classList.add('goal');
      setTimeout(() => box.classList.remove('goal'), 2600);
      requestAnimationFrame(() => burstAt(box));
      setTimeout(() => playSound('complete'), 900); // отдельный звук после звука самого задания
    }
    lastPoints = { matchId: p.matchId, score: p.score, goal: p.goal, reached };
  }

  // ---------- Главный рендер ----------
  function renderVote() {
    renderTaskVote($('task-vote'), state.gsi.inMenu ? null : state.taskVote, now());
  }

  function render() {
    if (!state) return;
    clearTimeout(expiryTimer);
    expiryTimer = null;
    renderHeader();
    const inMenu = state.gsi.inMenu;
    const animate = !firstRender;
    renderBingo($('bingo-board'), inMenu ? null : state.bingo);
    renderPoints(animate);
    renderVote();
    const visible = visibleTasks();
    $('root').hidden = inMenu && visible.length === 0;
    $fx.hidden = inMenu && visible.length === 0;
    const keep = new Set(visible.map((t) => t.id));

    for (const [id, entry] of cards) {
      if (keep.has(id)) continue;
      if (inMenu) {
        entry.el.remove();
        cards.delete(id);
        continue;
      }
      if (entry.removing) continue;
      entry.removing = true;
      entry.el.classList.add('collapsing');
      setTimeout(() => {
        entry.el.remove();
        if (cards.get(id) === entry) cards.delete(id);
      }, 480);
    }

    let prev = null;
    let nextExpiry = Infinity;
    for (const t of visible) {
      let entry = cards.get(t.id);
      if (entry && entry.removing) { entry.el.remove(); cards.delete(t.id); entry = null; }
      if (!entry) {
        entry = { el: createCard(t), status: null, progress: null, display: null };
        cards.set(t.id, entry);
        if (animate && t.status === 'active') {
          const el = entry.el;
          el.classList.add('is-new');
          setTimeout(() => el.classList.remove('is-new'), 2700);
        }
      }
      const bingoIndex = state.bingo?.cells.indexOf(t) ?? -1;
      const key = JSON.stringify([t.title, t.status, t.progress, t.target, t.display, t.difficulty, t.source,
        t.bar, t.mode, t.type, t.params, t.points, t.penalty, t.note, t.situational, t.author, bingoIndex, locale.language]);
      if (key !== entry.key) {
        updateCard(entry, t, animate && entry.status !== null);
        entry.key = key;
      }
      if (t.status !== 'active' && finishedShown(t)) {
        nextExpiry = Math.min(nextExpiry, t.finishedAt + windowFor(t));
      }
      const want = prev ? prev.nextSibling : $cards.firstChild;
      if (want !== entry.el) $cards.insertBefore(entry.el, want);
      prev = entry.el;
    }
    firstRender = false;
    if (Number.isFinite(nextExpiry)) expiryTimer = setTimeout(render, Math.max(1, nextExpiry - now()));
  }

  function applyTask(task) {
    if (!state || !task) return;
    const i = state.tasks.findIndex((t) => t.id === task.id);
    if (i >= 0) state.tasks[i] = task;
  }

  function connect() {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === 'state') {
        if (msg.state.gsi.inMenu && !state?.gsi.inMenu) $fx.replaceChildren();
        state = msg.state;
        locale.setLanguage(state.settings.language);
        offset = state.serverTime - Date.now();
        render();
      } else if (msg.type === 'event') {
        if (msg.task) { applyTask(msg.task); render(); }
        if (msg.sound && (!state?.gsi.inMenu || msg.task?.test || msg.event === 'test_sound')) playSound(msg.sound);
      }
    };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => ws.close();
  }

  connect();
  setInterval(() => { if (state?.taskVote && !state.gsi.inMenu) renderVote(); }, 250);
})();
