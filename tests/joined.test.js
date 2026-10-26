import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, groups, shareHtml, actor } from './fixtures.js';

const cards = list => list.map(g => `<article><a href="${g.url}"><img alt="${g.name}"></a><a href="${g.url}">${g.name}</a><span>You last visited</span><a href="${g.url}">View group</a><button>More</button></article>`).join('');
async function joinedFixture(list = groups, expected = list.length) {
  const f = await fixture(); f.dom.reconfigure({ url: 'https://www.facebook.com/groups/joins/?ordering=viewer_added' });
  f.window.document.body.innerHTML = `<header><button aria-label="Account, your profile"><svg><image href="https://example.invalid/avatar-a.jpg"></image></svg></button></header><nav><a href="/groups/unrelated/">Suggested group outside main</a></nav><main aria-label="Preview of a group"><main id="joinedRoot"><h2>All groups you've joined (${expected})</h2><div role="list">${cards(list)}</div></main></main>`;
  return f;
}
test('joined cards import names and IDs, deduplicate repeated links, and exclude the sidebar', async () => {
  const f = await joinedFixture(); try {
    let clicks = 0; f.window.document.addEventListener('click', () => clicks++);
    const result = await f.adapter.importJoined();
    assert.equal(result.count, 3); assert.equal(result.fingerprint, actor.fingerprint);
    assert.deepEqual(Array.from(result.groups, g => g.id), ['101', '102', '103']);
    assert.equal(result.groups[0].name, 'Local Creators'); assert.equal(result.groups[1].name, 'Local Creators');
    assert.equal(clicks, 0); assert.equal(f.window.document.querySelector('[role=dialog]'), null);
  } finally { f.close(); }
});
test('joined import rejects an incomplete list using Facebook’s displayed total', async () => {
  const f = await joinedFixture(groups, 43); try { await assert.rejects(f.adapter.importJoined(), /43 joined groups, but only 3/); } finally { f.close(); }
});
test('joined import accepts a complete empty list', async () => {
  const f = await joinedFixture([], 0); try { const result = await f.adapter.importJoined(); assert.equal(result.count, 0); } finally { f.close(); }
});
test('joined import collects lazy-loaded cards and restores the initial scroll position', async () => {
  const f = await joinedFixture(groups.slice(0, 2), 3); try {
    const scroll = f.window.document.documentElement, list = f.window.document.querySelector('[role=list]');
    Object.defineProperties(scroll, { clientHeight: { value: 200 }, scrollHeight: { value: 1200 } }); scroll.scrollTop = 37;
    scroll.addEventListener('scroll', () => { list.innerHTML = cards([groups[2]]); });
    const result = await f.adapter.importJoined(); assert.equal(result.count, 3); assert.equal(scroll.scrollTop, 37);
  } finally { f.close(); }
});
test('account changes during joined import reject the result', async () => {
  const f = await joinedFixture(); try {
    f.window.document.documentElement.addEventListener('scroll', () => f.window.document.querySelector('image').setAttribute('href', 'https://example.invalid/other-account.jpg'));
    await assert.rejects(f.adapter.importJoined(), /profile changed during import/);
  } finally { f.close(); }
});
test('joined import cannot run on another Facebook page', async () => {
  const f = await fixture(); try { await assert.rejects(f.adapter.importJoined(), /Your groups/); } finally { f.close(); }
});
test('a permalink post viewer is accepted and its Share button is scoped away from feed posts', async () => {
  const f = await fixture(); try {
    const original = f.window.document.querySelector('button'), viewer = f.window.document.createElement('div'); viewer.setAttribute('role', 'dialog'); viewer.innerHTML = '<h2>Example’s post</h2><div contenteditable="true" role="textbox" aria-label="Comment as Example"></div>'; viewer.append(original);
    f.window.document.body.replaceChildren(viewer); const outside = f.window.document.createElement('button'); outside.textContent = 'Share'; outside.onclick = () => { throw new Error('Wrong Share button'); }; f.window.document.body.append(outside);
    const result = await f.adapter.openShare(); assert.equal(result.identity.name, actor.name); assert.equal(f.clicks(), 0);
  } finally { f.close(); }
});
test('an existing empty Share dialog can be reused but an existing caption draft is protected', async () => {
  const f = await fixture(); try {
    f.window.document.body.innerHTML = shareHtml();
    assert.equal((await f.adapter.openShare()).identity.name, actor.name);
    f.window.document.querySelector('[contenteditable]').textContent = 'A draft I am still writing';
    await assert.rejects(f.adapter.openShare(), /existing draft/);
  } finally { f.close(); }
});
test('source inspection checks identity without opening the native group picker', async () => {
  const f = await fixture(); try {
    const result = await f.adapter.inspectPost(); assert.equal(result.identity.name, actor.name); assert.equal(f.window.document.querySelector('[role=dialog]'), null); assert.equal(f.clicks(), 0);
  } finally { f.close(); }
});
test('visible Share-sheet links resolve a canonical permalink after profile-modal redirects', async () => {
  const f = await fixture(); try {
    f.window.document.body.innerHTML = shareHtml();
    const source = 'https://www.facebook.com/permalink.php?story_fbid=pfbidExample&id=123';
    const target = 'https://wa.me/?text=' + encodeURIComponent(source);
    const a = f.window.document.createElement('a'); a.href = 'https://l.facebook.com/l.php?u=' + encodeURIComponent(target); a.textContent = 'WhatsApp'; f.window.document.querySelector('form').append(a);
    assert.equal(f.adapter.shareSource(f.adapter.dialog('Share')), source);
  } finally { f.close(); }
});
test('a loading permalink viewer is allowed to finish before finding Share', async () => {
  const f = await fixture(); try {
    const original = f.window.document.querySelector('button'); f.window.document.body.innerHTML = '<div role="dialog"><h2>Example’s post</h2><span role="status">Loading…</span></div>';
    setTimeout(() => { f.window.document.querySelector('[role=dialog]').append(original); }, 5);
    assert.equal((await f.adapter.openShare()).identity.name, actor.name);
  } finally { f.close(); }
});
