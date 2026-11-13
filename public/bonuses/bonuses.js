import { locale } from '/shared/browser.js';
import { canShowBonus } from './timing.js';
import { renderBingo } from '/shared/bingo.js';
// Анимации из Lua: Scale pop (cubic ease-out) и Slide up, те же интервалы.
(() => {
  const $ = (id) => document.getElementById(id);
  const seen = new Set();
  let settings = null;
  let offset = 0;
  let animation = null;
  let hideTimer = null;
  let inMenu = false;
  let lobbyPopupId = null;
  const buyBoard = $('buy-bingo');
  let buyBoardAnimation = null;
  let showingBuyBoard = false;
  const lifetime = () => settings.fadeInMs + settings.holdMs + settings.fadeOutMs;

  function updateBuyBoard(board, immediate = false) {
    const showBoard = !!board;
    if (board) renderBingo(buyBoard, board, { full: true });
    if (!immediate && showBoard === showingBuyBoard) return;
    showingBuyBoard = showBoard;
    buyBoardAnimation?.cancel();
    buyBoardAnimation = null;
    buyBoard.classList.remove('bingo-entering');
    if (immediate || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      buyBoard.hidden = !showBoard;
      return;
    }

    const open = { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', clipPath: 'inset(0% 0%)' };
    const closed = { opacity: 0, transform: 'translate(-50%, -48%) scale(.95)', clipPath: 'inset(47% 5%)' };
    if (showBoard) buyBoard.classList.add('bingo-entering');
    const transition = buyBoard.animate(showBoard ? [closed, open] : [open, closed], {
      duration: showBoard ? 520 : 280,
      easing: showBoard ? 'cubic-bezier(.16, 1, .3, 1)' : 'cubic-bezier(.55, .06, .68, .19)',
      fill: 'both',
    });
    buyBoardAnimation = transition;
    transition.onfinish = () => {
      if (buyBoardAnimation !== transition) return;
      buyBoard.hidden = !showBoard;
      buyBoard.classList.remove('bingo-entering');
      buyBoardAnimation = null;
      transition.cancel();
    };
  }

  function applyState(s) {
    locale.setLanguage(s.settings.language);
    settings = s.settings.bonuses;
    inMenu = !!s.gsi?.inMenu;
    const buying = s.gsi?.connected && !inMenu && s.match?.phase === 'live' && s.match.roundPhase === 'freezetime';
    updateBuyBoard(buying ? s.bingo : null, inMenu || !s.gsi?.connected);
    offset = s.serverTime - Date.now();
    const c = settings;
    document.documentElement.style.setProperty('--bonus-color', c.color);
    document.documentElement.style.setProperty('--bonus-size', `${c.size}px`);
    $('position').style.left = `${c.x}%`;
    $('position').style.top = `${c.y}%`;
    $('total').textContent = s.bonuses?.total ?? 0;
    $('session-score').hidden = inMenu || !c.enabled || !c.showTotal;
    if (inMenu) {
      if (s.bonuses?.lastPopup) lobbyPopupId = s.bonuses.lastPopup.id;
      if (!$('preview').hidden && !$('popup').hidden) return;
      clearTimeout(hideTimer);
      animation?.cancel();
      $('popup').hidden = true;
      return;
    }
    if (!c.enabled) { clearTimeout(hideTimer); animation?.cancel(); $('popup').hidden = true; return; }
    // Восстанавливаем свежее событие из state; seen защищает от повторного показа.
    if (s.bonuses?.lastPopup) show(s.bonuses.lastPopup);
  }

  function show(p, preview = false) {
    if (!settings || (!preview && (!settings.enabled || inMenu || p.id === lobbyPopupId)) || seen.has(p.id)) return;
    const duration = lifetime();
    if (!canShowBonus(p, Date.now() + offset)) return;
    seen.add(p.id);
    if (seen.size > 100) seen.delete(seen.values().next().value);
    clearTimeout(hideTimer);
    animation?.cancel();
    const el = $('popup');
    $('points').textContent = `+${p.points}`;
    $('label').textContent = p.label || '';
    $('preview').hidden = !preview;
    const parts = $('parts');
    parts.replaceChildren(...p.parts.map((part) => {
      const span = document.createElement('span');
      span.textContent = `${part.label} +${part.points}`;
      return span;
    }));
    parts.classList.toggle('many', p.bonusCount > 2);
    el.hidden = false;
    const c = settings;
    const enter = c.fadeInMs / duration;
    const hold = (c.fadeInMs + c.holdMs) / duration;
    const frames = c.animation === 'scale' ? [
      { opacity: 1, transform: `scale(${c.scaleFrom})`, offset: 0, easing: 'cubic-bezier(.33,1,.68,1)' },
      { opacity: 1, transform: 'scale(1)', offset: enter },
      { opacity: 1, transform: 'scale(1)', offset: hold },
      { opacity: 0, transform: 'scale(1)', offset: 1 },
    ] : [
      { opacity: 0, transform: 'translateY(25px)', offset: 0 },
      { opacity: 1, transform: 'translateY(0)', offset: enter },
      { opacity: 1, transform: 'translateY(0)', offset: hold },
      { opacity: 0, transform: 'translateY(-35px)', offset: 1 },
    ];
    // Новое убийство заменяет прежний popup (как dismiss в режиме Scale Lua).
    animation = el.animate(frames, { duration, fill: 'both', easing: 'linear' });
    hideTimer = setTimeout(() => { el.hidden = true; }, duration);
  }

  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'state') applyState(m.state);
      else if (m.type === 'event' && m.kind === 'kill_bonus') show(m.popup, m.preview);
    };
    ws.onclose = () => {
      updateBuyBoard(null, true);
      setTimeout(connect, 2000);
    };
    ws.onerror = () => ws.close();
  }
  connect();
})();
