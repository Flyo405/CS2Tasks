import { translate } from './text.js';

let language = 'ru';
const originals = new WeakMap();
const excluded = 'script, style, code, pre, [data-user-content]';
const attributes = ['title', 'placeholder', 'aria-label'];
function textNode(node) {
  if (!node.parentElement || node.parentElement.closest(`${excluded}, textarea, input`)) return;
  const current = node.nodeValue;
  if (!current?.trim()) return;
  const previous = originals.get(node);
  const source = previous && previous.rendered === current ? previous.source : current;
  const rendered = translate(source, language);
  originals.set(node, { source, rendered });
  if (rendered !== current) node.nodeValue = rendered;
}
function scan(root) {
  if (root.nodeType === Node.TEXT_NODE) { textNode(root); return; }
  if (!root.querySelectorAll || root.matches?.(excluded)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) textNode(walker.currentNode);
  for (const el of [root, ...root.querySelectorAll('[title],[placeholder],[aria-label]')]) {
    if (!el.getAttribute || el.closest?.(excluded)) continue;
    for (const attr of attributes) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const state = originals.get(el) ?? {};
      const previous = state[attr];
      const source = previous?.rendered === value ? previous.source : value;
      const next = translate(source, language);
      state[attr] = { source, rendered: next };
      originals.set(el, state);
      if (value !== next) el.setAttribute(attr, next);
    }
  }
}
const observer = new MutationObserver((records) => {
  for (const r of records) {
    if (r.type === 'characterData') textNode(r.target);
    else if (r.type === 'attributes') scan(r.target);
    else for (const node of r.addedNodes) scan(node);
  }
});
observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes });

export const locale = {
  get language() { return language; },
  setLanguage(value) {
    const next = value === 'en' ? 'en' : 'ru';
    if (next === language && document.documentElement.lang === next) return;
    language = next; document.documentElement.lang = language;
    scan(document.documentElement);
  },
  t: (text) => translate(text, language),
  dateLocale: () => language === 'en' ? 'en-US' : 'ru-RU',
};
