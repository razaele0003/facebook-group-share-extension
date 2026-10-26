export const ORIGIN = 'https://www.facebook.com';
export const INTERVAL = 30_000;
export const BLOCKED = new Set(['posted', 'pending', 'uncertain', 'submitting']);
export const clean = value => String(value ?? '').replace(/[\u200B-\u200F\uFEFF]/g, '').replace(/\s+/g, ' ').trim();

export function normalizePostUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('Paste a complete Facebook post link.'); }
  if (url.origin !== ORIGIN || url.username || url.password) throw new Error('Use a https://www.facebook.com post link.');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const keep = new URL(ORIGIN + path);
  if (/^\/photo(?:\.php)?$/.test(path) && /^\d+$/.test(url.searchParams.get('fbid') ?? '')) keep.searchParams.set('fbid', url.searchParams.get('fbid'));
  else if (/^\/(?:story|permalink)\.php$/.test(path) && /^[\w]+$/.test(url.searchParams.get('story_fbid') ?? '') && /^\d+$/.test(url.searchParams.get('id') ?? '')) {
    keep.searchParams.set('story_fbid', url.searchParams.get('story_fbid')); keep.searchParams.set('id', url.searchParams.get('id'));
  } else if (/^\/(?:[\w.\-]+\/posts\/[\w]+|groups\/[\w.\-]+\/(?:posts|permalink)\/\w+|share\/[prv]\/\w+|reel\/\d+|[\w.\-]+\/videos\/\d+)$/.test(path)) { /* permalink */ }
  else if (path === '/watch' && /^\d+$/.test(url.searchParams.get('v') ?? '')) keep.searchParams.set('v', url.searchParams.get('v'));
  else throw new Error('Open an individual post, photo, video, or reel first. Feed and profile links are not post links.');
  return keep.href;
}

export function groupKey(group) {
  if (group.id && /^[\w.\-]+$/.test(group.id)) return `id:${group.id}`;
  return `name:${clean(group.name).toLocaleLowerCase('en')}:${clean(group.privacy).toLowerCase()}`;
}
export const identityKey = actor => `${clean(actor?.name)}|${clean(actor?.fingerprint)}`;
export function assertIdentity(expected, actual) {
  if (!expected?.name || !expected?.fingerprint || !actual?.name || !actual?.fingerprint || identityKey(expected) !== identityKey(actual)) {
    throw new Error('Posting identity changed or could not be verified. Find groups again and review the active identity.');
  }
}
export const ledgerKey = (source, actor, group) => JSON.stringify([source, identityKey(actor), groupKey(group)]);

export function initialState() {
  return { schema: 1, discovery: null, batch: null, ledger: {}, favorites: {}, workingTabId: null, operation: null, notice: '' };
}
export function createBatch(discovery, keys, caption, ledger, now = Date.now(), id = crypto.randomUUID()) {
  if (!discovery?.identity?.fingerprint) throw new Error('Find groups to verify the posting identity first.');
  if (!Array.isArray(keys) || !keys.length) throw new Error('Select at least one group.');
  if (typeof caption !== 'string' || caption.length > 5000) throw new Error('Keep the caption within 5,000 characters.');
  const unique = [...new Set(keys)];
  const items = unique.map(key => {
    const matches = discovery.groups.filter(group => groupKey(group) === key);
    if (matches.length !== 1 || matches[0].ambiguous) throw new Error('A selected group is ambiguous or no longer available. Find groups again.');
    const group = matches[0];
    if (BLOCKED.has(ledger[ledgerKey(discovery.sourceUrl, discovery.identity, group)]?.status)) throw new Error(`Already submitted or uncertain: ${group.name}. Check the previous share on Facebook.`);
    return { id: key, group, status: 'queued', detail: '', attempt: null };
  });
  return { id, sourceUrl: discovery.sourceUrl, identity: discovery.identity, preview: discovery.preview, caption, items, status: 'running', createdAt: now, nextAt: now, message: 'Starting your reviewed batch.' };
}
export function recover(state, cold = false) {
  if (!state.batch) { state.operation = null; if (cold) state.workingTabId = null; return state; }
  let interrupted = false;
  for (const item of state.batch.items) {
    if (item.status === 'submitting') {
      item.status = 'uncertain'; item.detail = 'Submission was interrupted. Check Facebook; this group will not be retried.'; interrupted = true;
      state.ledger[ledgerKey(state.batch.sourceUrl, state.batch.identity, item.group)] = { status: 'uncertain', at: Date.now(), batchId: state.batch.id };
    } else if (item.status === 'preparing') { item.status = 'queued'; item.detail = 'Preparation interrupted before submission.'; interrupted = true; }
  }
  if ((cold || interrupted || state.operation) && state.batch.status === 'running') {
    state.batch.status = 'paused'; state.batch.message = cold ? 'Browser restarted. Review progress, then Resume.' : 'An operation was interrupted. Review progress, then Resume.';
  }
  state.operation = null;
  if (cold) state.workingTabId = null;
  return state;
}
export function markIntent(state, item, attempt, now = Date.now()) {
  if (state.batch.status !== 'running' || item.status !== 'preparing' || item.attempt !== attempt) throw new Error('Submission is no longer authorized.');
  const key = ledgerKey(state.batch.sourceUrl, state.batch.identity, item.group);
  if (BLOCKED.has(state.ledger[key]?.status)) throw new Error('Duplicate submission prevented.');
  item.status = 'submitting'; item.detail = 'Submitting. This action may already reach Facebook.';
  state.ledger[key] = { status: 'submitting', at: now, batchId: state.batch.id };
}
export function recordResult(state, item, result, now = Date.now()) {
  if (!['posted', 'pending', 'uncertain'].includes(result.status)) throw new Error('Invalid submission result.');
  item.status = result.status; item.detail = result.detail;
  state.ledger[ledgerKey(state.batch.sourceUrl, state.batch.identity, item.group)] = { status: item.status, at: now, batchId: state.batch.id };
  state.batch.nextAt = now + INTERVAL;
  if (result.status === 'uncertain' && state.batch.status === 'running') { state.batch.status = 'paused'; state.batch.message = 'Result uncertain. Check the working tab before continuing with remaining groups.'; }
}
