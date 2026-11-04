export function parseJobs(jobs) {
  if (!Array.isArray(jobs) || !jobs.length || jobs.length > 50) throw Error('jobs must contain 1–50 entries');
  const ids = new Set(), urls = new Set();
  return jobs.flatMap(job => {
    if (!job || typeof job.id !== 'string' || !/^[\w.-]{1,80}$/.test(job.id) || ids.has(job.id)) throw Error('Job IDs must be unique and use letters, numbers, dots, underscores or dashes');
    ids.add(job.id);
    if (typeof job.url !== 'string') throw Error('Each job needs a URL string');
    if (job.answers !== undefined && (!job.answers || typeof job.answers !== 'object' || Array.isArray(job.answers))) throw Error('Job answers must be a JSON object');
    const url = new URL(job.url);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw Error('Use direct HTTPS application URLs (HTTP is allowed only for local tests)');
    if (/(^|\.)(linkedin\.com|joinhandshake\.com|myworkdayjobs\.com|myworkdaysite\.com)$/.test(url.hostname)) throw Error('Use a supported direct employer application form; LinkedIn, Handshake, and Workday flows require manual handling');
    if (urls.has(url.href)) return [];
    urls.add(url.href);
    return [{ id: job.id, url: url.href, answers: job.answers ?? {} }];
  });
}

export function redactUrl(input) {
  const url = new URL(input);
  return url.origin + url.pathname;
}
