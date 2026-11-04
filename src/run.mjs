import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalize, resolveAnswer } from './fields.mjs';
import { parseJobs, redactUrl } from './input.mjs';
import { publicFormRead } from './public-form.mjs';
import { executeStep, readResume } from './workflow.mjs';

const selector = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), textarea, select, [role=combobox]:not(input):not(select), [contenteditable=true]';
const guardKey = '__otiumRestoreSubmission';

function blockSubmit(key) {
  if (window[key]) return;
  const proto = HTMLFormElement.prototype;
  const original = [proto.submit, proto.requestSubmit];
  const block = event => {
    if (event.submitter && event.submitter === window[key + 'Allowed']) {
      delete window[key + 'Allowed'];
      return;
    }
    event.preventDefault(); event.stopImmediatePropagation();
  };
  window.addEventListener('submit', block, true);
  proto.submit = proto.requestSubmit = () => {};
  window[key] = () => {
    window.removeEventListener('submit', block, true);
    [proto.submit, proto.requestSubmit] = original;
    delete window[key];
  };
}

function snapshot(elements) {
  return elements.flatMap((el, index) => {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height || el.closest('[inert],[hidden],[aria-hidden=true]') || getComputedStyle(el).visibility !== 'visible') return [];
    const name = el.getAttribute('name') || '';
    const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
    const label = (labelled || el.getAttribute('aria-label') || [...(el.labels || [])].map(l => {
      const copy = l.cloneNode(true);
      copy.querySelectorAll('input,select,textarea,button,[aria-hidden=true]').forEach(node => node.remove());
      return copy.textContent;
    }).join(' ')).replace(/\s+/g, ' ').trim().slice(0, 240);
    const type = el.tagName === 'INPUT' ? el.type : el.tagName.toLowerCase();
    const required = Boolean(el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label));
    const selected = el.options?.[el.selectedIndex];
    const valid = el.validity?.valid ?? true;
    const value = ['radio','checkbox'].includes(type) ? el.checked : Boolean(el.value?.trim() && !(selected?.disabled));
    return [{ index, name, label, type, required, valid, populated: value, disabled: el.matches(':disabled') || el.readOnly || el.getAttribute('aria-disabled') === 'true',
      options: [...(el.options || [])].filter(o => o.value && !o.disabled && !o.closest('optgroup[disabled]')).map(o => ({ label: o.label, value: o.value })) }];
  });
}

async function fillPage(page, profile, job) {
  await page.evaluate(blockSubmit, guardKey);
  const scannedUrl = page.url();
  const elements = page.locator(selector);
  const initial = await elements.evaluateAll(snapshot);
  const blocked = initial.some(f => f.type === 'password' || /\b(captcha|one time code|verification code)\b/.test(normalize(f.label + ' ' + f.name)));
  if (blocked) return { filled: [], missing: [], requiredTotal: 0, requiredComplete: 0, coverage: null, reason: 'sign_in_or_verification', status: 'blocked' };
  if (!initial.length) return { filled: [], missing: [], requiredTotal: 0, requiredComplete: 0, coverage: null, reason: 'no_visible_fields', status: 'blocked' };
  const counts = new Map();
  const identity = f => JSON.stringify([f.label, f.name, f.type]);
  for (const f of initial) counts.set(identity(f), (counts.get(identity(f)) || 0) + 1);
  const filled = new Map(), attempted = new Set(), reasons = new Map();
  const describe = f => ({ label: f.label || 'Unlabeled field', required: f.required });
  for (const f of initial.slice(0, 150)) {
    if (f.populated) continue;
    const key = identity(f);
    const skip = reason => reasons.set(key, reason);
    if (!f.label || f.disabled || counts.get(key) !== 1) { skip('ambiguous_or_unavailable'); continue; }
    if (!['text','email','tel','url','number','date','month','textarea','select'].includes(f.type)) { skip('manual_control'); continue; }
    const answer = resolveAnswer(f, profile, job.answers);
    if ('reason' in answer) { skip(answer.reason); continue; }
    if (page.url() !== scannedUrl) throw Error('page_changed');
    const current = (await elements.evaluateAll(snapshot)).find(field => field.index === f.index);
    if (!current || identity(current) !== key || current.populated || current.disabled) { skip('field_changed'); continue; }
    const field = elements.nth(f.index);
    try {
      const value = typeof answer.value === 'boolean' ? (answer.value ? 'Yes' : 'No') : answer.value;
      let expected = value;
      if (f.type === 'select') {
        const options = current.options.filter(o => normalize(o.label) === normalize(value) || normalize(o.value) === normalize(value));
        if (options.length !== 1) { skip('no_unique_option'); continue; }
        expected = options[0].value;
        attempted.add(key);
        await field.selectOption({ value: expected }, { timeout: 900 });
      } else {
        if (typeof answer.value !== 'string') { skip('manual_control'); continue; }
        attempted.add(key);
        await field.fill(value, { timeout: 900 });
      }
      if (await field.inputValue({ timeout: 900 }) === expected) filled.set(key, expected);
      else skip('value_not_retained');
    } catch { skip('control_rejected_answer'); }
  }
  if (page.url() !== scannedUrl) throw Error('page_changed');
  const final = await elements.evaluateAll(snapshot);
  const required = final.filter(f => f.required && !f.disabled);
  const verified = [], verifiedKeys = new Set();
  for (const f of final) {
    const expected = filled.get(identity(f));
    if (expected === undefined || !f.valid) continue;
    if (await elements.nth(f.index).inputValue({ timeout: 900 }).catch(() => null) === expected) {
      verified.push(describe(f));
      verifiedKeys.add(identity(f));
    }
  }
  const failedFill = f => attempted.has(identity(f)) && !verifiedKeys.has(identity(f));
  const complete = required.filter(f => f.populated && f.valid && !failedFill(f)).length;
  return { status: 'review', filled: verified,
    missing: final.filter(f => !f.disabled && (!f.populated || !f.valid || failedFill(f))).map(f => ({ ...describe(f), reason: !f.valid && f.populated ? 'invalid_value' : reasons.get(identity(f)) || (failedFill(f) ? 'value_changed_after_fill' : 'manual_review') })),
    requiredTotal: required.length, requiredComplete: complete, coverage: required.length ? 100 * complete / required.length : null };
}

