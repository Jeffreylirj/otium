import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { runBatch } from '../src/run.mjs';

const origin = 'https://otium-fixtures.test';
const job = (id, path) => ({ id, url: `${origin}${path}` });
const profile = {
  answers: {
    firstName: 'Taylor',
    lastName: 'Rivera',
    email: 'taylor@example.test',
    phone: '6505550101',
    country: 'United States',
    linkedin: 'https://www.linkedin.com/in/taylor-example/',
  },
  customAnswers: {
    'What interests you about this role?': 'I want to work on developer tools.',
  },
};

async function setup(t, fixtureRoutes) {
  const outDir = await mkdtemp(join(tmpdir(), 'otium-fixture-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.OTIUM_TEST_CHANNEL ? { channel: process.env.OTIUM_TEST_CHANNEL } : {}),
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const requests = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push({ path, method: request.method(), url: request.url() });
    if (!request.url().startsWith(`${origin}/`) || request.method() !== 'GET') {
      await route.abort();
      return;
    }
    const fixture = fixtureRoutes[path];
    if (!fixture) {
      await route.fulfill({ status: 404, body: 'Fixture not found' });
      return;
    }
    if (typeof fixture === 'function') {
      await fixture(route);
      return;
    }
    await respond(route, fixture);
  });
  return { outDir, context, requests };
}

async function respond(route, fixture) {
  const body = await readFile(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8');
  await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
}

test('leaves one prepared tab per listing, reports unanswered prompts, and never submits', async (t) => {
  const harness = await setup(t, { '/apply/1': 'application.html', '/apply/2': 'prefilled.html' });
  const { context, requests, outDir } = harness;
  const jobs = [job('one', '/apply/1'), job('two', '/apply/2')];
  const { results, releaseForReview } = await runBatch({ context, jobs, profile, outDir, settleMs: 0 });
  assert.equal(results.length, jobs.length);
  assert.equal(context.pages().length, jobs.length);
  const byId = new Map(results.map((result) => [result.id, result]));
  const first = byId.get('one');
  assert.equal(first.status, 'review');
  assert.equal(byId.get('two').status, 'review');

  const page = context.pages().find((tab) => tab.url() === jobs[0].url);
  assert.ok(page, 'first application tab stays open');
  assert.equal(await page.locator('[name=first_name]').inputValue(), 'Taylor');
  assert.equal(await page.locator('[name=last_name]').inputValue(), 'Rivera');
  assert.equal(await page.locator('[name=email]').inputValue(), 'taylor@example.test');
  assert.equal(await page.locator('[name=phone]').inputValue(), '6505550101');
  assert.equal(await page.locator('[name=country]').inputValue(), 'US');
  assert.equal(await page.locator('[name=linkedin]').inputValue(), profile.answers.linkedin);
  assert.equal(await page.locator('[name=motivation]').inputValue(), profile.customAnswers['What interests you about this role?']);
  assert.equal(await page.locator('[name=compensation]').inputValue(), '');
  assert.equal(await page.locator('[name=authorization]').inputValue(), '');
  assert.equal(await page.locator('[name=consent]').isChecked(), false);

  const missingLabels = first.missing.map(({ label }) => label).join(' ');
  assert.match(missingLabels, /desired compensation/i);
  assert.match(missingLabels, /authorized to work/i);
  assert.match(missingLabels, /certify/i);
  assert.equal(first.filled.length, 7);
  assert.equal(Math.round(first.coverage), 67, '6 of 9 required fields are complete');
  const reportText = await readFile(join(outDir, 'report.json'), 'utf8');
  const report = JSON.parse(reportText);
  assert.deepEqual(report.results, results);
  assert.ok(!reportText.includes(profile.answers.email), 'report does not echo personal answers');
  assert.deepEqual(await page.evaluate(() => window.otiumFixture), { clicks: [], submitEvents: 0 });
  assert.ok(requests.every(({ path, method }) => path !== '/submitted' && method === 'GET'));

  const prefilled = context.pages().find((tab) => tab.url() === jobs[1].url);
  assert.ok(prefilled, 'second application tab stays open');
  assert.equal(await prefilled.locator('[name=first_name]').inputValue(), 'Manually entered');
  assert.equal(await prefilled.locator('[name=email]').inputValue(), 'taylor@example.test');
  assert.equal(await prefilled.locator('[name=middle_name]').inputValue(), '');
  assert.equal(await prefilled.locator('[name=phone]').inputValue(), '');
  assert.equal(await prefilled.locator('[name=last_name]').inputValue(), '');

  // Only an explicit handoff permits a human to finish and submit. The
  // fixture cancels this deliberately manual submit event before any POST.
  await releaseForReview();
  await page.locator('[name=compensation]').fill('Discuss during review');
  await page.locator('[name=authorization]').selectOption('Yes');
  await page.locator('[name=consent]').check();
  await page.locator('#submit').click();
  assert.deepEqual(await page.evaluate(() => window.otiumFixture), { clicks: ['submit'], submitEvents: 1 });
});

test('a batch starts up to the configured number of independent application tabs', async (t) => {
  let active = 0;
  let maxActive = 0;
  const delayed = async (route) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      await respond(route, 'prefilled.html');
    } finally {
      active -= 1;
    }
  };
  const { context, outDir } = await setup(t, { '/slow/1': delayed, '/slow/2': delayed, '/slow/3': delayed });
  const jobs = [job('one', '/slow/1'), job('two', '/slow/2'), job('three', '/slow/3')];
  const { results } = await runBatch({ context, jobs, profile, outDir, settleMs: 0, concurrency: 2 });
  assert.equal(maxActive, 2, 'requests overlapped while respecting the worker limit');
  assert.deepEqual(results.map(({ id }) => id).sort(), ['one', 'three', 'two']);
  assert.equal(context.pages().length, 3);
});

