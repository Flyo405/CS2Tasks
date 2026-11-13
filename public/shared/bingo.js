import { locale } from './browser.js';

const rendered = new WeakMap();
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function renderBingo(root, board, { full = false } = {}) {
  root.hidden = !board;
  if (!board) return;
  const key = JSON.stringify([board, locale.language]);
  if (rendered.get(root) === key) return;
  rendered.set(root, key);
  const size = board.size ?? 3;
  root.dataset.size = size;
  const heading = element('header', 'bingo-heading');
  heading.append(element('strong', '', locale.t('Бинго') + ' ' + size + '×' + size));
  const grid = element('div', 'bingo-grid');
  board.cells.forEach((task, index) => {
    const focused = board.focus.includes(index);
    const cell = element('div', 'bingo-cell');
    cell.dataset.status = task.status;
    cell.dataset.difficulty = task.difficulty;
    cell.classList.toggle('bingo-focus', focused);
    cell.title = task.title;
    const mark = task.status === 'completed' ? '✓' : task.status === 'failed' ? '×' : '';
    cell.append(element('strong', 'bingo-number', index + 1));
    if (full) cell.append(taskText(task));
    if (mark) cell.append(element('span', 'bingo-mark', mark));
    if (!full && !mark) {
      const icon = element('span', 'bingo-icon');
      const icons = window.OverlayIcons;
      icon.innerHTML = icons.svg(icons.forTask(task));
      cell.append(icon);
    }
    grid.append(cell);
  });
  const tally = element('div', 'bingo-tally');
  tally.append(element('strong', '', `${board.claimed.length}/${2 * size + 2}`), element('span', '', locale.t('Линии')));
  if (full) {
    heading.append(tally);
    root.replaceChildren(heading, grid, element('p', 'hint', locale.t('Строка, столбец или диагональ дают +300 SCORE при включённых бонусах.')));
  } else {
    const side = element('div', 'bingo-side');
    side.append(heading, tally);
    const done = board.cells.filter((task) => task.status === 'completed').length;
    side.append(element('small', 'bingo-completed', `${done}/${size ** 2} ${locale.t('клеток закрыто')}`));
    root.replaceChildren(grid, side);
  }
}

function taskText(task) {
  const body = element('div', 'bingo-task');
  const title = element('span', '', task.title);
  title.dataset.userContent = '';
  body.append(title);
  const progress = task.display ?? (task.mode === 'counter' ? `${task.progress}/${task.target}` : '');
  if (progress) body.append(element('small', '', progress));
  return body;
}
