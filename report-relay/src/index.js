/**
 * Moonfang bug-report relay (Cloudflare Worker).
 *
 * The app POSTs a report (only when the user presses Send in its report dialog); this Worker turns it into a GitHub
 * issue. The GitHub token lives here as a secret and never ships with the app, so it can't be extracted and abused.
 *
 * Environment:
 *   GITHUB_TOKEN  secret: fine-grained token with "Issues: read and write" on GITHUB_REPO only
 *   GITHUB_REPO   "owner/repo" the issues go to (a private repo keeps reports, which include system info, private)
 *   PUBLIC_REPO   "true" if GITHUB_REPO is public: the app then gets the issue link back to show the user
 *   RATE          optional KV namespace for rate limiting (strongly recommended)
 */

const MAX_BODY_BYTES = 32 * 1024;
const PER_IP_PER_HOUR = 5;
const PER_DAY = 200;

const LIMITS = { description: 4000, steps: 4000, version: 40, environment: 2000, logs: 6000, edition: 60 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/** Keeps user text from breaking out of code blocks or pinging GitHub users. */
const neutralize = (s) => s.replace(/```/g, '`​``').replace(/@(?=\w)/g, '@​');

async function hash(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Counts a request against a KV key with a TTL; returns false once `max` is reached. */
async function allow(kv, key, max, ttl) {
  const n = Number((await kv.get(key)) ?? 0);
  if (n >= max) return false;
  await kv.put(key, String(n + 1), { expirationTtl: ttl });
  return true;
}

function validate(r) {
  if (!r || typeof r !== 'object') return 'Invalid report.';
  if (r.website) return 'Invalid report.'; // honeypot field, invisible in the app
  for (const [k, max] of Object.entries(LIMITS)) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== 'string' || r[k].length > max) return `Field "${k}" is too long or not text.`;
  }
  if (!r.version || !/^[\w .()-]+$/.test(r.version)) return 'Missing app version.';
  if (!(r.description ?? '').trim() && !(r.logs ?? '').trim()) return 'Describe what happened.';
  return null;
}

function issueFor(r) {
  const firstLine = (s) => (s ?? '').trim().split('\n')[0].slice(0, 80);
  const summary = firstLine(r.description) || firstLine(r.logs) || 'Bug report';
  const section = (title, text, code) => (text && text.trim() ? `### ${title}\n\n${code ? '```text\n' : ''}${neutralize(text.trim())}${code ? '\n```' : ''}\n\n` : '');
  return {
    title: `[Report] ${neutralize(summary)}`,
    body:
      section('What happened?', r.description) +
      section('Steps to reproduce', r.steps) +
      `### Moonfang version\n\n${neutralize(r.version)}\n\n` +
      section('How Moonfang was run', r.edition) +
      section('System', r.environment, true) +
      section('Error details', r.logs, true) +
      '_Sent from the in-app report dialog._',
    labels: ['bug', 'user-report'],
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/report') return json(404, { error: 'Not found.' });
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return json(503, { error: 'Reporting is not configured.' });

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'Report is too large.' });
    let report;
    try {
      report = JSON.parse(raw);
    } catch {
      return json(400, { error: 'Invalid report.' });
    }
    const problem = validate(report);
    if (problem) return json(400, { error: problem });

    if (env.RATE) {
      // Only a salted hash of the IP is kept, for an hour, to stop floods.
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      const who = await hash(`${ip}|${env.GITHUB_REPO}`);
      if (!(await allow(env.RATE, `ip:${who}`, PER_IP_PER_HOUR, 3600))) return json(429, { error: 'Too many reports from your connection; please try again later.' });
      const day = new Date().toISOString().slice(0, 10);
      if (!(await allow(env.RATE, `day:${day}`, PER_DAY, 2 * 86400))) return json(429, { error: 'The report inbox is full for today; please try again tomorrow.' });
    }

    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'moonfang-report-relay',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(issueFor(report)),
    });
    if (!res.ok) return json(502, { error: 'Could not file the report right now.' });
    const issue = await res.json();
    return json(201, { ok: true, number: issue.number, url: env.PUBLIC_REPO === 'true' ? issue.html_url : undefined });
  },
};
