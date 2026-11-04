import { createHash } from 'node:crypto';

// Ashby renders public postings with two read queries sent over POST. Pin
// the observed query text and rebuild public-only variables from the job URL.
const ashbyQueries = new Map([
  ['ApiJobPosting', 'e1e9e81eb52affddbe9e9dd6ed68ccbfe653e59d8a7402f237ac94094c89cff1'],
  ['ApiOrganizationFromHostedJobsPageName', '90e5a406dbfe8b7f4529188fbbadd4a9f3e85a2c81b5445eab28115f886257a2'],
]);

export function publicFormRead(request, jobUrl) {
  if (request.method() !== 'POST' || !request.url().startsWith('https://jobs.ashbyhq.com/api/non-user-graphql?op=')) return null;
  const url = new URL(jobUrl);
  if (url.origin !== 'https://jobs.ashbyhq.com') return null;
  const match = url.pathname.match(/^\/([\w-]{1,100})\/([a-f0-9-]{36})(?:\/application)?\/?$/i);
  if (!match) return null;
  try {
    const { operationName, query } = request.postDataJSON();
    if (typeof query !== 'string' || query.length > 25000 || !ashbyQueries.has(operationName) ||
        request.url() !== `https://jobs.ashbyhq.com/api/non-user-graphql?op=${operationName}` ||
        createHash('sha256').update(query).digest('hex') !== ashbyQueries.get(operationName)) return null;
    const variables = { organizationHostedJobsPageName: match[1], ...(operationName === 'ApiJobPosting' ? { jobPostingId: match[2] } : {}) };
    return { operationName, query, variables };
  } catch { return null; }
}
