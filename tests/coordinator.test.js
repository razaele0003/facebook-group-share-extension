import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../coordinator.js';
import { initialState, createBatch, groupKey, ledgerKey } from '../core.js';
import { actor, groups, discovery, sourceUrl } from './fixtures.js';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 500; i++) { if (fn()) return; await pause(1); } throw new Error('Test operation did not settle.'); }
function fakeAPI(saved = initialState(), warm = true) {
  let local = { state: structuredClone(saved) }, session = { sessionStarted: warm }; const alarms = new Map(), messages = [], writes = [];
  const area = (get, set) => ({ get: async key => structuredClone({ [key]: get()[key] }), set: async data => { set({ ...get(), ...structuredClone(data) }); } });
  const api = {
    storage: { local: area(() => local, x => { local = x; writes.push(structuredClone(x.state)); }), session: area(() => session, x => { session = x; }) },
    permissions: { contains: async () => true },
    alarms: { create: async (name, value) => { alarms.set(name, value); }, clear: async name => alarms.delete(name) },
    tabs: { create: async ({ url }) => ({ id: 77, url, status: 'complete' }), get: async id => ({ id, url: sourceUrl, status: 'complete' }), update: async (id, values) => ({ id, ...values, status: 'complete' }), sendMessage: async (id, message) => { messages.push(message); return { ok: true }; } },
    scripting: { executeScript: async () => [] }
  };
  return { api, alarms, messages, writes, stored: () => local.state };
}
const prepared = () => { const s = initialState(); s.discovery = discovery(); return s; };
test('coordinator writes submission intent before granting Post and schedules the next group', async () => {
  let now = 1000; const mock = fakeAPI(prepared()); const c = new Coordinator(mock.api, () => now); await c.ready;
  mock.api.tabs.sendMessage = async (tabId, m) => {
    if (m.type === 'CANCEL') return { ok: true };
    const authorization = await c.authorize({ ...m, identity: actor }, { tab: { id: tabId }, frameId: 0, url: sourceUrl });
    assert.equal(authorization.authorized, true);
    assert.equal(mock.stored().batch.items[0].status, 'submitting');
    assert.equal(mock.stored().ledger[ledgerKey(sourceUrl, actor, groups[0])].status, 'submitting');
    return { ok: true, data: { status: 'posted', detail: 'Your post has been published' } };
  };
  await c.start({ revision: 'revision-a', groups: groups.slice(0, 2).map(groupKey), caption: '' });
  await until(() => c.state.batch.items[0].status === 'posted' && !c.state.operation);
  assert.equal(c.state.batch.items[1].status, 'queued'); assert.equal(c.state.batch.nextAt, 31000); assert.equal(mock.alarms.get('gsa-next').when, 31000);
  await c.tick(); assert.equal(c.state.batch.items[1].status, 'queued');
});
test('Stop during preparation denies the late authorization', async () => {
  const mock = fakeAPI(prepared()); const c = new Coordinator(mock.api); await c.ready; let allowed = false;
  mock.api.tabs.sendMessage = async (tabId, m) => {
    if (m.type === 'CANCEL') return { ok: true };
    await c.control('stop');
    await assert.rejects(c.authorize({ ...m, identity: actor }, { tab: { id: tabId }, frameId: 0, url: sourceUrl }), /cancelled/);
    return { ok: false, error: 'Stopped', code: 'CANCELLED' };
  };
  await c.start({ revision: 'revision-a', groups: groups.map(groupKey), caption: '' });
  await until(() => c.state.batch.status === 'stopped' && !c.state.operation);
  assert.equal(c.state.batch.items[0].status, 'queued'); assert.equal(Object.keys(c.state.ledger).length, 0); assert.equal(allowed, false);
});
test('Stop after intent keeps confirmation but never schedules the next destination', async () => {
  const mock = fakeAPI(prepared()); const c = new Coordinator(mock.api); await c.ready;
  mock.api.tabs.sendMessage = async (tabId, m) => {
    if (m.type === 'CANCEL') return { ok: true };
    await c.authorize({ ...m, identity: actor }, { tab: { id: tabId }, frameId: 0, url: sourceUrl });
    await c.control('stop'); return { ok: true, data: { status: 'pending', detail: 'Pending admin approval' } };
  };
  await c.start({ revision: 'revision-a', groups: groups.map(groupKey), caption: '' });
  await until(() => c.state.batch.items[0].status === 'pending' && !c.state.operation);
  assert.equal(c.state.batch.status, 'stopped'); assert.equal(c.state.batch.items[1].status, 'queued'); assert.equal(mock.alarms.has('gsa-next'), false);
});
test('transport failure after intent is uncertain and cannot be retried', async () => {
  const mock = fakeAPI(prepared()); const c = new Coordinator(mock.api); await c.ready;
  mock.api.tabs.sendMessage = async (tabId, m) => { await c.authorize({ ...m, identity: actor }, { tab: { id: tabId }, frameId: 0, url: sourceUrl }); throw new Error('Tab disconnected'); };
  await c.start({ revision: 'revision-a', groups: [groupKey(groups[0])], caption: '' });
  await until(() => c.state.batch.items[0].status === 'uncertain' && !c.state.operation);
  assert.equal(c.state.batch.status, 'paused'); await c.control('stop');
  await assert.rejects(c.start({ revision: 'revision-a', groups: [groupKey(groups[0])], caption: '' }), /uncertain/);
});
test('cold startup pauses persisted queues; warm restart keeps the cooldown alarm', async () => {
  const saved = prepared(); saved.batch = createBatch(saved.discovery, groups.map(groupKey), '', saved.ledger); saved.batch.nextAt = Date.now() + 30000;
  const cold = new Coordinator(fakeAPI(saved, false).api); await cold.ready; assert.equal(cold.state.batch.status, 'paused');
  const mock = fakeAPI(saved, true), warm = new Coordinator(mock.api); await warm.ready; assert.equal(warm.state.batch.status, 'running'); assert.equal(mock.alarms.get('gsa-next').when, saved.batch.nextAt);
});
test('authorization rejects another tab and a mismatched identity', async () => {
  const saved = prepared(); saved.batch = createBatch(saved.discovery, [groupKey(groups[0])], '', saved.ledger); saved.batch.status = 'paused';
  const mock = fakeAPI(saved); const c = new Coordinator(mock.api); await c.ready;
  await assert.rejects(c.authorize({}, { tab: { id: 1 }, frameId: 0, url: sourceUrl }), /Untrusted/);
});
test('existing active queue prevents a second discovery or batch', async () => {
  const saved = prepared(); saved.batch = createBatch(saved.discovery, [groupKey(groups[0])], '', saved.ledger); saved.batch.status = 'paused';
  const c = new Coordinator(fakeAPI(saved).api); await c.ready;
  await assert.rejects(c.discover(sourceUrl), /Stop the current batch/);
  await assert.rejects(c.start({ revision: 'revision-a', groups: [groupKey(groups[0])], caption: '' }), /still active/);
});
test('storage failure prevents authorization instead of allowing an unrecorded submission', async () => {
  const mock = fakeAPI(prepared()); const c = new Coordinator(mock.api); await c.ready;
  const originalSet = mock.api.storage.local.set;
  mock.api.storage.local.set = async value => { if (value.state.batch?.items.some(i => i.status === 'submitting')) throw new Error('Storage quota exceeded'); return originalSet(value); };
  let grants = 0;
  mock.api.tabs.sendMessage = async (tabId, m) => {
    try { await c.authorize({ ...m, identity: actor }, { tab: { id: tabId }, frameId: 0, url: sourceUrl }); grants++; } catch (error) { return { ok: false, error: error.message }; }
    return { ok: true, data: { status: 'posted', detail: 'Should not happen' } };
  };
  await c.start({ revision: 'revision-a', groups: [groupKey(groups[0])], caption: '' });
  await until(() => c.state.batch.items[0].status === 'failed' && !c.state.operation);
  assert.equal(grants, 0); assert.equal(Object.keys(c.state.ledger).length, 0); assert.equal(c.state.batch.status, 'paused');
});
test('joined import reads the requested tab without creating or navigating a working tab', async () => {
  const mock = fakeAPI(); const c = new Coordinator(mock.api); await c.ready; let created = 0; let navigated = 0;
  mock.api.tabs.get = async id => ({ id, url: 'https://www.facebook.com/groups/joins/', status: 'complete' });
  mock.api.tabs.create = async () => { created++; throw new Error('Unexpected new tab'); }; mock.api.tabs.update = async () => { navigated++; throw new Error('Unexpected navigation'); };
  mock.api.tabs.sendMessage = async (id, m) => { assert.equal(id, 55); assert.equal(m.type, 'IMPORT_JOINED'); return { ok: true, data: { groups, fingerprint: actor.fingerprint, count: 3, pageUrl: 'https://www.facebook.com/groups/joins/' } }; };
  const result = await c.importJoined(55); assert.equal(result.joinedGroups.count, 3); assert.equal(result.discovery, null); assert.equal(created, 0); assert.equal(navigated, 0); assert.equal(result.operation, null);
});
test('checking an imported-list post only requests identity inspection and rejects another account', async () => {
  const saved = initialState(); saved.joinedGroups = { groups, fingerprint: actor.fingerprint, count: 3 }; const mock = fakeAPI(saved), c = new Coordinator(mock.api); await c.ready;
  mock.api.tabs.sendMessage = async (id, m) => { assert.equal(m.type, 'INSPECT_POST'); return { ok: true, data: { identity: actor, sourceUrl, pageUrl: 'https://www.facebook.com/profile.php?id=123', preview: {} } }; };
  const result = await c.discover(sourceUrl, true); assert.equal(result.discovery.groupSource, 'joined'); assert.equal(result.discovery.groups.length, 3); assert.equal(result.discovery.sourceUrl, sourceUrl);
  mock.api.tabs.sendMessage = async () => ({ ok: true, data: { identity: { ...actor, fingerprint: '/other.jpg' }, sourceUrl } });
  await assert.rejects(c.discover(sourceUrl, true), /differs from the imported group list/); assert.equal(c.state.joinedGroups.count, 3); assert.equal(c.state.discovery, null);
});
test('Stop during an import rejects a late response and keeps the previous list', async () => {
  const saved = initialState(); saved.joinedGroups = { groups: [], fingerprint: actor.fingerprint, count: 0 }; const mock = fakeAPI(saved), c = new Coordinator(mock.api); await c.ready;
  mock.api.tabs.get = async id => ({ id, url: 'https://www.facebook.com/groups/joins/', status: 'complete' });
  mock.api.tabs.sendMessage = async (id, m) => { if (m.type === 'CANCEL') return { ok: true }; await c.control('stop'); return { ok: true, data: { groups, fingerprint: actor.fingerprint, count: 3 } }; };
  await assert.rejects(c.importJoined(55), /import stopped/); assert.equal(c.state.joinedGroups.count, 0); assert.equal(c.state.operation, null);
});
