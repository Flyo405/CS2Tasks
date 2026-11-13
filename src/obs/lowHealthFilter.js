export const HEALTH_FILTER = 'CS2Tasks — Low HP';

// Own filter only; all existing source filters remain unchanged.
export class LowHealthFilter {
  constructor({ obs, getConfig }) {
    Object.assign(this, { obs, getConfig });
    this.source = null; this.applied = null; this.error = null; this.desired = false;
  }
  sync(active) {
    this.desired = !!active;
    if (!this.obs.status.connected) { this.source = null; this.applied = null; return Promise.resolve(); }
    if (this.running) return this.running;
    this.running = this.reconcile().catch((e) => { this.error = e.message; })
      .finally(() => { this.running = null; });
    return this.running;
  }
  async reconcile() {
    // Re-read desired state after each awaited request to handle rapid death/recovery.
    for (let n = 0; n < 6; n++) {
      const cfg = this.getConfig();
      const source = cfg?.enabled ? cfg.obsSource.trim() : '';
      if (this.source && this.source !== source) {
        await this.obs.request('SetSourceFilterEnabled', { sourceName: this.source, filterName: HEALTH_FILTER, filterEnabled: false });
        this.source = null; this.applied = null;
      }
      if (!source) { this.error = null; return; }
      if (!this.source) {
        const data = await this.obs.request('GetSourceFilterList', { sourceName: source });
        const existing = data.filters?.find((f) => f.filterName === HEALTH_FILTER);
        if (existing && !['color_filter', 'color_filter_v2'].includes(existing.filterKind)) throw new Error('Low HP: filter name is already used by another filter');
        if (!existing) await this.obs.request('CreateSourceFilter', { sourceName: source, filterName: HEALTH_FILTER,
          filterKind: 'color_filter_v2', filterSettings: { saturation: -1 } });
        else await this.obs.request('SetSourceFilterSettings', { sourceName: source, filterName: HEALTH_FILTER, filterSettings: { saturation: -1 }, overlay: true });
        this.source = source; this.applied = null;
      }
      const desired = !!(this.desired && this.getConfig()?.enabled);
      if (this.applied !== desired) {
        await this.obs.request('SetSourceFilterEnabled', { sourceName: source, filterName: HEALTH_FILTER, filterEnabled: desired });
        this.applied = desired;
      }
      if (source === this.getConfig()?.obsSource.trim() && desired === this.desired) { this.error = null; return; }
    }
  }
  async close() {
    this.desired = false;
    await this.running;
    if (this.source && this.obs.status.connected) {
      try { await this.obs.request('SetSourceFilterEnabled', { sourceName: this.source, filterName: HEALTH_FILTER, filterEnabled: false }); }
      catch (e) { this.error = e.message; }
    }
  }
}
