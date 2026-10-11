import type { App } from '../app';
import { errorLog, hasErrors } from '../errors';
import { bugReportUrl, environmentInfo, REPORT_ENDPOINT, VERSION_LABEL } from '../meta';
import { errorMessage, openModal } from './actions';
import { checkbox, h } from './dom';

const isDesktop = () => !!(window as unknown as { moonfangDesktop?: unknown }).moonfangDesktop;

/** Opens the GitHub issue form (needs a GitHub account; the user submits it there). */
function openGithubForm(app: App) {
  window.open(bugReportUrl(app.renderer.getContext(), errorLog()), '_blank', 'noopener');
}

/**
 * Help → Report a Bug (and the "Something went wrong" toast). With the report relay configured, this is an in-app
 * form that sends nothing until the user presses Send, and shows exactly what will be sent. Without it, the
 * prefilled GitHub issue form opens in the browser.
 */
export function reportBug(app: App) {
  if (!REPORT_ENDPOINT) return openGithubForm(app);

  const env = environmentInfo(app.renderer.getContext());
  const edition = isDesktop() ? 'Desktop app' : 'Web browser';
  const description = h('textarea', { rows: 4, placeholder: 'What were you doing, and what went wrong?', maxLength: 4000 }) as HTMLTextAreaElement;
  const steps = h('textarea', { rows: 3, placeholder: '1. Open the Vase demo mesh\n2. …', maxLength: 4000 }) as HTMLTextAreaElement;
  // Invisible to people; bots that fill every field give themselves away.
  const honeypot = h('input', { type: 'text', name: 'website', tabIndex: -1, autocomplete: 'off', style: { position: 'absolute', left: '-9999px' } }) as HTMLInputElement;
  let includeLogs = hasErrors();
  const preview = h('pre', { class: 'report-preview' });
  const renderPreview = () => {
    preview.textContent = [`Moonfang version: ${VERSION_LABEL}`, `Run as: ${edition}`, env, includeLogs ? `\nErrors:\n${errorLog(6000) || '(none)'}` : ''].join('\n');
  };
  renderPreview();

  const send = h('button', { class: 'btn primary' }, 'Send report');
  const github = h('button', { class: 'btn' }, 'Use GitHub instead');
  const close = openModal(
    'Report a bug',
    h(
      'div',
      { class: 'form report' },
      h('div', { class: 'field' }, h('label', {}, 'What happened?'), description),
      h('div', { class: 'field' }, h('label', {}, 'Steps to reproduce (optional)'), steps),
      hasErrors()
        ? checkbox('Include the errors Moonfang recorded in this session', includeLogs, (v) => {
            includeLogs = v;
            renderPreview();
          })
        : null,
      h('details', {}, h('summary', { class: 'dim small' }, 'What will be sent along with your text'), preview),
      h(
        'p',
        { class: 'dim small' },
        'Your report goes privately to the Moonfang developer. Nothing about your projects or files is included unless you type it. Your IP address is only used briefly to prevent spam and is not stored with the report.',
      ),
      honeypot,
    ),
    [github, send],
  );

  github.addEventListener('click', () => {
    openGithubForm(app);
    close();
  });
  send.addEventListener('click', async () => {
    if (!description.value.trim() && !includeLogs) {
      description.focus();
      return app.toast('Describe what happened first.', 'warn');
    }
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      const res = await fetch(REPORT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: description.value.trim(),
          steps: steps.value.trim(),
          version: VERSION_LABEL,
          edition,
          environment: env,
          logs: includeLogs ? errorLog(6000) : '',
          website: honeypot.value,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { number?: number; url?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `the server answered ${res.status}`);
      close();
      app.toast(
        `Thanks! Your report was sent${data.number ? ` (#${data.number})` : ''}.`,
        'info',
        data.url ? { label: 'View', run: () => window.open(data.url, '_blank', 'noopener') } : undefined,
      );
    } catch (e) {
      send.disabled = false;
      send.textContent = 'Send report';
      app.toast(`Could not send the report: ${errorMessage(e)}. You can use GitHub instead.`, 'error');
    }
  });
  description.focus();
}
