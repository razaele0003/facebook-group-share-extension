import { ORIGIN, initialState, normalizePostUrl, groupKey, identityKey, assertIdentity, createBatch, recover, markIntent, recordResult, ledgerKey } from './core.js';

export class Coordinator {
  constructor(api, now = () => Date.now()) {
    this.api = api; this.now = now; this.writes = Promise.resolve(); this.driving = false; this.navigating = new Set();
    this.ready = this.initialize();
  }
  async initialize() {
    const [{ state }, session] = await Promise.all([this.api.storage.local.get('state'), this.api.storage.session.get('sessionStarted')]);
    this.state = recover(state?.schema === 1 ? state : initialState(), !session.sessionStarted);
    await this.api.storage.local.set({ state: this.state });
    await this.api.storage.session.set({ sessionStarted: true });
    if (this.state.batch?.status === 'running') await this.schedule();
  }
  tx(change) {
    const work = this.writes.then(async () => {
      const next = structuredClone(this.state); const result = change(next);
      await this.api.storage.local.set({ state: next }); this.state = next; return result;
    });
    this.writes = work.catch(() => {}); return work;
  }
  async snapshot() { await this.ready; await this.writes; return structuredClone(this.state); }
  async permission() {
    if (!await this.api.permissions.contains({ origins: [ORIGIN + '/*'] })) throw new Error('Enable Facebook access using the side panel first.');
  }
  async workingTab(sourceUrl) {
    await this.permission();
    let tab;
    if (this.state.workingTabId != null) {
      try { tab = await this.api.tabs.get(this.state.workingTabId); } catch { /* closed */ }
    }
    if (!tab) {
      tab = await this.api.tabs.create({ url: sourceUrl, active: true });
      this.navigating.add(tab.id);
      await this.tx(s => { s.workingTabId = tab.id; });
    } else {
      this.navigating.add(tab.id);
      try { tab = await this.api.tabs.update(tab.id, { url: sourceUrl, active: true }); }
      catch (error) { this.navigating.delete(tab.id); throw error; }
    }
    const deadline = this.now() + 35_000;
    try {
      while (this.now() < deadline) {
        const current = await this.api.tabs.get(tab.id);
        if (current.status === 'complete') {
          if (!current.url?.startsWith(ORIGIN + '/')) throw new Error('The working tab left Facebook.');
          await this.api.scripting.executeScript({ target: { tabId: tab.id }, files: ['adapter.js'] });
          return tab.id;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('The Facebook working tab did not finish loading.');
    } finally { this.navigating.delete(tab.id); }
  }
  async rpc(tabId, message) {
    let timer;
    try {
      const response = await Promise.race([
        this.api.tabs.sendMessage(tabId, { ...message, gsa: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Facebook operation timed out. Review the working tab.')), 240_000); })
      ]);
      if (!response?.ok) throw Object.assign(new Error(response?.error || 'The Facebook adapter did not respond.'), { code: response?.code });
      return response.data;
    } finally { clearTimeout(timer); }
  }
  async discover(source) {
    await this.ready; const sourceUrl = normalizePostUrl(source); const id = crypto.randomUUID();
    await this.tx(s => {
      if (s.operation || s.batch?.status === 'running' || s.batch?.status === 'paused') throw new Error('Stop the current batch before finding groups for another post.');
      s.operation = { id, type: 'discover', cancelled: false }; s.notice = 'Finding your available groups in the working tab…';
      s.discovery = null;
    });
    try {
      const tabId = await this.workingTab(sourceUrl);
      if (this.state.operation?.cancelled) throw new Error('Group discovery stopped.');
      const result = await this.rpc(tabId, { type: 'DISCOVER', operationId: id });
      const canonical = normalizePostUrl(result.sourceUrl);
      const seen = new Set();
      result.groups = result.groups.filter(g => { const k = groupKey(g); if (seen.has(k)) return false; seen.add(k); return true; });
      if (!result.identity?.name || !result.identity?.fingerprint) throw new Error('Facebook did not expose a verifiable posting identity.');
      await this.tx(s => {
        if (s.operation?.id !== id || s.operation.cancelled) throw new Error('Group discovery stopped.');
        s.discovery = { ...result, sourceUrl: canonical, discoveredAt: this.now(), revision: id };
        s.notice = `Found ${result.groups.length} groups. Select destinations and review your batch.`;
      });
    } catch (error) {
      await this.tx(s => { s.notice = error.message; }); throw error;
    } finally { await this.tx(s => { if (s.operation?.id === id) s.operation = null; }); }
    return this.snapshot();
  }
  async start({ revision, groups, caption }) {
    await this.ready;
    await this.tx(s => {
      if (s.operation || ['running', 'paused'].includes(s.batch?.status)) throw new Error('Another batch is still active.');
      if (revision !== s.discovery?.revision) throw new Error('The group list changed. Review the batch again.');
      s.batch = createBatch(s.discovery, groups, caption, s.ledger, this.now()); s.notice = '';
    });
    void this.tick(); return this.snapshot();
  }
  async authorize(message, sender) {
    await this.ready;
    await this.tx(s => {
      if (sender.tab?.id !== s.workingTabId || sender.frameId !== 0 || !sender.url?.startsWith(ORIGIN + '/')) throw new Error('Untrusted submission request.');
      if (s.operation?.id !== message.operationId || s.operation.cancelled || s.batch?.id !== message.batchId) throw new Error('This operation has been cancelled or replaced.');
      assertIdentity(s.batch.identity, message.identity);
      const item = s.batch.items.find(i => i.id === message.itemId);
      if (!item) throw new Error('Unknown destination.');
      markIntent(s, item, message.attempt, this.now());
    });
    return { authorized: true };
  }
  async control(action) {
    await this.ready;
    if (!['pause', 'resume', 'stop'].includes(action)) throw new Error('Unknown queue action.');
    await this.tx(s => {
      if (action === 'resume') {
        if (s.operation) throw new Error('Wait for the current Facebook action to finish before resuming.');
        if (!s.batch || s.batch.status !== 'paused') throw new Error('There is no paused batch.');
        for (const item of s.batch.items) if (item.status === 'failed') { item.status = 'queued'; item.detail = ''; }
        s.batch.status = 'running'; s.batch.message = 'Continuing with remaining groups. Uncertain shares will be skipped.';
      } else {
        if (s.operation) s.operation.cancelled = true;
        if (s.batch && ['running', 'paused'].includes(s.batch.status)) { s.batch.status = action === 'stop' ? 'stopped' : 'paused'; s.batch.message = action === 'stop' ? 'Stopped. Already submitted posts remain on Facebook.' : 'Paused. An in-flight submission may still finish.'; }
        s.notice = action === 'stop' ? 'Stopped. Already submitted posts remain on Facebook.' : 'Paused.';
      }
    });
    if (action !== 'resume') {
      await this.api.alarms.clear('gsa-next');
      if (this.state.workingTabId != null) { try { await this.api.tabs.sendMessage(this.state.workingTabId, { gsa: true, type: 'CANCEL' }); } catch {} }
    } else void this.tick();
    return this.snapshot();
  }
  async schedule() {
    if (this.state.batch?.status === 'running') await this.api.alarms.create('gsa-next', { when: Math.max(this.now() + 100, this.state.batch.nextAt) });
  }
  async tick() {
    await this.ready;
    if (this.driving || this.state.operation || this.state.batch?.status !== 'running') return;
    if (this.state.batch.nextAt > this.now()) { await this.schedule(); return; }
    this.driving = true;
    let operationId, batchId, itemId, attempt;
    try {
      const claim = await this.tx(s => {
        if (s.operation || s.batch?.status !== 'running') return null;
        const item = s.batch.items.find(i => i.status === 'queued');
        if (!item) { s.batch.status = 'completed'; s.batch.message = 'Batch finished. Review each group’s result below.'; return null; }
        const op = { id: crypto.randomUUID(), type: 'share', cancelled: false };
        s.operation = op; item.status = 'preparing'; item.attempt = crypto.randomUUID(); item.detail = 'Preparing the native group composer.';
        return { operationId: op.id, batch: structuredClone(s.batch), item: structuredClone(item) };
      });
      if (!claim) return;
      operationId = claim.operationId; batchId = claim.batch.id; itemId = claim.item.id; attempt = claim.item.attempt;
      await this.api.alarms.create('gsa-watchdog', { when: this.now() + 260_000 });
      const tabId = await this.workingTab(claim.batch.sourceUrl);
      if (this.state.operation?.cancelled || this.state.batch.status !== 'running') throw Object.assign(new Error('Preparation paused or stopped.'), { code: 'CANCELLED' });
      const result = await this.rpc(tabId, { type: 'SHARE', operationId, batchId, itemId, attempt,
        data: { identity: claim.batch.identity, group: claim.item.group, caption: claim.batch.caption, sourceUrl: claim.batch.sourceUrl, preview: claim.batch.preview } });
      await this.tx(s => {
        if (s.batch?.id !== batchId) return;
        const item = s.batch.items.find(i => i.id === itemId);
        if (item.attempt !== attempt || item.status !== 'submitting') throw new Error('A result arrived without a persisted submission intent.');
        recordResult(s, item, result, this.now());
      });
    } catch (error) {
      await this.tx(s => {
        if (!batchId || s.batch?.id !== batchId) { s.notice = error.message; return; }
        const item = s.batch.items.find(i => i.id === itemId);
        if (item.status === 'submitting') recordResult(s, item, { status: 'uncertain', detail: error.message + ' Check Facebook; this group will not be retried.' }, this.now());
        else if (item.status === 'preparing') { item.status = error.code === 'CANCELLED' ? 'queued' : 'failed'; item.detail = error.message; }
        if (s.batch.status === 'running') { s.batch.status = 'paused'; s.batch.message = error.message; }
      });
    } finally {
      await this.tx(s => { if (s.operation?.id === operationId) s.operation = null; });
      await this.api.alarms.clear('gsa-watchdog');
      this.driving = false;
      if (this.state.batch?.status === 'running') {
        if (this.state.batch.items.some(i => i.status === 'queued')) await this.schedule();
        else await this.tx(s => { if (s.batch?.status === 'running') { s.batch.status = 'completed'; s.batch.message = 'Batch finished. Review each group’s result below.'; } });
      }
    }
  }
  async interrupted(tabId, reason) {
    await this.ready;
    if (this.state.workingTabId !== tabId || this.navigating.has(tabId)) return;
    await this.tx(s => {
      if (s.batch?.status === 'running') { s.batch.status = 'paused'; s.batch.message = reason; }
      if (s.operation) s.operation.cancelled = true;
    });
    try { await this.api.tabs.sendMessage(tabId, { gsa: true, type: 'CANCEL' }); } catch {}
  }
  async favorite(group, enabled) {
    await this.ready;
    await this.tx(s => {
      if (!s.discovery || !s.discovery.groups.some(g => groupKey(g) === group)) throw new Error('Find groups first.');
      const actor = identityKey(s.discovery.identity); const set = new Set(s.favorites[actor] ?? []);
      if (enabled) set.add(group); else set.delete(group);
      s.favorites[actor] = [...set];
    });
    return this.snapshot();
  }
}
