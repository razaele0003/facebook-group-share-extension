import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
export const sourceUrl = 'https://www.facebook.com/photo?fbid=123456';
export const actor = { name: 'Example Publishing', fingerprint: '/avatar-a.jpg' };
export const groups = [
  { id: '101', name: 'Local Creators', privacy: 'Public group', url: 'https://www.facebook.com/groups/101/', ambiguous: false },
  { id: '102', name: 'Local Creators', privacy: 'Public group', url: 'https://www.facebook.com/groups/102/', ambiguous: false },
  { id: '103', name: 'Community News', privacy: 'Private group', url: 'https://www.facebook.com/groups/103/', ambiguous: false }
];
export const discovery = () => ({ sourceUrl, identity: actor, groups: structuredClone(groups), preview: { title: 'Example post', text: 'A community update with original attribution.' }, revision: 'revision-a' });
const avatar = '<svg><image href="https://example.invalid/avatar-a.jpg"></image></svg>';
export function shareHtml(name = actor.name) { return `<div role="dialog" aria-label="Share"><h2>Share</h2><form>${avatar}<span>${name}</span><button type="button">Feed</button><button type="button">Public</button><div role="textbox" contenteditable="true" aria-label="Say something about this..."></div><button type="button" aria-label="Share to a group">Group</button></form></div>`; }
export function pickerHtml(list = groups) { return `<div role="dialog"><h2>Share to a group</h2><button aria-label="Close">Close</button><input role="combobox" aria-label="Search for groups"><div role="list">${list.map(g => `<div role="button">${g.id ? `<a href="https://www.facebook.com/groups/${g.id}/"><img alt="${g.name}"></a>` : ''}<span>${g.name}</span><span>${g.privacy}</span></div>`).join('')}</div></div>`; }
export function composerHtml(name = actor.name, attach = true) { return `<div role="dialog"><h2>Create post</h2>${avatar}<span>${name}</span><button disabled>Public group</button><div role="textbox" contenteditable="true" aria-label="Create a public post…"></div><section>${attach ? '<a href="/photo/?fbid=123456">Original photo</a>' : ''}<h2>Original author, different identity</h2></section><button id="post">Post</button></div>`; }
export async function fixture(options = {}) {
  const dom = new JSDOM('<button aria-label="Share, send this to friends or post it on your profile.">Share</button>', { url: sourceUrl, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom; let clicks = 0;
  window.eval(await readFile(new URL('../adapter.js', import.meta.url), 'utf8'));
  const visible = el => !!el && !el.closest('[hidden],[aria-hidden="true"]');
  const adapter = new window.GroupShareAdapter(window.document, { isVisible: visible, timeout: 80, settle: 1 });
  window.document.execCommand = (command, ui, value) => { const el = window.document.activeElement; el.textContent = value; el.dispatchEvent(new window.Event('input', { bubbles: true })); return true; };
  const wireComposer = () => {
    window.document.body.innerHTML = composerHtml(options.composerActor, options.attach !== false);
    window.document.querySelector('#post').onclick = () => {
      clicks++;
      if (options.result) setTimeout(() => { const alert = window.document.createElement('div'); alert.setAttribute('role', 'alert'); alert.textContent = options.result; window.document.body.append(alert); }, 1);
    };
    if (options.stale) { const alert = window.document.createElement('div'); alert.setAttribute('role', 'alert'); alert.textContent = 'Your post has been published'; window.document.body.append(alert); }
  };
  window.document.querySelector('button').onclick = () => {
    window.document.body.innerHTML = shareHtml(options.shareActor);
    window.document.querySelector('[aria-label="Share to a group"]').onclick = () => {
      window.document.body.innerHTML = pickerHtml(options.groups);
      window.document.querySelector('[aria-label="Close"]').onclick = () => { window.document.body.innerHTML = ''; };
      window.document.querySelectorAll('[role="list"] [role="button"]').forEach(row => row.onclick = wireComposer);
    };
  };
  return { dom, window, adapter, clicks: () => clicks, close: () => window.close() };
}