async function prepareJob({ page, job, state, profile, credentials, resume, settleMs }) {
  const response = await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 18000 }).catch(() => null);
  if (!response?.ok() || new URL(page.url()).origin !== state.origin) throw Error('navigation_failed');
  if (settleMs) {
    await page.waitForTimeout(settleMs);
    await page.locator(selector).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
  }
  if (new URL(page.url()).origin !== state.origin) throw Error('navigation_failed');
  state.frozen = true;
  const stages = [], completedSteps = [];
  let current;
  const scan = async () => {
    current = await fillPage(page, profile, job);
    stages.push(current);
    return current;
  };
  const summarize = (status, reason) => {
    const requiredTotal = stages.reduce((n, p) => n + p.requiredTotal, 0);
    const requiredComplete = stages.reduce((n, p) => n + p.requiredComplete, 0);
    const tag = (field, i) => ({ ...field, ...(job.workflow.length ? { page: i + 1 } : {}) });
    return { status, ...(reason ? { reason } : {}), completedSteps, requiredTotal, requiredComplete,
      filled: stages.flatMap((p, i) => p.filled.map(f => tag(f, i))),
      missing: stages.flatMap((p, i) => p.missing.map(f => tag(f, i))),
      coverage: requiredTotal ? 100 * requiredComplete / requiredTotal : null };
  };
  try {
    for (const step of job.workflow) {
      if (step.type === 'next') {
        const form = await scan();
        if (form.status !== 'review' || form.missing.some(f => f.required)) return summarize('blocked', 'workflow_required_fields_unresolved');
      }
      await page.evaluate(blockSubmit, guardKey);
      completedSteps.push(await executeStep({ page, step, state, credentials, resume, guardKey }));
      current = undefined;
    }
    await scan();
    if (current.reason === 'no_visible_fields' && completedSteps.at(-1) === 'next') return summarize('review');
    return summarize(current.status, current.reason);
  } catch (error) {
    if (!current) await scan().catch(() => {});
    return summarize('blocked', /^workflow_[a-z_]+$/.test(error.message) ? error.message : 'workflow_transition_not_verified');
  }
}

