import { normalize, resolveAnswer } from './fields.mjs';

export const formSelector = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), textarea, select, [role=combobox]:not(input):not(select), [role=checkbox]:not(input), [role=radio]:not(input), [contenteditable=true]';

// This function runs in a document, with no access to the applicant profile.
function snapshot(elements) {
  const storeKey = Symbol.for('otium.formControlIds');
  const store = window[storeKey] ||= { ids: new WeakMap(), next: 0 };
  const uid = el => { if (!store.ids.has(el)) store.ids.set(el, ++store.next); return store.ids.get(el); };
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest('[inert],[hidden],[aria-hidden=true]') && getComputedStyle(el).visibility === 'visible'; };
  const clean = node => { const copy = node.cloneNode(true); copy.querySelectorAll('input,select,textarea,button,[role=combobox],[aria-hidden=true]').forEach(n => n.remove()); return copy.textContent ?? ''; };
  const text = v => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const accessible = el => text(el.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ') || el.getAttribute('aria-label') || [...(el.labels ?? [])].map(clean).join(' '));
  const groups = new Map();
  const result = [];
  elements.forEach((el, index) => {
    if (!visible(el)) return;
    const role = el.getAttribute('role');
    const type = el.tagName === 'INPUT' && el.type === 'password' ? 'password' : role === 'combobox' ? 'combobox' : el.tagName === 'INPUT' ? el.type : role === 'checkbox' || role === 'radio' ? role : el.tagName.toLowerCase();
    const name = el.getAttribute('name') || '';
    const fieldset = el.closest('fieldset');
    const group = el.closest('[role=radiogroup]');
    const context = [fieldset?.querySelector(':scope > legend')?.textContent, group && accessible(group)].filter(Boolean).map(text);
    const base = { uid: uid(el), index, name, label: accessible(el), type, placeholder: el.getAttribute('placeholder') || '', autocomplete: el.getAttribute('autocomplete') || '', context,
      required: Boolean(el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(accessible(el))),
      disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || (el.readOnly && type !== 'combobox'), valid: el.validity?.valid ?? true };
    if (type === 'radio') {
      const groupKey = name ? `name:${[...document.forms].indexOf(el.form)}:${name}` : group || fieldset || el;
      let g = groups.get(groupKey);
      if (!g) { g = { ...base, label: context.at(-1) || '', context, type: 'radio', indices: [], options: [], populated: false, value: null, valid: true }; groups.set(groupKey, g); result.push(g); }
      g.indices.push(index);
      g.options.push({ uid: uid(el), index, label: accessible(el), value: el.value ?? el.getAttribute('data-value') ?? '', disabled: base.disabled });
      g.required ||= base.required || group?.getAttribute('aria-required') === 'true';
      if (el.checked || el.getAttribute('aria-checked') === 'true') { g.populated = true; g.value = uid(el); }
      g.disabled = g.options.every(o => o.disabled);
      return;
    }
    if (type === 'checkbox') {
      const checked = Boolean(el.checked || el.getAttribute('aria-checked') === 'true');
      result.push({ ...base, populated: checked, value: checked }); return;
    }
    const selected = el.options?.[el.selectedIndex];
    if (type === 'combobox') {
      const content = text(el instanceof HTMLInputElement ? el.value : el.getAttribute('aria-valuetext') || el.textContent);
      const empty = !content || /^(select|choose|please select|pick)(\b|\s|…|\.\.\.)/i.test(content);
      result.push({ ...base, populated: !empty, value: empty ? '' : content, valid: true }); return;
    }
    result.push({ ...base, value: el.value ?? '', populated: Boolean(el.value?.trim() && !selected?.disabled),
      options: [...(el.options ?? [])].filter(o => o.value && !o.disabled && !o.closest('optgroup[disabled]')).map(o => ({ label: o.label, value: o.value })) });
  });
  for (const g of groups.values()) g.valid = !g.required || g.populated;
  return result;
}

const identity = f => JSON.stringify([f.uid, f.label, f.name, f.type]);
const duplicateIdentity = f => JSON.stringify([f.label, f.name, f.type, f.autocomplete, f.placeholder]);
const describe = f => ({ label: f.label || f.placeholder || f.autocomplete || 'Unlabeled field', required: f.required });

