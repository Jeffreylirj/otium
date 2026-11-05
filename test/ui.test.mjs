import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

test('local frontend prepares the demo batch and requires an explicit review handoff', async t => {
  const { createOtiumServer } = await import('../src/server.mjs');
  const dataDir = await mkdtemp(join(tmpdir(), 'otium-ui-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const channel = process.env.OTIUM_TEST_CHANNEL || 'chrome';
  const app = await createOtiumServer({ headless: true, browserChannel: channel, dataDir });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch({ headless: true, channel });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(origin);
  const initial = await (await page.request.get(origin + '/api/state')).json();
  assert.equal(initial.status, 'idle');
  assert.ok(typeof initial.csrf === 'string' && initial.csrf.length > 20);

  const badOrigin = await page.request.post(origin + '/api/run', {
    headers: { Origin: 'https://untrusted.example.test', 'X-Otium-Token': initial.csrf },
    data: { demo: true },
  });
  assert.equal(badOrigin.status(), 403);
  const badToken = await page.request.post(origin + '/api/run', {
    headers: { Origin: origin, 'X-Otium-Token': 'invalid-token' },
    data: { demo: true },
  });
  assert.equal(badToken.status(), 403);
  assert.equal((await (await page.request.get(origin + '/api/state')).json()).status, 'idle');

  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.getByText('Ready for review', { exact: true }).waitFor({ timeout: 30000 });
  const state = await (await page.request.get(origin + '/api/state')).json();
  assert.equal(state.results.length, 2, JSON.stringify(state));
  assert.ok(state.results.every(result => result.status === 'review'));
  for (const { id } of state.results) {
    await page.locator(`#results article[data-job-id="${id}"]`).waitFor();
  }
  for (const summary of await page.locator('#results summary').all()) await summary.click();
  assert.ok((await page.locator('#results').innerText()).includes('certify'), 'unanswered attestation is visible');
  await page.screenshot({ path: '/private/tmp/otium-ui.png', fullPage: true });
  await page.getByRole('button', { name: 'Enable manual review', exact: true }).click();
  await page.getByText('Manual review enabled', { exact: true }).waitFor();
  assert.equal((await (await page.request.get(origin + '/api/state')).json()).status, 'reviewing');
  await page.getByRole('button', { name: 'Close batch', exact: true }).click();
  await page.getByText('Batch closed', { exact: true }).waitFor();
  assert.equal((await (await page.request.get(origin + '/api/state')).json()).status, 'closed');
});
