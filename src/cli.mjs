import { chromium } from 'playwright';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { needsHuman, normalize, safeAnswer } from './fields.mjs';
import { parseJobs } from './input.mjs';
import { runBatch } from './run.mjs';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const usage = `Otium · prepare job applications for review
npm start -- --jobs jobs.json --profile profile.json [--resume /path/to/resume.pdf] [--out review] [--session .otium-browser] [--concurrency 2] [--channel chrome] [--headless]
npm start -- learn --profile profile.json --confirmed confirmed.json`;

async function main() {
  const argv = process.argv.slice(2);
  const learn = argv[0] === 'learn';
  const { values: args } = parseArgs({ args: learn ? argv.slice(1) : argv, options: {
    jobs: { type: 'string' }, profile: { type: 'string' }, out: { type: 'string', default: 'review' },
    session: { type: 'string', default: '.otium-browser' }, concurrency: { type: 'string', default: '2' },
    headless: { type: 'boolean' }, channel: { type: 'string' }, confirmed: { type: 'string' }, resume: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (args.help) return console.log(usage);
  if (!args.profile) throw Error('Supply --profile profile.json.');
  const profile = await readJson(args.profile);
  if (!record(profile) || (profile.answers !== undefined && !record(profile.answers)) || (profile.customAnswers !== undefined && !record(profile.customAnswers))) throw Error('Expected profile answers and customAnswers to be JSON objects.');

  if (learn) {
    if (!args.confirmed) throw Error('Supply --confirmed confirmed.json.');
    const additions = await readJson(args.confirmed);
    if (!record(additions) || !Object.keys(additions).length) throw Error('Supply a JSON object of exact question labels and confirmed answers.');
    const questions = Object.entries(profile.customAnswers ?? {});
    for (const [label, value] of Object.entries(additions)) {
      if (!normalize(label) || label.length > 240 || !safeAnswer(value) || needsHuman(label)) throw Error('An answer is invalid or belongs to a category reserved for manual review.');
      const key = normalize(label);
      for (let i = questions.length - 1; i >= 0; i--) if (normalize(questions[i][0]) === key) questions.splice(i, 1);
      questions.push([label, value]);
    }
    const dest = await realpath(args.profile);
    const temp = dest + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify({ ...profile, customAnswers: Object.fromEntries(questions) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, dest);
    console.log(`Recorded ${Object.keys(additions).length} confirmed answers in the local profile.`);
    return;
  }

  if (!args.jobs) throw Error('Supply --jobs jobs.json.');
  if (args.channel !== undefined && args.channel !== 'chrome') throw Error('The only supported alternate browser channel is chrome.');
  if (!args.headless && !process.stdin.isTTY) throw Error('Run in an interactive terminal for browser handoff, or use --headless for a report only.');
  const jobs = parseJobs(await readJson(args.jobs));
  const credentials = Object.fromEntries(jobs.filter(j => j.credentialEnv).map(j => [j.id, {
    email: process.env[j.credentialEnv + '_EMAIL'], password: process.env[j.credentialEnv + '_PASSWORD'],
  }]));
  const concurrency = Number(args.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) throw Error('Concurrency must be an integer from 1 to 5.');
  const outDir = resolve(args.out, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  await mkdir(args.session, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(resolve(args.session), {
    headless: Boolean(args.headless), channel: args.channel, serviceWorkers: 'block', acceptDownloads: false,
  });
  const shutdown = () => { void context.close(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    const tabs = context.pages();
    const done = new Promise(resolve => context.once('close', resolve));
    console.log(`Preparing ${jobs.length} application(s). Pages may remain incomplete.`);
    const { results, releaseForReview } = await runBatch({ jobs, profile, context, credentials, resumePath: args.resume ? resolve(args.resume) : undefined, concurrency, outDir });
    for (const tab of tabs) if (tab.url() === 'about:blank') await tab.close();
    const reviewable = results.filter(job => job.status === 'review').length;
    console.log(`${reviewable}/${results.length} forms ready to review. Report: ${resolve(outDir, 'report.html')}`);
    if (!args.headless) {
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const reply = await Promise.race([done, reader.question('Press Enter to enable normal browser interaction for manual review (Ctrl+C to close). ')]);
        if (reply !== undefined) {
          await releaseForReview();
          console.log('Review and submit manually in Chromium. Press Ctrl+C when finished.');
          await done;
        }
      } finally { reader.close(); }
    }
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await context.close();
  }
}

main().catch(error => {
  console.error(`Otium: ${error.name === 'SyntaxError' ? 'Could not read JSON input or command arguments.' : String(error.message).split('\n')[0]}`);
  process.exitCode = 1;
});
