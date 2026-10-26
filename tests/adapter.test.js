import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, actor, groups, sourceUrl, pickerHtml, shareHtml } from './fixtures.js';
const data = () => ({ identity: actor, group: groups[1], caption: 'Hello, community!\nAn original update.', sourceUrl, preview: {} });
test('discover native groups and retain separate IDs for matching names', async () => {
  const f = await fixture(); try { const result = await f.adapter.discover(); assert.equal(result.groups.length, 3); assert.equal(result.identity.name, actor.name); assert.equal(result.identity.fingerprint, actor.fingerprint); assert.notEqual(result.groups[0].id, result.groups[1].id); assert.equal(f.clicks(), 0); } finally { f.close(); }
});
test('duplicate nameless-ID rows are marked ambiguous', async () => {
  const f = await fixture({ groups: [{ name: 'Duplicate', privacy: 'Public group' }, { name: 'Duplicate', privacy: 'Public group' }] });
  try { const result = await f.adapter.discover(); assert.equal(result.groups[0].ambiguous, true); } finally { f.close(); }
});
test('prepare fills caption, selects the exact group ID, and never presses Post', async () => {
  const f = await fixture(); try { const result = await f.adapter.prepare(data()); assert.equal(result.identity.name, actor.name); assert.equal(result.composer.querySelector('[contenteditable]').textContent, data().caption); assert.equal(f.clicks(), 0); } finally { f.close(); }
});
test('changed share identity or composer identity prevents authorization and posting', async () => {
  for (const options of [{ shareActor: 'Other Page' }, { composerActor: 'Other Page' }]) {
    const f = await fixture(options); try { let calls = 0; await assert.rejects(f.adapter.submit(data(), async () => { calls++; return { authorized: true }; }), /identity changed/i); assert.equal(calls, 0); assert.equal(f.clicks(), 0); } finally { f.close(); }
  }
});
test('missing original attachment stops preparation', async () => {
  const f = await fixture({ attach: false }); try { await assert.rejects(f.adapter.prepare(data()), /original post is attached/); assert.equal(f.clicks(), 0); } finally { f.close(); }
});
test('fresh success and pending approval confirmations are distinguished', async () => {
  for (const [message, expected] of [['Your post has been published', 'posted'], ['Your post is pending admin approval', 'pending']]) {
    const f = await fixture({ result: message }); try { const result = await f.adapter.submit(data(), async () => ({ authorized: true })); assert.equal(result.status, expected); assert.equal(f.clicks(), 1); } finally { f.close(); }
  }
});
test('stale success notification cannot confirm a new submission', async () => {
  const f = await fixture({ stale: true }); try { const result = await f.adapter.submit(data(), async () => ({ authorized: true })); assert.equal(result.status, 'uncertain'); assert.equal(f.clicks(), 1); } finally { f.close(); }
});
test('pause or Stop at authorization prevents the Post click', async () => {
  const f = await fixture(); try { await assert.rejects(f.adapter.submit(data(), async () => { f.adapter.cancelled = true; return { authorized: false }; }), /paused or stopped/); assert.equal(f.clicks(), 0); } finally { f.close(); }
});
test('a composer identity change after authorization also prevents the click', async () => {
  const f = await fixture(); try { await assert.rejects(f.adapter.submit(data(), async () => { const image = f.window.document.querySelector('image'); image.setAttribute('href', 'https://example.invalid/other.jpg'); return { authorized: true }; }), /identity changed/); assert.equal(f.clicks(), 0); } finally { f.close(); }
});
test('unknown Share controls and unexpected dialogs fail closed', async () => {
  const f = await fixture(); try { f.window.document.body.innerHTML = '<div role="dialog"><h2>Unexpected</h2></div>'; await assert.rejects(f.adapter.openShare(), /unexpected dialog/); } finally { f.close(); }
});
test('login challenges stop all adapter actions', async () => {
  const f = await fixture(); try { f.window.document.body.innerHTML = '<input type="password">'; assert.throws(() => f.adapter.guard(), /sign in/); } finally { f.close(); }
});
test('nested header-only Facebook dialogs resolve to the full composer shell', async () => {
  const f = await fixture(); try {
    f.window.document.body.innerHTML = '<div role="dialog" id="shell"><div role="dialog"><h2>Create post</h2></div><div role="textbox" contenteditable="true" aria-label="Create a public post…"></div></div>';
    assert.equal(f.adapter.dialog('Create post').id, 'shell');
  } finally { f.close(); }
});
test('virtualized group discovery collects rows across scrolling, not just the first screen', async () => {
  const f = await fixture(); try {
    f.window.document.body.innerHTML = pickerHtml(groups.slice(0, 1));
    const picker = f.adapter.dialog('Share to a group'), list = picker.querySelector('[role=list]');
    Object.defineProperties(picker, { clientHeight: { value: 200 }, scrollHeight: { value: 900 } });
    picker.addEventListener('scroll', () => { const index = Math.min(2, Math.floor(picker.scrollTop / 200)); const temporary = f.window.document.createElement('div'); temporary.innerHTML = pickerHtml([groups[index]]); list.innerHTML = temporary.querySelector('[role=list]').innerHTML; });
    const found = await f.adapter.scan(picker); assert.equal(found.length, 3); assert.equal(new Set(found.map(g => g.id)).size, 3);
  } finally { f.close(); }
});
test('caption text cannot impersonate an original shared attachment', async () => {
  const f = await fixture(); try {
    f.window.document.body.innerHTML = '<div role="dialog"><h2>Create post</h2><div role="textbox" contenteditable="true" aria-label="Create a public post…">This long caption is not an attached original post.</div></div>';
    assert.throws(() => f.adapter.verifyAttachment(f.adapter.dialog('Create post'), sourceUrl, { text: 'This long caption is not an attached original post.' }), /original post/);
  } finally { f.close(); }
});