export async function runBatch({ jobs, profile, context, credentials = {}, resumePath, concurrency = 2, outDir, settleMs = 1200 }) {
  const queue = parseJobs(jobs);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) throw Error('Concurrency must be an integer from 1 to 5');
  if (!profile || typeof profile !== 'object') throw Error('Profile must be an object');
  const resume = resumePath && queue.some(j => j.workflow.some(s => s.type === 'resume')) ? await readResume(resumePath) : undefined;
  const policy = new Map();
  let released = false;
  const routeHandler = async route => {
    if (released) return route.fallback();
    const request = route.request();
    let page;
    try { page = request.frame().page(); } catch { return route.abort(); }
    const state = policy.get(page);
    const permit = state?.permit;
    if (permit && !permit.used && request.method() === 'POST' && request.url() === permit.url && request.frame() === page.mainFrame()) {
      permit.used = true;
      try {
        const result = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 6000 });
        if (result.status() >= 300 && result.status() < 400) {
          const location = result.headers().location;
          if (!location || ![302, 303].includes(result.status()) || new URL(location, permit.url).href !== permit.redirectUrl) return route.abort();
          permit.ok = true;
          return route.fulfill({ response: result, status: 303 });
        }
        permit.ok = result.ok();
        return route.fulfill({ response: result });
      } catch { return route.abort(); }
    }
    if (permit?.ok && permit.redirectUrl === request.url() && request.method() === 'GET' && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      try {
        const result = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 6000 });
        if (!result.ok()) return route.abort();
        return route.fulfill({ response: result });
      } catch { return route.abort(); }
    }
    if (state && !state.frozen && request.frame() === page.mainFrame()) {
      const query = publicFormRead(request, state.jobUrl);
      if (query) {
        try {
          const response = await route.fetch({ postData: query, maxRedirects: 0, maxRetries: 0, timeout: 6000 });
          if (!response.ok()) return route.abort();
          return route.fulfill({ response });
        } catch { return route.abort(); }
      }
    }
    if (!state || state.frozen || !['GET','HEAD'].includes(request.method())) return route.abort();
    if (request.isNavigationRequest() && new URL(request.url()).origin !== state.origin) return route.abort();
    return route.fallback();
  };
  await context.route('**/*', routeHandler);
  // Dedicated browser context: reject sockets during preparation, including sockets opened by page scripts.
  await context.routeWebSocket('**/*', ws => released ? ws.connectToServer() : ws.close());
  let cursor = 0;
  const results = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (cursor < queue.length) {
      const index = cursor++;
      const job = queue[index];
      const base = { id: job.id, url: redactUrl(job.url) };
      let state;
      try {
        const page = await context.newPage();
        state = { origin: new URL(job.url).origin, jobUrl: job.url, frozen: false };
        policy.set(page, state);
        results[index] = { ...base, ...await prepareJob({ page, job, state, profile, credentials: Object.hasOwn(credentials, job.id) ? credentials[job.id] : undefined, resume, settleMs }) };
      } catch (error) {
        results[index] = { ...base, status: 'error', reason: ['navigation_failed','page_changed'].includes(error.message) ? error.message : 'could_not_prepare', filled: [], missing: [], coverage: null };
      } finally {
        if (state) state.frozen = true;
      }
    }
  }));
  if (outDir) await writeReport(outDir, results);
  return { results, async releaseForReview() {
    if (released) return;
    for (const page of policy.keys()) await page.evaluate(key => window[key]?.(), guardKey).catch(() => {});
    released = true;
    await context.unroute('**/*', routeHandler);
  } };
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function writeReport(dir, results) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const report = { generatedAt: new Date().toISOString(), results };
  await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const fieldLabel = f => (f.page ? `Step ${f.page}: ` : '') + esc(f.label);
  const rows = results.map(r => `<section><h2>${esc(r.id)}</h2><p>${esc(r.url)}</p><p>${esc(r.status)} · ${r.coverage === null ? 'Coverage unavailable' : `${Math.round(r.coverage)}% of visible required fields complete`}${r.reason ? ' · ' + esc(r.reason) : ''}</p>${r.completedSteps?.length ? `<p>Completed actions: ${esc(r.completedSteps.join(', '))}</p>` : ''}<h3>Filled</h3><ul>${r.filled.map(f => `<li>${fieldLabel(f)}</li>`).join('')}</ul><h3>Needs review</h3><ul>${r.missing.map(f => `<li>${fieldLabel(f)} (${f.required ? 'required' : 'optional'}): ${esc(f.reason)}</li>`).join('')}</ul></section>`).join('');
  await writeFile(join(dir, 'report.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Otium review</title><style>body{font:16px system-ui;margin:2rem auto;max-width:65ch;padding:0 1rem}section{border-top:1px solid #ccc;padding:1rem 0}p{overflow-wrap:anywhere}</style><h1>Otium application review</h1><p>Review all answers in the open browser tabs. No application was submitted by Otium.</p>${rows}</html>`, { mode: 0o600, flag: 'wx' });
}
