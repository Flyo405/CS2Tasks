import { locale } from '/shared/browser.js';
// Общая карточка для /summary и полноэкранного источника /bonuses.
(() => {
  const root = document.createElement('section');
  root.className = 'match-summary'; root.hidden = true;
  root.innerHTML = '<div class="summary-card"><div class="summary-kicker">МАТЧ ЗАВЕРШЁН</div><div class="summary-result"></div><div class="summary-map"></div><div class="summary-score"><span class="mine"></span><span class="colon">:</span><span class="enemy"></span></div><div class="summary-grid"></div><div class="summary-footer"></div></div>';
  const points = document.createElement('div');
  points.className = 'summary-points';
  points.innerHTML = '<div class="summary-points-line"><strong></strong><span></span></div><div class="summary-points-track"><div class="summary-points-fill"></div></div>';
  root.querySelector('.summary-score').after(points);
  const pointsFill = points.querySelector('.summary-points-fill');
  let pointsAnimation = null;
  document.body.append(root);
  const seen = new Set();
  let settings = null, offset = 0, hideTimer = null, currentId = null, previewing = false;
  let inMenu = false, lobbyReportId = null;
  function hide() { root.hidden = true; previewing = false; pointsAnimation?.cancel(); document.body.classList.remove('summary-open'); clearTimeout(hideTimer); }
  function show(r, preview = false) {
    if (!settings || (!preview && (!settings.enabled || inMenu || r.matchId === lobbyReportId)) || seen.has(r.matchId)) return;
    const remaining = settings.showSeconds * 1000 - (Date.now() + offset - r.endedAt);
    if (remaining <= 0) return;
    seen.add(r.matchId); if (seen.size > 100) seen.delete(seen.values().next().value);
    currentId = r.matchId; previewing = preview;
    const result = { win: ['ПОБЕДА', '#37e69b'], loss: ['ПОРАЖЕНИЕ', '#ff687f'], draw: ['НИЧЬЯ', '#ffcf61'] }[r.result] || ['МАТЧ ЗАВЕРШЁН', '#ffcf61'];
    root.style.setProperty('--result', result[1]);
    root.querySelector('.summary-result').textContent = result[0];
    root.querySelector('.summary-kicker').textContent = preview ? 'ПРЕДПРОСМОТР ИТОГОВ' : 'МАТЧ ЗАВЕРШЁН';
    root.querySelector('.summary-map').textContent = (r.mapName || '').replace(/^(de|cs)_/, '').replaceAll('_', ' ').toUpperCase();
    root.querySelector('.mine').textContent = r.myScore ?? '?';
    root.querySelector('.enemy').textContent = r.enemyScore ?? '?';
    const s = r.stats || {}, t = r.taskCounts || {};
    const values = [[s.kills || 0, 'Убийства'], [s.deaths || 0, 'Смерти'], [s.assists || 0, 'Ассисты'], [s.mvps || 0, 'MVP'],
      [r.headshots || 0, 'Хедшоты'], [r.bestStreak || 0, 'Лучшая серия'], [r.bonusPoints || 0, 'Очки бонусов', true], [t.completed || 0, 'Выполнено за матч', true]];
    root.querySelector('.summary-grid').replaceChildren(...values.map(([value, label, accent]) => {
      const el = document.createElement('div'); el.className = `summary-stat${accent ? ' accent' : ''}`;
      const b = document.createElement('b'), small = document.createElement('small'); b.textContent = value; small.textContent = label; el.append(b, small); return el;
    }));
    pointsAnimation?.cancel();
    points.hidden = !r.points;
    if (r.points) {
      const { score, goal, reached } = r.points;
      points.dataset.reached = String(!!reached);
      points.querySelector('strong').textContent = reached ? 'ЦЕЛЬ ПО ОЧКАМ ДОСТИГНУТА' : 'ЦЕЛЬ ПО ОЧКАМ НЕ ДОСТИГНУТА';
      points.querySelector('span').textContent = `${score} / ${goal}`;
      pointsFill.style.transform = `scaleX(${goal > 0 ? Math.max(0, Math.min(1, score / goal)) : 0})`;
    }
    root.querySelector('.summary-footer').textContent = `Максимум убийств за раунд: ${r.bestRoundKills || 0} · Пропущено заданий: ${t.skipped || 0} · Провалено: ${t.failed || 0}${r.partial ? ' · Статистика наблюдаемой части матча' : ''}`;
    clearTimeout(hideTimer); root.hidden = false; document.body.classList.add('summary-open');
    root.querySelector('.summary-card').animate([{ opacity: 0, transform: 'translateY(20px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: 'cubic-bezier(.16,1,.3,1)' });
    if (r.points && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      pointsAnimation = pointsFill.animate([{ transform: 'scaleX(0)' }, { transform: pointsFill.style.transform }],
        { duration: 850, delay: 250, fill: 'backwards', easing: 'cubic-bezier(.16,1,.3,1)' });
    }
    hideTimer = setTimeout(hide, remaining);
  }
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'state') {
        locale.setLanguage(m.state.settings.language);
        settings = m.state.settings.summary; offset = m.state.serverTime - Date.now();
        inMenu = !!m.state.gsi?.inMenu;
        const latest = m.state.matchReports?.[0];
        if (inMenu) {
          if (latest) lobbyReportId = latest.matchId;
          if (!previewing) hide();
          return;
        }
        if (!settings?.enabled && !previewing) hide();
        const live = m.state.match;
        const newerMatch = live && currentId && live.matchId !== currentId && live.status !== 'ended';
        if (newerMatch && !previewing) hide();
        if (latest && (!live || live.matchId === latest.matchId || live.status === 'ended')) show(latest);
      } else if (m.type === 'event' && m.kind === 'match_report') show(m.report, m.preview);
    };
    ws.onclose = () => setTimeout(connect, 2000); ws.onerror = () => ws.close();
  }
  connect();
})();
