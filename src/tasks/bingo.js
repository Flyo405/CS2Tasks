import { ASSET, readAssetText } from '../paths.js';
import { generate, instantiateParams, randInt } from './generator.js';
import { TaskManager } from './taskManager.js';
import { getType, normalizeParams } from './taskTypes.js';
import { validateTemplates } from './templates.js';

function boardLines(size) {
  const indices = Array.from({ length: size }, (_, i) => i);
  return [
    ...indices.map((row) => indices.map((col) => row * size + col)),
    ...indices.map((col) => indices.map((row) => row * size + col)),
    indices.map((i) => i * (size + 1)),
    indices.map((i) => (i + 1) * (size - 1)),
  ];
}
const defaults = validateTemplates(JSON.parse(readAssetText(ASSET.defaultTemplates))).templates;
const eligible = (t) => ['medium', 'hard'].includes(t.difficulty) && !getType(t.type)?.roundScoped && !getType(t.type)?.manual;

export class Bingo {
  constructor({ initial, getConfig, getMatch, getCtx, getTemplates, checkType, onFinished, onLine, now, rng, log }) {
    Object.assign(this, { getTemplates, checkType, onLine, rng });
    this.matchId = initial?.matchId ?? null;
    this.size = initial?.size === 5 ? 5 : 3;
    this.claimed = new Set(initial?.claimed ?? []);
    this.manager = new TaskManager({
      getConfig: () => ({ ...getConfig(), tasks: { count: 0, maxActive: this.size ** 2 } }),
      getTemplates: () => [], getMatch, getCtx, onFinished, now, rng, log,
      initial: { tasks: initial?.cells },
    });
  }

  get cells() { return this.manager.tasks; }

  start(matchId, size = 3) {
    this.matchId = matchId;
    this.size = size;
    this.claimed.clear();
    this.manager.tasks = [];
    this.manager.history = [];
    if (!matchId) return;
    const custom = this.getTemplates().filter(eligible);
    const fallback = defaults.filter((t) => eligible(t) && !this.checkType(t.type, t.params));
    const cellCount = size ** 2;
    const hardCount = size === 5 ? 8 : 3;
    const pick = (templates, count, excludeTypes) => generate({ templates, count, rng: this.rng, excludeTypes });
    const specs = pick(custom.filter((t) => t.difficulty === 'hard'), hardCount, []);
    specs.push(...pick(fallback.filter((t) => t.difficulty === 'hard'), hardCount - specs.length, specs.map((t) => t.type)));
    specs.push(...pick(custom.filter((t) => t.difficulty === 'medium'), cellCount - specs.length, specs.map((t) => t.type)));
    specs.push(...pick(fallback, cellCount - specs.length, specs.map((t) => t.type)));
    if (specs.length < cellCount) {
      // A large board can exhaust the distinct types before it exhausts the goals.
      const title = ({ type, params }) => getType(type).title(params);
      const used = new Set(specs.map(title));
      for (let i = 0; i < cellCount && specs.length < cellCount; i++) {
        for (const template of fallback) {
          const params = normalizeParams(template.type, instantiateParams(template.params, () => i / cellCount));
          const spec = { ...template, params };
          const name = title(spec);
          if (used.has(name) || this.checkType(spec.type, params)) continue;
          used.add(name);
          specs.push(spec);
          if (specs.length === cellCount) break;
        }
      }
    }
    for (let i = specs.length - 1; i > 0; i--) {
      const j = randInt(this.rng, 0, i);
      [specs[i], specs[j]] = [specs[j], specs[i]];
    }
    for (const spec of specs) this.manager.add({ ...spec, source: 'bingo' });
  }

  handleEvents(events, ctx) {
    this.manager.handleEvents(events, ctx);
    let earned = 0;
    boardLines(this.size).forEach((line, index) => {
      if (this.claimed.has(index) || !line.every((i) => this.cells[i]?.status === 'completed')) return;
      this.claimed.add(index);
      earned++;
    });
    if (earned) this.onLine(earned, this.matchId);
  }

  serialize() {
    return { matchId: this.matchId, size: this.size, cells: this.cells, claimed: [...this.claimed] };
  }

  focus() {
    const missing = boardLines(this.size).filter((line) => line.every((i) => ['active', 'completed'].includes(this.cells[i]?.status)))
      .map((line) => line.filter((i) => this.cells[i].status === 'active'))
      .filter((line) => line.length).sort((a, b) => a.length - b.length);
    return (missing[0] ?? this.cells.flatMap((t, i) => t.status === 'active' ? [i] : [])).slice(0, 3);
  }
}