async function selectCombo(frame, field, value) {
  if (await field.evaluate(el => el.matches('button') && el.type !== 'button' && !!el.form)) return { reason: 'manual_control' };
  await field.click({ timeout: 900 });
  const controls = await field.getAttribute('aria-controls') || await field.getAttribute('aria-owns');
  let listboxes;
  if (controls) {
    const ids = controls.split(/\s+/);
    listboxes = frame.locator('[role=listbox]').filter({ visible: true });
    const matches = [];
    for (let i = 0; i < await listboxes.count(); i++) if (ids.includes(await listboxes.nth(i).getAttribute('id'))) matches.push(listboxes.nth(i));
    if (matches.length !== 1) { await field.press('Escape').catch(() => {}); return { reason: 'ambiguous_options' }; }
    listboxes = matches[0];
  } else listboxes = frame.locator('[role=listbox]').filter({ visible: true });
  if (await listboxes.count() !== 1 || await listboxes.getAttribute('aria-multiselectable') === 'true') { await field.press('Escape').catch(() => {}); return { reason: 'ambiguous_options' }; }
  const options = listboxes.locator('[role=option]').filter({ visible: true });
  const exact = [];
  for (let i = 0; i < Math.min(await options.count(), 100); i++) {
    const option = options.nth(i);
    if (normalize(await option.innerText()) === normalize(value) && await option.getAttribute('aria-disabled') !== 'true' && await option.isEnabled()) exact.push(option);
  }
  if (exact.length !== 1) { await field.press('Escape').catch(() => {}); return { reason: 'no_unique_option' }; }
  if (await exact[0].evaluate(el => el.matches('button') && el.type !== 'button' && !!el.form)) return { reason: 'manual_control' };
  await exact[0].click({ timeout: 900 });
  return { expected: value };
}

