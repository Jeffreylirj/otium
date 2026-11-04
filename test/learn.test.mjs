import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('learn updates an explicitly confirmed answer and rejects a mixed batch with a sensitive answer', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'otium-learn-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const profilePath = join(folder, 'profile.json');
  const confirmedPath = join(folder, 'confirmed.json');
  const profile = {
    answers: { firstName: 'Taylor' },
    customAnswers: { 'Available in June!': 'No', 'Preferred hours': 'Full time' },
  };
  const run = () => exec(process.execPath, [
    cli, 'learn', '--profile', profilePath, '--confirmed', confirmedPath,
  ]);
  await writeFile(profilePath, JSON.stringify(profile));
  await writeFile(confirmedPath, JSON.stringify({ 'Available in June?': 'Yes' }));
  const success = await run();
  assert.match(success.stdout, /Recorded 1 confirmed answers/);
  const updated = await readFile(profilePath, 'utf8');
  assert.deepEqual(JSON.parse(updated), {
    answers: profile.answers,
    customAnswers: { 'Preferred hours': 'Full time', 'Available in June?': 'Yes' },
  });
  if (process.platform !== 'win32') assert.equal((await stat(profilePath)).mode & 0o777, 0o600);

  await writeFile(confirmedPath, JSON.stringify({
    'Are you available in August?': 'Yes',
    'What is your passport number?': 'TEST-ONLY',
  }));
  await assert.rejects(run(), ({ stderr }) => /reserved for manual review/.test(stderr));
  assert.equal(await readFile(profilePath, 'utf8'), updated, 'an invalid addition leaves all answers unchanged');
});
