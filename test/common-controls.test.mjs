import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { runBatch } from '../src/run.mjs';

const origin = 'https://otium-controls.test';
const profile = {
  answers: {
    firstName: 'Taylor', lastName: 'Rivera', email: 'taylor@example.test',
    phone: '6505550101', country: 'United States', university: 'Example University',
  },
  customAnswers: { 'Available for summer 2027?': 'Yes', 'Available for occasional travel': true },
};

async function harness(t) {
  const outDir = await mkdtemp(join(tmpdir(), 'otium-controls-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.OTIUM_TEST_CHANNEL ? { channel: process.env.OTIUM_TEST_CHANNEL } : {}),
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const req = route.request();
    if (req.method() !== 'GET') return route.abort();
    const url = new URL(req.url());
    let body;
    if (url.origin === origin && url.pathname === '/controls') {
      body = await readFile(new URL('./fixtures/common-controls.html', import.meta.url), 'utf8');
    } else if (url.origin === origin && url.pathname === '/frame-parent') {
      body = '<label>Email address <input id="parent-email"></label><iframe title="Education" src="/frame-child"></iframe>';
    } else if (url.origin === origin && url.pathname === '/frame-child') {
      body = '<label>First name <input id="frame-first" required></label><button type="submit" id="frame-submit">Submit</button>';
    } else if (url.origin === origin && url.pathname === '/dependent') {
      body = `<label>Country <select id="country" required><option value="">Select</option><option value="US">United States</option></select></label>
        <label id="email-holder" hidden>Email address <input id="revealed-email" required type="email"></label>
        <script>document.querySelector('#country').addEventListener('change', () => { document.querySelector('#email-holder').hidden = false; });</script>`;
    } else return route.abort();
    await route.fulfill({ status: 200, contentType: 'text/html', body });
  });
  return { context, outDir };
}

test('fills common semantic form controls while keeping sensitive attestation and final submission for review', async t => {
  const { context, outDir } = await harness(t);
  const { results: [result] } = await runBatch({
    context, outDir, profile, jobs: [{ id: 'controls', url: origin + '/controls' }], settleMs: 0,
  });
  assert.equal(result.status, 'review', JSON.stringify(result));
  const page = context.pages()[0];
  assert.equal(await page.locator('#given').inputValue(), 'Taylor', 'autocomplete identifies given name');
  assert.equal(await page.locator('#family').inputValue(), 'Rivera', 'ARIA label identifies last name');
  assert.equal(await page.locator('#email').inputValue(), 'taylor@example.test', 'ARIA labelledby identifies email');
  assert.equal(await page.locator('#phone').inputValue(), '6505550101', 'recognized placeholder identifies phone');
  assert.equal(await page.locator('#country').inputValue(), 'US');
  assert.equal(await page.locator('[name=availability][value=yes]').isChecked(), true);
  assert.equal(await page.locator('[name=availability][value=no]').isChecked(), false);
  assert.equal(await page.locator('#travel').isChecked(), true);
  assert.equal(await page.locator('#consent').isChecked(), false);
  assert.equal(await page.locator('#school').textContent(), 'Example University');
  assert.equal(await page.locator('#school-value').inputValue(), 'Example University');
  assert.deepEqual(await page.evaluate(() => window.controlFixture), { submitClicks: 0, submitEvents: 0 });
  assert.equal(result.requiredTotal, 8, 'radio alternatives count as one required question');
  assert.equal(result.requiredComplete, 7, JSON.stringify(result));
  assert.equal(result.coverage, 87.5);
  assert.ok(result.missing.some(({ label, reason }) => /certify/i.test(label) && reason === 'manual_sensitive'));
});

test('fills visible controls inside a same-origin iframe', async t => {
  const { context, outDir } = await harness(t);
  const { results: [result] } = await runBatch({
    context, outDir, profile, jobs: [{ id: 'framed', url: origin + '/frame-parent' }], settleMs: 0,
  });
  assert.equal(result.status, 'review', JSON.stringify(result));
  const page = context.pages()[0];
  assert.equal(await page.locator('#parent-email').inputValue(), 'taylor@example.test');
  const frame = page.frames().find(candidate => candidate.url() === origin + '/frame-child');
  assert.ok(frame, 'same-origin child frame is loaded: ' + JSON.stringify(page.frames().map(candidate => candidate.url())));
  assert.equal(await frame.locator('#frame-first').inputValue({ timeout: 2500 }), 'Taylor');
  assert.equal(result.requiredTotal, 1);
  assert.equal(result.requiredComplete, 1);
});

test('discovers a required known question revealed by a dependent native select', async t => {
  const { context, outDir } = await harness(t);
  const { results: [result] } = await runBatch({
    context, outDir, profile, jobs: [{ id: 'dependent', url: origin + '/dependent' }], settleMs: 0,
  });
  assert.equal(result.status, 'review', JSON.stringify(result));
  const page = context.pages()[0];
  assert.equal(await page.locator('#country').inputValue(), 'US');
  assert.equal(await page.locator('#revealed-email').inputValue(), 'taylor@example.test');
  assert.equal(result.requiredTotal, 2);
  assert.equal(result.requiredComplete, 2);
  assert.ok(result.filled.some(({ label }) => label === 'Email address'));
});