/** Fill only current visible controls. The caller installs network/submission guards. */
export async function fillForm(page, profile, job = {}) {
  const url = page.url();
  const frames = page.frames().filter(frame => { try { return new URL(frame.url()).origin === new URL(url).origin; } catch { return false; } }).slice(0, 8);
  const documents = [];
  for (const frame of frames) {
    try {
      if (frame !== page.mainFrame()) {
        const host = await frame.frameElement();
        if (!await host.isVisible()) { await host.dispose(); continue; }
        await host.dispose();
      }
      const elements = frame.locator(formSelector); documents.push({ frame, elements, initial: await elements.evaluateAll(snapshot) });
    } catch { /* Detached frames are handled by the enclosing page's review. */ }
  }
  const initial = documents.flatMap(d => d.initial);
  if (initial.some(f => f.type === 'password' || /\b(captcha|one time code|verification code)\b/.test(normalize(f.label + ' ' + f.name)))) return { status: 'blocked', reason: 'sign_in_or_verification', filled: [], missing: [], requiredTotal: 0, requiredComplete: 0, coverage: null };
  if (!initial.length) return { status: 'blocked', reason: 'no_visible_fields', filled: [], missing: [], requiredTotal: 0, requiredComplete: 0, coverage: null };
  const filled = [], missing = [];
  let requiredTotal = 0, requiredComplete = 0;
  let remainingControls = 150;
  for (const { frame, elements } of documents) {
    const frameUrl = frame.url();
    const expected = new Map(), attempted = new Set(), reasons = new Map();
    const processed = new Set(), processedNodes = new Set();
    let quietPasses = 0;
    // Re-read after each action: choosing a native option can reveal another
    // required question or insert DOM nodes before controls already scanned.
    // A semantic key is attempted once even if the site keeps replacing it.
    for (; remainingControls > 0;) {
      if (page.url() !== url || frame.url() !== frameUrl) throw Error('page_changed');
      const latest = await elements.evaluateAll(snapshot);
      const f = latest.find(field => !processedNodes.has(field.uid) && !processed.has(duplicateIdentity(field)));
      if (!f) {
        if (quietPasses++ >= 2) break;
        await frame.waitForTimeout(50);
        continue;
      }
      quietPasses = 0; remainingControls--;
      processed.add(duplicateIdentity(f));
      processedNodes.add(f.uid);
      if (f.populated || f.disabled) continue;
      const key = identity(f), skip = reason => reasons.set(key, reason);
      if (latest.filter(field => duplicateIdentity(field) === duplicateIdentity(f)).length !== 1) { skip('ambiguous_or_unavailable'); continue; }
      if (!['text','email','tel','url','number','date','month','textarea','select','radio','checkbox','combobox'].includes(f.type)) { skip('manual_control'); continue; }
      const answer = resolveAnswer({ ...f, context: [...f.context, ...(f.type === 'radio' ? f.options.map(o => o.label) : [])] }, profile, job.answers);
      if ('reason' in answer) { skip(answer.reason); continue; }
      if (page.url() !== url || frame.url() !== frameUrl) throw Error('page_changed');
      const current = (await elements.evaluateAll(snapshot)).find(c => identity(c) === key);
      if (!current || current.populated || current.disabled) { skip('field_changed'); continue; }
      const field = elements.nth(f.index);
      try {
        let wanted = answer.value;
        if (f.type === 'radio') {
          const value = typeof wanted === 'boolean' ? (wanted ? 'Yes' : 'No') : wanted;
          const options = current.options.filter(o => !o.disabled && (normalize(o.label) === normalize(value) || normalize(o.value) === normalize(value)));
          if (options.length !== 1) { skip('no_unique_option'); continue; }
          attempted.add(key); wanted = options[0].uid;
          const option = elements.nth(options[0].index);
          if (await option.evaluate(el => el instanceof HTMLInputElement)) await option.check({ timeout: 900 });
          else {
            if (await option.evaluate(el => el.matches('button') && el.type !== 'button' && !!el.form)) { skip('manual_control'); continue; }
            await option.click({ timeout: 900 });
          }
        } else if (f.type === 'checkbox') {
          if (typeof wanted !== 'boolean') { skip('manual_control'); continue; }
          attempted.add(key);
          if (await field.evaluate(el => el instanceof HTMLInputElement)) await field.setChecked(wanted, { timeout: 900 });
          else if ((await field.getAttribute('aria-checked') === 'true') !== wanted) {
            if (await field.evaluate(el => el.matches('button') && el.type !== 'button' && !!el.form)) { skip('manual_control'); continue; }
            await field.click({ timeout: 900 });
          }
        } else if (f.type === 'select') {
          const value = typeof wanted === 'boolean' ? (wanted ? 'Yes' : 'No') : wanted;
          const options = current.options.filter(o => normalize(o.label) === normalize(value) || normalize(o.value) === normalize(value));
          if (options.length !== 1) { skip('no_unique_option'); continue; }
          wanted = options[0].value; attempted.add(key);
          await field.selectOption({ value: wanted }, { timeout: 900 });
        } else if (f.type === 'combobox') {
          if (typeof wanted !== 'string') { skip('manual_control'); continue; }
          attempted.add(key);
          const result = await selectCombo(frame, field, wanted);
          if (result.reason) { skip(result.reason); continue; }
        } else {
          if (typeof wanted !== 'string') { skip('manual_control'); continue; }
          attempted.add(key); await field.fill(wanted, { timeout: 900 });
        }
        expected.set(key, wanted);
      } catch { skip('control_rejected_answer'); }
    }
    if (page.url() !== url || frame.url() !== frameUrl) throw Error('page_changed');
    const final = await elements.evaluateAll(snapshot);
    for (const f of final) {
      if (f.disabled) continue;
      const key = identity(f), wanted = expected.get(key);
      const verified = expected.has(key) && f.valid && (f.type === 'combobox' ? normalize(f.value) === normalize(wanted) : f.value === wanted);
      const failed = attempted.has(key) && !verified;
      if (verified) filled.push(describe(f));
      if (f.required) { requiredTotal++; if (f.populated && f.valid && !failed) requiredComplete++; }
      if (!f.populated || !f.valid || failed) {
        if (verified && f.type === 'checkbox' && wanted === false && !f.required) continue;
        missing.push({ ...describe(f), reason: !f.valid && f.populated ? 'invalid_value' : reasons.get(key) || (failed ? 'value_changed_after_fill' : 'manual_review') });
      }
    }
  }
  return { status: 'review', filled, missing, requiredTotal, requiredComplete, coverage: requiredTotal ? 100 * requiredComplete / requiredTotal : null };
}
