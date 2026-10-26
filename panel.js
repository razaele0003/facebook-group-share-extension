import { initialState, normalizePostUrl, groupKey, identityKey, ledgerKey, BLOCKED } from './core.js';
const $ = id => document.getElementById(id);
let state = initialState(), selected = new Set(), revision = null, busy = false, countdown;
const api = globalThis.chrome;
const statusLabels = { queued: 'Queued', preparing: 'Preparing', submitting: 'Submitting', posted: 'Posted', pending: 'Pending approval', failed: 'Not submitted', uncertain: 'Check Facebook', running: 'Running', paused: 'Paused', stopped: 'Stopped', completed: 'Completed' };
const element = (tag, cls, value) => { const node = document.createElement(tag); if (cls) node.className = cls; if (value != null) node.textContent = value; return node; };
const locked = () => busy || !!state.operation || ['running', 'paused'].includes(state.batch?.status);
const blocked = group => BLOCKED.has(state.ledger[ledgerKey(state.discovery.sourceUrl, state.discovery.identity, group)]?.status);
const available = () => (state.discovery?.groups ?? []).filter(g => !g.ambiguous && !blocked(g));
const matchesSearch = group => group.name.toLowerCase().includes($('groupSearch').value.toLowerCase().trim()) || (group.id ?? '').includes($('groupSearch').value.trim());
function showError(error) { $('error').textContent = error.message || String(error); $('error').hidden = false; $('error').focus(); }
function clearError() { $('error').hidden = true; }
async function send(type, data = {}) {
  const response = await api.runtime.sendMessage({ type, ...data });
  if (!response?.ok) throw new Error(response?.error || 'The extension did not respond. Close and reopen the panel.');
  if (response.state) render(response.state);
  return response.state;
}
function renderGroups() {
  const root = $('groupList');
  if (!state.discovery) {
    const empty = element('div', 'empty'); empty.append(element('span', 'empty-symbol', '◎'), element('strong', '', 'Your communities go here'), element('p', '', 'Choose a post and find the groups available to your current Page or profile.'));
    root.replaceChildren(empty); return;
  }
  root.replaceChildren();
  const groups = state.discovery.groups.filter(matchesSearch);
  if (!groups.length) { root.append(element('p', 'empty', 'No matching groups.')); return; }
  const favorites = new Set(state.favorites[identityKey(state.discovery.identity)] ?? []);
  for (const group of groups) {
    const key = groupKey(group), row = element('div', 'group-row');
    const input = document.createElement('input'); input.type = 'checkbox'; input.id = `g-${root.childElementCount}`; input.checked = selected.has(key); input.disabled = locked() || group.ambiguous || blocked(group);
    input.addEventListener('change', () => { if (input.checked) selected.add(key); else selected.delete(key); updateSummary(); });
    const label = element('label'); label.htmlFor = input.id; label.append(element('span', '', group.name));
    label.append(element('small', '', group.privacy));
    if (group.url) { const a = element('a', '', `/groups/${group.id}`); a.href = group.url; a.target = '_blank'; a.rel = 'noreferrer'; a.addEventListener('click', event => event.stopPropagation()); label.append(a); }
    if (group.ambiguous || blocked(group)) label.append(element('small', 'blocked', group.ambiguous ? 'Ambiguous group—cannot select' : 'Already submitted or uncertain—check Facebook'));
    const star = element('button', 'favorite'); star.type = 'button'; star.setAttribute('aria-label', `${favorites.has(key) ? 'Remove' : 'Save'} ${group.name} ${favorites.has(key) ? 'from' : 'to'} favorites`); star.setAttribute('aria-pressed', String(favorites.has(key)));
    // Static local SVG; no page-derived HTML is inserted into the extension.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.7'); path.setAttribute('fill', favorites.has(key) ? 'currentColor' : 'none'); svg.append(path); star.append(svg);
    star.disabled = busy;
    star.addEventListener('click', () => { void send('FAVORITE', { group: key, enabled: !favorites.has(key) }).catch(showError); });
    row.append(input, label, star); root.append(row);
  }
}
function sourceMatches() { try { return state.discovery?.sourceUrl === normalizePostUrl($('sourceUrl').value); } catch { return false; } }
function updateSummary() {
  $('selectedCount').textContent = `${selected.size} selected`;
  $('reviewBatch').disabled = locked() || !selected.size || !sourceMatches();
  $('footerSummary').textContent = state.operation?.type === 'discover' ? 'Finding groups in your Facebook tab…' : state.batch?.status === 'running' ? 'Sharing your reviewed batch. You can pause at any time.' : selected.size ? `${selected.size} group${selected.size === 1 ? '' : 's'} selected for this post.` : 'Choose a post and select your groups.';
}
function renderBatch() {
  const batch = state.batch; $('batchSection').hidden = !batch;
  if (!batch) return;
  $('batchStatus').textContent = statusLabels[batch.status] || batch.status;
  $('batchMessage').textContent = batch.message;
  $('batchProgress').max = batch.items.length;
  $('batchProgress').value = batch.items.filter(i => ['posted', 'pending', 'uncertain', 'failed'].includes(i.status)).length;
  $('pauseBatch').hidden = batch.status !== 'running'; $('resumeBatch').hidden = batch.status !== 'paused'; $('resumeBatch').disabled = !!state.operation;
  $('stopBatch').hidden = !['running', 'paused'].includes(batch.status); $('workingTab').disabled = state.workingTabId == null;
  $('results').replaceChildren(...batch.items.map(item => { const li = element('li', 'result'), head = element('div', 'result-header'); head.append(element('strong', '', item.group.name), element('span', `status ${item.status}`, statusLabels[item.status])); li.append(head, element('p', 'help', item.detail)); return li; }));
  const updateCountdown = () => { const remaining = Math.max(0, Math.ceil((batch.nextAt - Date.now()) / 1000)); $('nextShare').textContent = batch.status === 'running' && !state.operation && remaining > 0 ? `Next group in ${remaining}s.` : ''; };
  clearInterval(countdown); updateCountdown();
  if (batch.status === 'running' && batch.nextAt > Date.now()) countdown = setInterval(updateCountdown, 1000);
}
function render(next) {
  state = next;
  if (revision !== state.discovery?.revision) { revision = state.discovery?.revision; selected.clear(); if (state.discovery) $('sourceUrl').value = state.discovery.sourceUrl; }
  $('identity').hidden = !state.discovery;
  if (state.discovery) { $('actorName').textContent = state.discovery.identity.name; $('actorInitial').textContent = state.discovery.identity.name.slice(0, 1).toUpperCase(); }
  $('notice').hidden = !state.notice; $('notice').textContent = state.notice;
  $('findGroups').disabled = locked(); $('currentPost').disabled = locked(); $('sourceUrl').disabled = locked(); $('caption').disabled = locked();
  $('findGroups').textContent = state.operation?.type === 'discover' ? 'Finding groups…' : 'Find groups →';
  for (const id of ['selectVisible', 'selectFavorites', 'clearSelection']) $(id).disabled = locked() || !state.discovery;
  $('groupsStep').classList.toggle('active', !!state.discovery); $('reviewStep').classList.toggle('active', !!state.batch);
  $('stopDiscovery').hidden = state.operation?.type !== 'discover';
  renderGroups(); renderBatch(); updateSummary();
}
async function task(action) { clearError(); busy = true; render(state); try { await action(); } catch (error) { showError(error); } finally { busy = false; render(state); } }
$('currentPost').addEventListener('click', () => task(async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const url = normalizePostUrl(tab?.url); $('sourceUrl').value = url; updateSummary();
}));
$('findGroups').addEventListener('click', async () => {
  clearError(); let sourceUrl;
  try { sourceUrl = normalizePostUrl($('sourceUrl').value); } catch (error) { showError(error); return; }
  // Permission request starts directly from this user gesture; no background request.
  const granted = await api.permissions.request({ origins: ['https://www.facebook.com/*'] }).catch(error => { showError(error); return false; });
  if (!granted) { showError(new Error('Facebook access is required to prepare your shares.')); return; }
  await task(() => send('DISCOVER', { sourceUrl }));
});
$('groupSearch').addEventListener('input', renderGroups);
$('sourceUrl').addEventListener('input', updateSummary);
$('caption').addEventListener('input', () => { $('captionCount').textContent = `${$('caption').value.length.toLocaleString()} / 5,000`; });
$('selectVisible').addEventListener('click', () => { available().filter(matchesSearch).forEach(g => selected.add(groupKey(g))); render(state); });
$('selectFavorites').addEventListener('click', () => { const favorites = new Set(state.favorites[identityKey(state.discovery.identity)] ?? []); available().filter(g => favorites.has(groupKey(g))).forEach(g => selected.add(groupKey(g))); render(state); });
$('clearSelection').addEventListener('click', () => { selected.clear(); render(state); });
$('reviewBatch').addEventListener('click', () => {
  clearError(); if (locked() || !sourceMatches()) return;
  const groups = state.discovery.groups.filter(g => selected.has(groupKey(g)));
  $('reviewActor').textContent = state.discovery.identity.name; $('reviewSource').href = state.discovery.sourceUrl;
  $('reviewCaption').textContent = $('caption').value || 'No additional caption'; $('reviewGroupCount').textContent = `${groups.length} selected group${groups.length === 1 ? '' : 's'}`;
  $('reviewGroups').replaceChildren(...groups.map(g => { const li = element('li', '', g.name); if (g.id) li.append(element('small', '', `/groups/${g.id}`)); return li; }));
  $('startBatch').textContent = `Start sharing to ${groups.length} group${groups.length === 1 ? '' : 's'}`;
  $('reviewDialog').showModal();
});
$('editBatch').addEventListener('click', () => $('reviewDialog').close());
$('startBatch').addEventListener('click', async () => {
  if (busy) return;
  $('startBatch').disabled = true;
  const payload = { revision: state.discovery?.revision, groups: [...selected], caption: $('caption').value };
  $('reviewDialog').close();
  await task(() => send('START', payload)); $('startBatch').disabled = false;
});
for (const [id, action] of [['pauseBatch', 'pause'], ['resumeBatch', 'resume'], ['stopBatch', 'stop'], ['stopDiscovery', 'stop']]) $(id).addEventListener('click', () => { clearError(); void send('CONTROL', { action }).catch(showError); });
$('workingTab').addEventListener('click', async () => { try { const tab = await api.tabs.update(state.workingTabId, { active: true }); await api.windows.update(tab.windowId, { focused: true }); } catch (error) { showError(error); } });
if (api?.runtime?.id) {
  api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.state?.newValue) render(changes.state.newValue); });
  void send('GET_STATE').catch(showError);
} else { render(state); showError(new Error('Load this folder as a Chrome extension, then open it from the toolbar.')); }
