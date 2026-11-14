import { locale } from './browser.js';

const rendered = new WeakMap();

export function renderTaskVote(root, vote, now) {
  root.hidden = !vote;
  if (!vote) return;
  const key = JSON.stringify([vote, locale.language]);
  if (rendered.get(root) !== key) {
    rendered.set(root, key);
    const heading = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = locale.t('Голосование за задание');
    const timer = document.createElement('time');
    heading.append(title, timer);
    const options = vote.options.map((option, index) => {
      const row = document.createElement('div');
      row.className = 'task-vote-option';
      const command = document.createElement('b');
      command.textContent = index + 1;
      const label = document.createElement('span');
      label.dataset.userContent = '';
      label.textContent = option.title;
      const count = document.createElement('strong');
      count.textContent = vote.counts[index];
      row.append(command, label, count);
      return row;
    });
    root.replaceChildren(heading, ...options);
  }
  root.querySelector('time').textContent = `0:${String(Math.max(0, Math.ceil((vote.endsAt - now) / 1000))).padStart(2, '0')}`;
}
