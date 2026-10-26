import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname, resolve, sep } from 'node:path';
import { initialState } from '../core.js';
import { discovery } from './fixtures.js';
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
test('Chrome panel: group selection, favorites, caption review, queue controls, and narrow/dark layout', { timeout: 60000 }, async () => {
  const server = createServer(async (req, res) => {
    const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!path.startsWith(root + sep) && path !== join(root, 'panel.html')) { res.writeHead(403).end(); return; }
    try { const bytes = await readFile(path); res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] ?? 'application/octet-stream'); res.end(bytes); } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 400, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
    await context.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:') ? route.continue() : route.abort());
    const s = initialState(); s.discovery = discovery();
    await context.addInitScript(saved => {
      const model = structuredClone(saved); window.testMessages = [];
      const api = {
        runtime: { id: 'local-test', sendMessage: async m => {
          window.testMessages.push(m);
          if (m.type === 'FAVORITE') { const actor = `${model.discovery.identity.name}|${model.discovery.identity.fingerprint}`; model.favorites[actor] = m.enabled ? [m.group] : []; }
          if (m.type === 'START') {
            model.batch = { id: 'mock', identity: model.discovery.identity, sourceUrl: model.discovery.sourceUrl, status: 'running', message: 'Preparing selected groups.', nextAt: Date.now(), items: m.groups.map(id => ({ id, group: model.discovery.groups.find(g => `id:${g.id}` === id), status: 'queued', detail: '' })) };
          }
          if (m.type === 'CONTROL') model.batch.status = ({ pause: 'paused', resume: 'running', stop: 'stopped' })[m.action];
          return { ok: true, state: structuredClone(model) };
        } }, storage: { onChanged: { addListener() {} } }, permissions: { request: async () => true }, tabs: { query: async () => [{ url: 'https://www.facebook.com/profile.php?id=1' }], update: async () => ({ windowId: 1 }) }, windows: { update: async () => {} }
      };
      Object.defineProperty(window, 'chrome', { configurable: true, value: api });
    }, s);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/panel.html`);
    await page.getByText('Example Publishing', { exact: true }).waitFor();
    assert.equal(await page.locator('input[type=checkbox]').count(), 3);
    await page.locator('input[type=checkbox]').nth(0).check(); await page.locator('input[type=checkbox]').nth(1).check();
    await page.locator('.favorite').nth(0).click(); await page.locator('.favorite[aria-pressed=true]').waitFor();
    await page.getByLabel('Caption for all selected groups').fill('Hello, communities!');
    await page.getByRole('button', { name: 'Review batch' }).click();
    assert.equal(await page.getByRole('dialog').isVisible(), true);
    assert.equal(await page.locator('#reviewGroups li').count(), 2);
    assert.equal(await page.locator('#reviewCaption').innerText(), 'Hello, communities!');
    await mkdir(join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: join(root, 'test-results', 'review-light.png') });
    await page.getByRole('button', { name: 'Back to edit' }).click();
    for (const width of [320, 400, 600]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `No horizontal overflow at ${width}px`);
    }
    await page.setViewportSize({ width: 400, height: 1000 });
    await page.screenshot({ path: join(root, 'test-results', 'panel-light.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.screenshot({ path: join(root, 'test-results', 'panel-dark.png'), fullPage: true });
    await page.getByRole('button', { name: 'Review batch' }).click();
    await page.getByRole('button', { name: 'Start sharing to 2 groups' }).click();
    await page.getByText('Running', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.testMessages.filter(m => m.type === 'START'))).length, 1);
    await page.getByRole('button', { name: 'Pause', exact: true }).click(); await page.getByRole('button', { name: 'Resume remaining' }).waitFor();
    await page.getByRole('button', { name: 'Stop', exact: true }).click(); await page.getByText('Stopped', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Use current post' }).click(); await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /individual post/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
