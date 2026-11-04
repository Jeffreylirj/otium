import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

const endpoint = {
  login: /^(?:login|log-in|signin|sign-in|authenticate|session|sessions)$/i,
  next: /^(?:next|continue|draft|step|save-draft)$/i,
  resume: /^(?:upload|resume|attachment|attachments)$/i,
};
const risky = /(?:^|[/_.-])(?:submit|finalize|complete|send|finish|confirm|apply|register|signup)(?:$|[/_.-])/i;
const labels = { login: /^(?:sign in|log in|login|sign-in)$/i, next: /^(?:next(?: step)?|continue|save and continue)$/i };

export function validateWorkflow(steps, origin) {
  if (steps === undefined) return [];
  if (!Array.isArray(steps) || steps.length > 12) throw Error('Workflow must contain at most 12 steps');
  const selector = s => typeof s === 'string' && s.trim().length > 0 && s.length <= 300;
  return steps.map((step, index) => {
    if (!step || !Object.hasOwn(endpoint, step.type) || !selector(step.successSelector)) throw Error('Each workflow step needs a supported type and successSelector');
    if (step.type === 'login' && (index !== 0 || !selector(step.usernameSelector) || !selector(step.passwordSelector) || !step.request)) throw Error('Login must be first and declare its fields and request');
    if (step.type === 'resume' ? !selector(step.inputSelector) : !selector(step.buttonSelector)) throw Error('Workflow step needs a unique control selector');
    if (!step.request) return { ...step, request: undefined };
    if (step.request.method !== 'POST' || typeof step.request.url !== 'string') throw Error('Workflow writes must declare an exact POST URL');
    const url = new URL(step.request.url, origin);
    const path = decodeURIComponent(url.pathname);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash || risky.test(path) || !endpoint[step.type].test(path.split('/').filter(Boolean).at(-1) ?? '')) throw Error('Workflow write URL must be same-origin and explicitly for login, draft progression, or upload');
    let redirectUrl;
    if (step.request.redirectUrl) {
      const redirect = new URL(step.request.redirectUrl, origin);
      if (redirect.origin !== origin || redirect.username || redirect.password || redirect.search || redirect.hash || risky.test(decodeURIComponent(redirect.pathname)) || redirect.href === url.href) throw Error('Workflow redirect must be an explicit safe same-origin URL');
      redirectUrl = redirect.href;
    }
    return { ...step, request: { method: 'POST', url: url.href, redirectUrl } };
  });
}

export async function readResume(path) {
  if (!path || !isAbsolute(path) || !/\.pdf$/i.test(path)) throw Error('Use an explicitly selected absolute PDF path for resume automation');
  const file = await stat(path);
  if (!file.isFile() || file.size > 10 * 1024 * 1024) throw Error('Resume must be a PDF no larger than 10 MB');
  const buffer = await readFile(path);
  if (buffer.length > 10 * 1024 * 1024 || buffer.subarray(0, 5).toString() !== '%PDF-') throw Error('Resume must be a PDF no larger than 10 MB');
  return { name: basename(path), mimeType: 'application/pdf', buffer };
}

async function control(page, selector) {
  const locator = page.locator(selector);
  if (await locator.count() !== 1) throw Error('workflow_control_ambiguous');
  return locator;
}

export async function executeStep({ page, state, step, credentials, resume, guardKey }) {
  const origin = state.origin;
  const verifyOrigin = () => { if (new URL(page.url()).origin !== origin) throw Error('workflow_origin_changed'); };
  verifyOrigin();
  const success = page.locator(step.successSelector);
  if (await success.count() > 1) throw Error('workflow_control_ambiguous');
  if (await success.first().isVisible()) {
    if (step.type === 'login' && !await page.locator(step.passwordSelector).first().isVisible()) return 'session_reused';
    throw Error('workflow_success_already_visible');
  }
  let action, username, password, loginInputs = [];
  if (step.type === 'resume') {
    if (!resume) throw Error('workflow_resume_missing');
    action = await control(page, step.inputSelector);
    if (!await action.evaluate(el => el instanceof HTMLInputElement && el.type === 'file' && !el.disabled)) throw Error('workflow_control_unsafe');
  } else {
    action = await control(page, step.buttonSelector);
    const details = await action.evaluate(el => ({
      label: (el.getAttribute('aria-label') || (el.tagName === 'INPUT' ? el.value : el.textContent) || '').replace(/\s+/g, ' ').trim(),
      button: el.matches('button, input[type=button], input[type=submit], [role=button]'),
      submits: el.type === 'submit' && !!el.form,
      action: el.hasAttribute('formaction') ? el.formAction : el.form?.action,
      method: el.hasAttribute('formmethod') ? el.formMethod : el.form?.method,
      target: el.hasAttribute('formtarget') ? el.formTarget : el.form?.target,
    }));
    if (!details.button || !labels[step.type].test(details.label) || (details.submits && (!step.request || details.action !== step.request.url || details.method.toLowerCase() !== 'post' || !['', '_self', undefined].includes(details.target)))) throw Error('workflow_control_unsafe');
    if (step.type === 'login') {
      if (typeof credentials?.email !== 'string' || !credentials.email || typeof credentials?.password !== 'string' || !credentials.password) throw Error('workflow_credentials_missing');
      username = await control(page, step.usernameSelector);
      password = await control(page, step.passwordSelector);
      if (!await username.evaluate(el => el instanceof HTMLInputElement && ['text', 'email'].includes(el.type)) ||
          !await password.evaluate(el => el instanceof HTMLInputElement && el.type === 'password')) throw Error('workflow_control_unsafe');
      if (await page.locator('[autocomplete=one-time-code], iframe[src*="captcha" i], input[name*="captcha" i]').count()) throw Error('workflow_verification_required');
    }
    if (details.submits) {
      // Allow only this submitter's native form event; direct submit()/requestSubmit() stay blocked.
      await action.evaluate((el, key) => { window[key + 'Allowed'] = el; }, guardKey);
    }
  }
  const permit = step.request ? { ...step.request, used: false, ok: false } : null;
  try {
    verifyOrigin();
    if (username && password) {
      loginInputs = await Promise.all([username.elementHandle({ timeout: 2000 }), password.elementHandle({ timeout: 2000 })]);
      await loginInputs[0].fill(credentials.email, { timeout: 2000 });
      await loginInputs[1].fill(credentials.password, { timeout: 2000 });
    }
    state.permit = permit;
    if (step.type === 'resume') await action.setInputFiles(resume, { timeout: 3500 });
    else await action.click({ timeout: 3500 });
    await success.waitFor({ state: 'visible', timeout: 6500 });
    verifyOrigin();
    if (permit && (!permit.used || !permit.ok)) throw Error('workflow_write_not_verified');
    return step.type;
  } catch (error) {
    if (error.message.startsWith('workflow_')) throw error;
    throw Error('workflow_transition_not_verified');
  } finally {
    state.permit = null;
    await page.evaluate(key => { delete window[key + 'Allowed']; }, guardKey).catch(() => {});
    await Promise.all(loginInputs.map(async handle => {
      await handle.evaluate(el => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '')).catch(() => {});
      await handle.dispose().catch(() => {});
    }));
  }
}