test('blocks unexpected submit and mutation attempts from a field input handler', async (t) => {
  const { context, outDir, requests } = await setup(t, { '/unsafe': 'unsafe.html' });
  const listing = job('unsafe', '/unsafe');
  const { results } = await runBatch({ context, jobs: [listing], profile, outDir, settleMs: 0 });
  assert.equal(results.length, 1);
  const page = context.pages().find((tab) => tab.url() === listing.url);
  assert.ok(page, 'unsafe application remains open without navigating to the submit endpoint');
  await page.waitForFunction(() => window.otiumTrap.mutations.length === 4);
  const trap = await page.evaluate(() => window.otiumTrap);
  assert.equal(trap.attempts, 1, 'the fixture attempted network writes and form submissions');
  assert.equal(trap.submitEvents, 0, 'page application listeners never received the submit event');
  assert.deepEqual(trap.mutations.sort(), ['blocked:DELETE', 'blocked:GET', 'blocked:POST', 'blocked:PUT']);
  assert.ok(requests.every(({ path }) => !path.startsWith('/unexpected-')), 'no attempted write escaped the page guard');
});

test('a failed listing is reported without losing successful application tabs', async (t) => {
  const { context, outDir } = await setup(t, {
    '/broken': (route) => route.abort('failed'),
    '/working': 'prefilled.html',
  });
  const jobs = [job('broken', '/broken'), job('working', '/working')];
  const { results } = await runBatch({ context, jobs, profile, outDir, settleMs: 0 });
  assert.equal(results.length, jobs.length);
  const byId = new Map(results.map((result) => [result.id, result]));
  assert.equal(byId.get('broken').status, 'error');
  assert.equal(byId.get('working').status, 'review');
  const working = context.pages().find((tab) => tab.url() === jobs[1].url);
  assert.ok(working);
  assert.equal(await working.locator('[name=email]').inputValue(), profile.answers.email);
});

test('flags an answer changed by the page after the bot fills it', async (t) => {
  const { context, outDir } = await setup(t, { '/changed': 'changed.html' });
  const listing = job('changed', '/changed');
  const { results: [result] } = await runBatch({ context, jobs: [listing], profile, outDir, settleMs: 0 });
  assert.equal(result.status, 'review');
  assert.equal(result.requiredTotal, 2);
  assert.equal(result.requiredComplete, 1);
  assert.equal(result.coverage, 50);
  assert.deepEqual(result.filled.map(({ label }) => label), ['Last name']);
  assert.ok(result.missing.some(({ label, reason }) => label === 'First name' && reason === 'value_changed_after_fill'));
});
