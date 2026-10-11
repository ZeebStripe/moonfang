import type { App } from '../app';
import { REPO_URL, VERSION, versionLabel } from '../meta';
import { openModal } from './actions';
import { checkbox, h } from './dom';

/**
 * Asks GitHub for the newest published release and, if it is newer than this build, shows "A new version is
 * available". Only the public release list is requested; nothing about the user or their work is sent.
 */
const API = `https://api.github.com/repos/${REPO_URL.split('github.com/')[1]}/releases?per_page=10`;
const PREF_AUTO = 'moonfang.updates.auto';
const PREF_SKIP = 'moonfang.updates.skip';

interface Release {
  tag_name: string;
  name: string | null;
  html_url: string;
  body: string | null;
  draft: boolean;
}

function pref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function setPref(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the preference just doesn't stick
  }
}

export const autoCheckEnabled = () => pref(PREF_AUTO) !== 'off';

/** Semver comparison including pre-releases: 0.1.0-beta < 0.1.0-beta.2 < 0.1.0-rc < 0.1.0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('-', 2);
    return { core: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre ? pre.split('.') : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

async function latestRelease(): Promise<Release | null> {
  const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const releases = (await res.json()) as Release[];
  // Beta builds are published as pre-releases, so consider those too; drafts are never visible here anyway.
  return releases.filter((r) => !r.draft).sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0] ?? null;
}

/**
 * `manual`: from Help → Check for Updates (always reports the outcome). Otherwise a quiet start-up check that
 * respects "don't check automatically" and "skip this version", and stays silent when offline.
 */
export async function checkForUpdates(app: App, manual = false) {
  if (!manual && (!autoCheckEnabled() || import.meta.env.DEV)) return;
  let rel: Release | null;
  try {
    rel = await latestRelease();
  } catch (e) {
    if (manual) app.toast(`Could not check for updates: ${e instanceof Error ? e.message : e}`, 'warn');
    return;
  }
  if (!rel || compareVersions(rel.tag_name, VERSION) <= 0) {
    if (manual) app.toast(`You have the latest version (${versionLabel(VERSION)}).`);
    return;
  }
  if (!manual && pref(PREF_SKIP) === rel.tag_name) return;
  showUpdate(rel, manual);
}

function showUpdate(rel: Release, manual: boolean) {
  const label = versionLabel(rel.tag_name);
  const download = h('button', { class: 'btn primary' }, 'Download');
  const later = h('button', { class: 'btn' }, 'Later');
  const skip = h('button', { class: 'btn' }, 'Skip this version');
  const notes = (rel.body ?? '').trim();
  const close = openModal(
    'A new version is available',
    h(
      'div',
      { class: 'form' },
      h('p', {}, `Moonfang ${label} is out (you have ${versionLabel(VERSION)}).`),
      notes ? h('div', { class: 'update-notes small' }, notes.length > 1500 ? `${notes.slice(0, 1500)}…` : notes) : null,
      h('p', { class: 'dim small' }, 'Download opens the release page in your browser. Your saves and library carry over to the new version.'),
      checkbox('Check for updates when Moonfang starts', autoCheckEnabled(), (v) => setPref(PREF_AUTO, v ? null : 'off')),
    ),
    manual ? [later, download] : [skip, later, download],
    undefined,
    // Centered on the 3D view, clear of the toasts at its lower right.
    document.getElementById('viewport-wrap') ?? undefined,
  );
  download.addEventListener('click', () => {
    window.open(rel.html_url, '_blank', 'noopener');
    close();
  });
  later.addEventListener('click', () => close());
  skip.addEventListener('click', () => {
    setPref(PREF_SKIP, rel.tag_name);
    close();
  });
}
