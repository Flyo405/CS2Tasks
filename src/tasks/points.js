// Режим «Очки»: за выполненные задания начисляются очки по сложности, цель — набрать tasks.points.goal за матч.
// Задания идут как в обычном режиме (набор + замена выполненных + доп. задание на раунд).
// Доп. (ситуационные) задания дают очень мало очков. Очки режима не смешиваются с бонусами за убийства.
// Пропуск задания отнимает skipPenalty % его цены; счёт может уйти в минус, достигнутая цель не отбирается.

const LOG_LIMIT = 50;

export class PointsGame {
  /**
   * @param {object} o
   * @param {object} [o.initial] — сохранённое состояние из state.json
   * @param {() => object} o.getConfig
   */
  constructor({ initial = null, getConfig, now = () => Date.now() }) {
    Object.assign(this, { getConfig, now });
    this.matchId = initial?.matchId ?? null;
    this.score = Number(initial?.score) || 0;
    this.reachedAt = initial?.reachedAt ?? null;
    this.log = Array.isArray(initial?.log) ? initial.log : [];
  }

  get cfg() {
    return this.getConfig().tasks.points;
  }

  /** Новый матч: matchId — если выбран режим «Очки», иначе null (режим выключен). */
  start(matchId) {
    this.matchId = matchId;
    this.score = 0;
    this.reachedAt = null;
    this.log = [];
  }

  /** Сколько очков стоит задание. Без сложности (своё, от зрителя) — как среднее. */
  valueOf(task) {
    if (!task || task.test) return 0;
    const c = this.cfg;
    if (task.situational) return c.extra;
    return c[task.difficulty] ?? c.medium;
  }

  /** Начисляет очки за выполненное задание текущего матча. Возвращает итог или null. */
  award(task) {
    if (!this.matchId || task.matchId !== this.matchId || task.status !== 'completed') return null;
    const points = this.valueOf(task);
    if (points <= 0) return null;
    this.score += points;
    this.log.unshift({ taskId: task.id, title: task.title, points, at: this.now() });
    if (this.log.length > LOG_LIMIT) this.log.length = LOG_LIMIT;
    const goal = this.cfg.goal;
    const reached = !this.reachedAt && this.score >= goal;
    if (reached) this.reachedAt = this.now();
    return { points, score: this.score, goal, reached };
  }

  /** Штраф за пропуск: skipPenalty % от цены задания. */
  penaltyOf(task) {
    return Math.round((this.valueOf(task) * (this.cfg.skipPenalty ?? 0)) / 100);
  }

  /** Отнимает очки за пропущенное задание текущего матча. Возвращает итог или null. */
  penalize(task) {
    if (!this.matchId || task.matchId !== this.matchId || task.status !== 'skipped') return null;
    const penalty = this.penaltyOf(task);
    if (penalty <= 0) return null;
    this.score -= penalty;
    this.log.unshift({ taskId: task.id, title: task.title, points: -penalty, at: this.now() });
    if (this.log.length > LOG_LIMIT) this.log.length = LOG_LIMIT;
    return { points: -penalty, score: this.score, goal: this.cfg.goal, reached: false };
  }

  serialize() {
    return { matchId: this.matchId, score: this.score, reachedAt: this.reachedAt, log: this.log };
  }

  publicState() {
    const c = this.cfg;
    return {
      matchId: this.matchId,
      score: this.score,
      goal: c.goal,
      reachedAt: this.reachedAt,
      values: { easy: c.easy, medium: c.medium, hard: c.hard, extra: c.extra },
      skipPenalty: c.skipPenalty,
      log: this.log.slice(0, 10),
    };
  }
}
