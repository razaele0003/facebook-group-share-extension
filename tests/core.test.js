import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePostUrl, initialState, createBatch, groupKey, ledgerKey, markIntent, recordResult, recover, assertIdentity, INTERVAL } from '../core.js';
import { discovery, groups, actor, sourceUrl } from './fixtures.js';
test('post URLs strip tracking, preserve content IDs, and reject non-posts and foreign hosts', () => {
  assert.equal(normalizePostUrl('https://www.facebook.com/photo/?fbid=123456&__tn__=x'), sourceUrl);
  assert.equal(normalizePostUrl('https://www.facebook.com/example/posts/pfbidAbc/?tracking=123'), 'https://www.facebook.com/example/posts/pfbidAbc');
  for (const value of ['https://evil.invalid/posts/123', 'https://www.facebook.com.evil.invalid/a/posts/1', 'https://www.facebook.com/profile.php?id=1', 'https://www.facebook.com/', 'https://www.facebook.com/groups/123', 'javascript:alert(1)']) assert.throws(() => normalizePostUrl(value));
});
function batchState() { const s = initialState(); s.discovery = discovery(); s.batch = createBatch(s.discovery, groups.map(groupKey), '', s.ledger, 1000, 'batch'); return s; }
test('stable IDs distinguish identical group names; repeated selections are deduplicated', () => {
  const d = discovery(); const b = createBatch(d, [groupKey(groups[0]), groupKey(groups[1]), groupKey(groups[0])], '', {}, 0, 'b'); assert.equal(b.items.length, 2);
  d.groups[0].ambiguous = true; assert.throws(() => createBatch(d, [groupKey(groups[0])], '', {}));
});
test('identity requires both matching name and visible avatar fingerprint', () => {
  assert.doesNotThrow(() => assertIdentity(actor, actor));
  assert.throws(() => assertIdentity(actor, { ...actor, fingerprint: '/another.jpg' })); assert.throws(() => assertIdentity(actor, { name: actor.name }));
});
test('submission intent is single-use and immediately blocks duplicate batches', () => {
  const s = batchState(), item = s.batch.items[0]; item.status = 'preparing'; item.attempt = 'once';
  markIntent(s, item, 'once', 1200); assert.equal(item.status, 'submitting');
  assert.throws(() => markIntent(s, item, 'once'));
  assert.throws(() => createBatch(s.discovery, [item.id], '', s.ledger));
});
test('paused or mismatched attempts cannot authorize submission', () => {
  const s = batchState(), item = s.batch.items[0]; item.status = 'preparing'; item.attempt = 'once';
  assert.throws(() => markIntent(s, item, 'other')); s.batch.status = 'paused'; assert.throws(() => markIntent(s, item, 'once'));
});
test('posted, pending and uncertain results stay in the duplicate ledger; cooldown is anchored to confirmation', () => {
  for (const status of ['posted', 'pending', 'uncertain']) {
    const s = batchState(), item = s.batch.items[0]; recordResult(s, item, { status, detail: 'confirmed' }, 5000);
    assert.equal(s.batch.nextAt, 5000 + INTERVAL); assert.equal(s.ledger[ledgerKey(sourceUrl, actor, item.group)].status, status);
    assert.throws(() => createBatch(s.discovery, [item.id], '', s.ledger));
  }
});
test('recovery never retries interrupted submissions; preparation remains safe to retry', () => {
  const s = batchState(); s.batch.items[0].status = 'submitting'; s.batch.items[1].status = 'preparing'; s.operation = { id: 'x' }; s.workingTabId = 88;
  recover(s, true); assert.equal(s.batch.status, 'paused'); assert.equal(s.batch.items[0].status, 'uncertain'); assert.equal(s.batch.items[1].status, 'queued'); assert.equal(s.workingTabId, null); assert.equal(s.operation, null);
});
test('ordinary worker restarts preserve cooldown and running queue without an interrupted operation', () => {
  const s = batchState(); s.batch.nextAt = 999999; recover(s, false); assert.equal(s.batch.status, 'running'); assert.equal(s.batch.nextAt, 999999);
});
