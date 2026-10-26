/* DOM-only Facebook adapter. No private APIs, cookies, or network requests. */
(() => {
  if (globalThis.GroupShareAdapter) return;
  const clean = value => String(value ?? '').replace(/[\u200B-\u200F\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  const text = el => clean(el?.innerText ?? el?.textContent);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fail = (message, code = 'PREPARATION') => Object.assign(new Error(message), { code });
  const key = group => group.id ? `id:${group.id}` : `name:${clean(group.name).toLowerCase()}:${clean(group.privacy).toLowerCase()}`;
  const fingerprint = src => { try { const u = new URL(src); return u.pathname; } catch { return ''; } };

  class Adapter {
    constructor(doc = document, options = {}) {
      this.doc = doc; this.win = doc.defaultView; this.cancelled = false; this.submitted = false;
      this.timeout = options.timeout ?? 20_000; this.settle = options.settle ?? 700;
      this.isVisible = options.isVisible ?? (el => !!el && !el.closest('[aria-hidden="true"],[hidden],[inert]') && el.getClientRects().length > 0 && this.win.getComputedStyle(el).visibility !== 'hidden');
    }
    guard() {
      if (this.cancelled) throw fail('Stopped before the next action.', 'CANCELLED');
      if (/\/(?:login|checkpoint|challenge|two_step_verification)(?:\/|\.|$)/.test(this.win.location.pathname) || this.doc.querySelector('input[type="password"]')) throw fail('Facebook needs you to sign in or complete a challenge.', 'BLOCKED');
      const surfaces = [...this.doc.querySelectorAll('[role="alert"],[role="dialog"]')].filter(this.isVisible);
      if (surfaces.some(el => /temporarily blocked|you.can.t use this feature|going too fast|suspended|confirm your identity|security check|try again later|we limit how often/i.test(text(el)))) throw fail('Facebook displayed a restriction or security check. Review the working tab.', 'BLOCKED');
    }
    async wait(fn, description, timeout = this.timeout) {
      const end = Date.now() + timeout;
      while (Date.now() < end) { this.guard(); const value = fn(); if (value) return value; await sleep(Math.min(150, this.settle)); }
      throw fail(`Could not verify ${description}. Review the working tab; Facebook’s layout may have changed.`, 'TIMEOUT');
    }
    all(selector, root = this.doc) { return [...root.querySelectorAll(selector)].filter(this.isVisible); }
    title(dialog) { return this.all('h1,h2,[role="heading"]', dialog).map(text); }
    dialog(title) {
      // Facebook sometimes nests a header-only dialog inside the composer shell.
      // Choose the smallest matching shell that also contains the editable surface.
      const required = title === 'Share to a group' ? '[role="combobox"],[role="list"]' : '[contenteditable="true"][role="textbox"],textarea';
      const shells = this.all('[role="dialog"]').filter(el => this.title(el).includes(title) && this.all(required, el).length);
      const found = shells.filter(el => !shells.some(other => el !== other && el.contains(other)));
      if (found.length > 1) throw fail(`Multiple ${title} dialogs are visible.`);
      return found[0];
    }
    button(label, root = this.doc) {
      const found = this.all('button,[role="button"]', root).filter(el => (clean(el.getAttribute('aria-label')) || text(el)) === label);
      if (found.length > 1) throw fail(`More than one “${label}” control is visible.`);
      return found[0];
    }
    click(el) {
      this.guard();
      if (!el || !this.isVisible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') throw fail('A required Facebook control is unavailable.');
      el.click();
    }
    editor(dialog) {
      const editors = this.all('[contenteditable="true"][role="textbox"],textarea', dialog).filter(el => /say something|create a (?:public )?post|write something|what.s on your mind/i.test(el.getAttribute('aria-label') || el.getAttribute('aria-placeholder') || el.getAttribute('placeholder') || ''));
      if (editors.length !== 1) throw fail('Could not identify one native post caption field.');
      return editors[0];
    }
    identity(dialog) {
      const editor = this.editor(dialog);
      // Read only header text before the editor, never the author of the shared attachment.
      const walker = this.doc.createTreeWalker(dialog, this.win.NodeFilter.SHOW_TEXT);
      const lines = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (editor.contains(node) || (node.compareDocumentPosition(editor) & this.win.Node.DOCUMENT_POSITION_PRECEDING)) break;
        if (!this.isVisible(node.parentElement)) continue;
        const value = clean(node.textContent);
        if (value && !/^(Share|Create post|Public group|Private group|Public|Friends|Feed|Only me|Back|Close|Share to a group)$/.test(value)) lines.push(value);
      }
      const name = lines[0];
      if (!name || name.length > 150) throw fail('The posting identity could not be read from the composer header.');
      const images = this.all('svg image,img', dialog).filter(el => !!(el.compareDocumentPosition(editor) & this.win.Node.DOCUMENT_POSITION_FOLLOWING));
      const avatar = images[0];
      const src = avatar?.getAttribute('href') || avatar?.getAttribute('xlink:href') || avatar?.getAttribute('src');
      const identity = { name, fingerprint: fingerprint(src) };
      if (!identity.fingerprint) throw fail('The posting identity’s avatar could not be verified.');
      return identity;
    }
    assertActor(expected, dialog) {
      const actual = this.identity(dialog);
      if (!expected || actual.name !== expected.name || actual.fingerprint !== expected.fingerprint) throw fail('Posting identity changed. Find groups again and review the active Page or profile.', 'IDENTITY');
      return actual;
    }
    async openShare() {
      this.guard();
      const existing = this.dialog('Share');
      if (existing) {
        if (text(this.editor(existing))) throw fail('The Share dialog contains an existing draft. Close it yourself before checking this post.');
        return { dialog: existing, identity: this.identity(existing) };
      }
      const shareButtons = root => this.all('button,[role="button"]', root).filter(el => /^Share(?:, send this to friends or post it on your profile\.)?$/.test(clean(el.getAttribute('aria-label')) || text(el)));
      let dialogs = this.all('[role="dialog"]');
      if (dialogs.some(el => this.title(el).some(title => /^(?:Post|.+['’]s post)$/i.test(title))) && !dialogs.some(el => shareButtons(el).length)) {
        await this.wait(() => this.all('[role="dialog"]').some(el => shareButtons(el).length), 'the permalink post viewer to finish loading');
        dialogs = this.all('[role="dialog"]');
      }
      let sourceRoot = this.doc;
      if (dialogs.length) {
        // Shared permalink URLs often open the requested post in a modal above a profile feed.
        const viewers = dialogs.filter(el => shareButtons(el).length === 1 && !this.all('[contenteditable="true"],textarea', el).some(e => /say something|create a (?:public )?post|write something|what.s on your mind/i.test(e.getAttribute('aria-label') || e.getAttribute('aria-placeholder') || '')));
        const innermost = viewers.filter(el => !viewers.some(other => other !== el && el.contains(other)));
        if (innermost.length !== 1 || dialogs.some(el => !el.contains(innermost[0]) && !innermost[0].contains(el))) throw fail('An unexpected dialog is already open in the working tab. Close it before checking the post.');
        sourceRoot = innermost[0];
      }
      const share = await this.wait(() => {
        const candidates = shareButtons(sourceRoot);
        if (candidates.length > 1) throw fail('Several posts are visible. Use an individual post permalink.');
        return candidates[0];
      }, 'the source post’s Share button');
      this.click(share);
      const dialog = await this.wait(() => this.dialog('Share'), 'the native Share dialog');
      await this.wait(() => this.button('Share to a group', dialog), 'the Share to a group control');
      const identity = this.identity(dialog);
      return { dialog, identity };
    }
    async openPicker(dialog) {
      this.click(this.button('Share to a group', dialog));
      const picker = await this.wait(() => this.dialog('Share to a group'), 'the group picker');
      await this.wait(() => this.rows(picker).length || /no groups|no results/i.test(text(picker)), 'the available groups');
      return picker;
    }
    rows(picker) {
      return this.all('button,[role="button"]', picker).flatMap(row => {
        const raw = row.innerText ?? row.textContent ?? '';
        const privacy = clean(raw.match(/(?:Public|Private) group/i)?.[0]);
        if (!privacy) return [];
        if (row.querySelector('button,[role="button"]')) return [];
        const link = [...row.querySelectorAll('a[href]')].find(a => /\/groups\/[^/?#]+/.test(a.getAttribute('href')));
        let id = null;
        if (link) { try { const url = new URL(link.getAttribute('href'), this.win.location.href); if (url.origin === 'https://www.facebook.com') id = url.pathname.match(/^\/groups\/([\w.\-]+)\/?$/)?.[1] ?? null; } catch {} }
        const name = clean(raw.replace(/(?:Public|Private) group\s*$/i, ''));
        if (!name) return [];
        // Name-only rows cannot be distinguished reliably across virtualized pages.
        const group = { id, name, privacy, url: id ? `https://www.facebook.com/groups/${id}/` : null, ambiguous: !id };
        return [{ row, group }];
      });
    }
    scroller(picker) {
      const list = this.all('[role="list"],ul', picker).find(el => el.querySelector('[role="button"],button'));
      for (let el = list; el && picker.contains(el); el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight + 5 && /(auto|scroll)/.test(this.win.getComputedStyle(el).overflowY)) return el;
      }
      return this.all('*', picker).filter(el => el.scrollHeight > el.clientHeight + 5 && /(auto|scroll)/.test(this.win.getComputedStyle(el).overflowY)).sort((a, b) => b.clientHeight - a.clientHeight)[0] ?? picker;
    }
    async scan(picker, find = null) {
      const groups = new Map(); const scroller = this.scroller(picker);
      scroller.scrollTop = 0; await sleep(this.settle);
      let stable = 0; let previousCount = -1;
      for (let round = 0; round < 250; round++) {
        this.guard();
        if (!this.dialog('Share to a group')) throw fail('The group picker closed unexpectedly.');
        const rows = this.rows(picker);
        const names = new Map();
        for (const entry of rows) {
          const k = key(entry.group); names.set(k, (names.get(k) ?? 0) + 1);
          const existing = groups.get(k);
          groups.set(k, { ...entry.group, ambiguous: entry.group.ambiguous || existing?.ambiguous || (!entry.group.id && names.get(k) > 1) });
        }
        if (find) {
          const matches = rows.filter(entry => key(entry.group) === key(find));
          if (matches.length > 1 || find.ambiguous) throw fail('The selected group is ambiguous.');
          if (matches.length === 1) { this.click(matches[0].row); return matches[0].group; }
        }
        const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5;
        stable = atEnd && groups.size === previousCount ? stable + 1 : 0;
        if (stable >= 3) {
          if (find) throw fail(`Group no longer available: ${find.name}.`);
          return [...groups.values()];
        }
        previousCount = groups.size;
        scroller.scrollTop = Math.min(scroller.scrollTop + Math.max(180, scroller.clientHeight * 0.75), scroller.scrollHeight);
        scroller.dispatchEvent(new this.win.Event('scroll', { bubbles: true }));
        await sleep(this.settle);
      }
      throw fail('Group discovery did not reach the end. No incomplete group list was saved.');
    }
    preview() {
      const postViewer = this.all('[role="dialog"]').find(el => this.all('button,[role="button"]', el).some(b => /^Share(?:, send this to friends or post it on your profile\.)?$/.test(clean(b.getAttribute('aria-label')) || text(b))));
      const root = postViewer ?? this.doc.querySelector('[role="complementary"],aside,[role="main"],main') ?? this.doc.body;
      const message = root.querySelector('[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-ad-rendering-role="story_message"]') ?? this.all('[dir="auto"]', root).find(el => text(el).length >= 25 && !el.closest('button,[role="button"],a,h1,h2,h3,h4,[role="heading"],[contenteditable="true"]') && !el.querySelector('button,[role="button"],a,[contenteditable="true"]'));
      return { text: text(message).slice(0, 500), title: this.doc.title || 'Facebook post' };
    }
    shareSource(dialog) {
      // Read a permalink already exposed by the visible Share sheet. Never call a private API.
      for (const link of this.all('a[href]', dialog)) {
        try {
          let target = new URL(link.getAttribute('href'), this.win.location.href);
          if (target.hostname === 'l.facebook.com' && target.searchParams.has('u')) target = new URL(target.searchParams.get('u'));
          if (target.hostname !== 'wa.me' && target.hostname !== 'api.whatsapp.com') continue;
          let value = target.searchParams.get('text') || '';
          for (let i = 0; i < 3 && !value.startsWith('https://'); i++) value = decodeURIComponent(value);
          const candidate = new URL(value);
          if (candidate.origin === 'https://www.facebook.com') return candidate.href;
        } catch { /* Ignore unrelated or malformed share targets. */ }
      }
      return this.win.location.href;
    }
    async inspectPost() {
      const preview = this.preview();
      const { dialog, identity } = await this.openShare();
      const sourceUrl = this.shareSource(dialog);
      this.click(this.button('Close', dialog));
      return { identity, preview, sourceUrl, pageUrl: this.win.location.href };
    }
    accountFingerprint() {
      const accounts = this.all('button[aria-label],[role="button"][aria-label]').filter(el => /^Account(?:,|$)/.test(clean(el.getAttribute('aria-label'))));
      if (accounts.length !== 1) throw fail('Could not identify the active Facebook account.');
      const avatar = accounts[0].querySelector('svg image,img');
      const value = fingerprint(avatar?.getAttribute('href') || avatar?.getAttribute('xlink:href') || avatar?.getAttribute('src'));
      if (!value) throw fail('The active account’s avatar could not be verified.');
      return value;
    }
    joinedRoot() {
      if (!/^\/groups\/joins\/?$/.test(this.win.location.pathname)) throw fail('Open Facebook → Groups → Your groups, then choose Import from this page.');
      const roots = this.all('main,[role="main"]').filter(el => this.all('h1,h2,h3,[role="heading"]', el).some(h => /^All groups you['’]ve joined/i.test(text(h))));
      const root = roots.find(el => !roots.some(other => el !== other && el.contains(other)));
      if (!root) throw fail('Could not locate All groups you’ve joined. Use the full Your groups page.');
      return root;
    }
    joinedRows(root) {
      const found = new Map();
      for (const link of this.all('a[href]', root)) {
        let url; try { url = new URL(link.getAttribute('href'), this.win.location.href); } catch { continue; }
        const id = url.origin === 'https://www.facebook.com' && url.pathname.match(/^\/groups\/([\w.\-]+)\/?$/)?.[1];
        if (!id || ['joins', 'feed', 'discover', 'create'].includes(id.toLowerCase())) continue;
        const name = text(link) || clean(link.getAttribute('aria-label')) || clean(link.querySelector('img')?.getAttribute('alt'));
        if (!name || /^(View group|Visit group|See all|Group photo|Profile photo of group.*)$/i.test(name)) continue;
        if (!found.has(id)) found.set(id, { id, name, privacy: 'Joined group', url: `https://www.facebook.com/groups/${id}/`, ambiguous: false });
      }
      return [...found.values()];
    }
    joinedScroller(root) {
      for (let el = root; el; el = el.parentElement) if (el.scrollHeight > el.clientHeight + 5 && /(auto|scroll)/.test(this.win.getComputedStyle(el).overflowY)) return el;
      return this.doc.scrollingElement ?? this.doc.documentElement;
    }
    async importJoined() {
      this.guard(); const root = this.joinedRoot(), owner = this.accountFingerprint(), scroller = this.joinedScroller(root), originalTop = scroller.scrollTop;
      const groups = new Map(); let stable = 0, previous = -1;
      const expectedCount = () => {
        const heading = this.all('h1,h2,h3,[role="heading"]', root).map(text).find(v => /^All groups you['’]ve joined/i.test(v));
        const count = heading?.match(/\(([\d,]+)\)/)?.[1]; return count == null ? null : Number(count.replaceAll(',', ''));
      };
      try {
        for (let round = 0; round < 250; round++) {
          this.guard();
          if (!root.isConnected || this.joinedRoot() !== root) throw fail('The Your groups page changed during import. Try again.');
          if (this.accountFingerprint() !== owner) throw fail('The active Page or profile changed during import. Import the list again.', 'IDENTITY');
          for (const group of this.joinedRows(root)) groups.set(group.id, group);
          const expected = expectedCount(), atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5;
          stable = groups.size === previous ? stable + 1 : 0;
          if ((expected !== null && groups.size === expected && stable >= 1) || (atEnd && stable >= 3)) {
            if (expected !== null && groups.size !== expected) throw fail(`Facebook lists ${expected} joined groups, but only ${groups.size} could be read. The incomplete list was not saved.`);
            return { groups: [...groups.values()], fingerprint: owner, pageUrl: this.win.location.href, count: groups.size };
          }
          previous = groups.size;
          scroller.scrollTop = Math.min(scroller.scrollTop + Math.max(200, scroller.clientHeight * .75), scroller.scrollHeight);
          scroller.dispatchEvent(new this.win.Event('scroll', { bubbles: true }));
          await sleep(this.settle);
        }
        throw fail('The joined-group list did not finish loading. No incomplete list was saved.');
      } finally { if (scroller.isConnected) scroller.scrollTop = originalTop; }
    }
    async discover() {
      const preview = this.preview();
      const { dialog, identity } = await this.openShare();
      const sourceUrl = this.shareSource(dialog);
      const picker = await this.openPicker(dialog);
      const groups = await this.scan(picker);
      this.click(this.button('Close', picker));
      return { identity, groups, preview, sourceUrl, pageUrl: this.win.location.href };
    }
    verifyAttachment(dialog, source, preview) {
      const url = new URL(source);
      const token = url.searchParams.get('fbid') || url.searchParams.get('story_fbid') || url.searchParams.get('v') || url.pathname.split('/').filter(Boolean).at(-1);
      const attached = this.all('a[href]', dialog).some(el => {
        try { const u = new URL(el.getAttribute('href'), this.win.location.href); return u.origin === url.origin && (u.searchParams.get('fbid') === token || u.searchParams.get('story_fbid') === token || u.searchParams.get('v') === token || u.pathname.split('/').includes(token)); } catch { return false; }
      });
      const snippet = clean(preview?.text).slice(0, 60);
      const attachmentOnly = dialog.cloneNode(true);
      attachmentOnly.querySelectorAll('[contenteditable="true"],textarea').forEach(el => el.remove());
      if (!attached && !(snippet.length >= 25 && text(attachmentOnly).includes(snippet))) throw fail('Could not verify that the original post is attached. No share was submitted.');
    }
    async setCaption(dialog, caption) {
      const editor = this.editor(dialog);
      if (text(editor)) throw fail('The native composer already contains text. No existing draft will be replaced.');
      if (!caption) return;
      editor.focus();
      if (editor.tagName === 'TEXTAREA') {
        Object.getOwnPropertyDescriptor(this.win.HTMLTextAreaElement.prototype, 'value').set.call(editor, caption);
        editor.dispatchEvent(new this.win.Event('input', { bubbles: true }));
      } else {
        const selection = this.win.getSelection(); const range = this.doc.createRange(); range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range);
        // insertText goes through the browser editing pipeline used by Facebook’s Lexical editor.
        if (!this.doc.execCommand('insertText', false, caption)) throw fail('Facebook did not accept caption entry.');
      }
      await this.wait(() => clean(editor.value ?? editor.innerText ?? editor.textContent) === clean(caption), 'the entered caption');
    }
    async prepare({ identity, group, caption, sourceUrl, preview }) {
      const { dialog: share, identity: actor } = await this.openShare();
      if (actor.name !== identity.name || actor.fingerprint !== identity.fingerprint) throw fail('Posting identity changed. Find groups again.', 'IDENTITY');
      const picker = await this.openPicker(share);
      await this.scan(picker, group);
      const composer = await this.wait(() => this.dialog('Create post'), 'the group’s Create post composer');
      await this.wait(() => { try { return this.editor(composer); } catch { return false; } }, 'the post caption field');
      this.assertActor(identity, composer); this.verifyAttachment(composer, sourceUrl, preview);
      await this.setCaption(composer, caption);
      await this.wait(() => { const b = this.button('Post', composer); return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b; }, 'the enabled Post button');
      return { composer, identity: this.assertActor(identity, composer) };
    }
    observeResult() {
      const selector = '[role="alert"],[role="status"],[aria-live="polite"],[aria-live="assertive"]';
      const previous = new Map([...this.doc.querySelectorAll(selector)].map(el => [el, text(el)]));
      let result = null;
      const inspect = el => {
        if (!this.isVisible(el) || previous.get(el) === text(el)) return;
        const value = text(el); if (value.length > 800) return;
        if (/pending (?:admin |administrator )?approval|submitted (?:to|for).*(?:admin|review|approval)|waiting for (?:admin |administrator )?approval/i.test(value)) result = { status: 'pending', detail: value };
        else if (/your post (?:has been |was )?(?:published|shared)|post (?:has been )?successfully (?:published|shared)|you shared (?:a|this|the) post/i.test(value) && result?.status !== 'pending') result = { status: 'posted', detail: value };
        else if (/couldn.t (?:share|publish)|unable to (?:share|publish)|something went wrong/i.test(value)) result = { status: 'uncertain', detail: value + ' Check Facebook before taking further action.' };
      };
      const observer = new this.win.MutationObserver(records => {
        for (const record of records) {
          const el = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          const parent = el?.closest(selector); if (parent) inspect(parent);
          for (const node of record.addedNodes) if (node.nodeType === 1) {
            if (node.matches(selector)) inspect(node);
            node.querySelectorAll(selector).forEach(inspect);
          }
        }
      });
      observer.observe(this.doc.body, { subtree: true, childList: true, characterData: true });
      return { get: () => result, close: () => observer.disconnect() };
    }
    async submit(data, authorize) {
      const { composer } = await this.prepare(data);
      this.guard(); this.assertActor(data.identity, composer); this.verifyAttachment(composer, data.sourceUrl, data.preview);
      const observer = this.observeResult();
      try {
        const permission = await authorize(this.identity(composer));
        if (!permission?.authorized) throw fail(permission?.error || 'Submission was paused or stopped.', 'CANCELLED');
        this.guard(); this.assertActor(data.identity, composer);
        const post = this.button('Post', composer);
        this.submitted = true; // After authorization, any failure is conservatively uncertain.
        this.click(post);
        const end = Date.now() + this.timeout;
        while (Date.now() < end) {
          // A Stop cannot undo an in-flight submission; still collect its confirmation.
          if (observer.get()) return observer.get();
          if (!this.cancelled) this.guard();
          await sleep(Math.min(this.settle, 200));
        }
        return { status: 'uncertain', detail: 'Facebook did not show a fresh confirmation. Check the working tab; this group will not be retried.' };
      } catch (error) {
        if (this.submitted) return { status: 'uncertain', detail: error.message };
        throw error;
      } finally { observer.close(); }
    }
  }
  globalThis.GroupShareAdapter = Adapter;
  if (globalThis.chrome?.runtime?.onMessage && globalThis.location?.origin === 'https://www.facebook.com') {
    let active = null;
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (sender.id !== chrome.runtime.id || !message?.gsa) return;
      if (message.type === 'CANCEL') { if (active) active.cancelled = true; reply({ ok: true }); return; }
      if (active) { reply({ ok: false, error: 'A native Facebook operation is already running.' }); return; }
      active = new Adapter();
      const current = active;
      const action = message.type === 'IMPORT_JOINED' ? current.importJoined() : message.type === 'INSPECT_POST' ? current.inspectPost() : message.type === 'DISCOVER' ? current.discover() : message.type === 'SHARE' ? current.submit(message.data, identity => chrome.runtime.sendMessage({ type: 'AUTHORIZE_SUBMIT', operationId: message.operationId, batchId: message.batchId, itemId: message.itemId, attempt: message.attempt, identity })) : Promise.reject(fail('Unknown adapter action.'));
      action.then(data => reply({ ok: true, data }), error => reply({ ok: false, error: error.message, code: error.code })).finally(() => { active = null; });
      return true;
    });
  }
})();
