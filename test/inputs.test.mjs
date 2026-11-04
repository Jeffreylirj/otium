import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAnswer } from '../src/fields.mjs';
import { parseJobs, redactUrl } from '../src/input.mjs';

test('duplicate posting links share one tab and unsafe destinations are rejected', () => {
  const first = { id: 'first', url: 'https://jobs.example.test/opening/1' };
  assert.deepEqual(parseJobs([first, { ...first, id: 'duplicate' }]).map(({ id }) => id), ['first']);
  assert.throws(() => parseJobs([first, { ...first, url: 'https://jobs.example.test/opening/2' }]), /unique/);
  for (const url of [
    'javascript:alert(1)',
    'http://jobs.example.test/opening',
    'https://taylor:secret@jobs.example.test/opening',
    'https://www.linkedin.com/jobs/123',
    'https://app.joinhandshake.com/jobs/123',
  ]) assert.throws(() => parseJobs([{ id: 'unsafe', url }]));
  assert.equal(redactUrl('https://jobs.example.test/opening?token=secret#secret'), 'https://jobs.example.test/opening');
});

test('rejects a final submission URL even when a workflow describes it as Next', () => {
  assert.throws(() => parseJobs([{
    id: 'mislabelled',
    url: 'https://jobs.example.test/opening',
    workflow: [{
      type: 'next',
      buttonSelector: '#next',
      successSelector: '#done',
      request: { method: 'POST', url: '/draft/submit' },
    }],
  }]), /workflow write url/i);
});

test('an exact role-specific answer takes priority without broadening the question match', () => {
  const profile = { answers: {}, customAnswers: { 'What interests you about this role?': 'General response' } };
  assert.deepEqual(
    resolveAnswer({ label: 'What interests you about this role?', name: 'motivation' }, profile, {
      'What interests you about this role?': 'Specific response',
    }),
    { value: 'Specific response' },
  );
  assert.deepEqual(
    resolveAnswer({ label: 'What interests you about this company?', name: 'motivation' }, profile),
    { reason: 'unknown_question' },
  );
});

test('conflicting and legally sensitive answers require human review', () => {
  const profile = { answers: { firstName: 'Taylor' }, customAnswers: {
    'Are you legally authorized to work?': 'Yes',
    'Tell us about yourself.': 'One',
    'Tell us about yourself!': 'Two',
  } };
  assert.deepEqual(resolveAnswer({ label: 'Are you legally authorized to work?', name: 'eligible' }, profile), { reason: 'manual_sensitive' });
  assert.deepEqual(resolveAnswer({ label: 'First name', name: 'passport' }, profile), { reason: 'manual_sensitive' });
  assert.deepEqual(resolveAnswer({ label: 'Tell us about yourself', name: 'intro' }, profile), { reason: 'ambiguous_answer' });
});
