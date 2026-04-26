// UI module that renders the suggestions feed into a container element
// supplied by the popup. Person D's popup imports `renderSuggestions`
// and calls it during their render cycle.
import suggestionsCss from './suggestions-section.css?inline';
import type { Suggestion } from '../shared/types';

const STYLE_FLAG = 'data-bob-suggestion-styles';
const CONTAINER_FLAG = 'data-bob-suggestion-bound';

function ensureStyles(): void {
  if (document.head.querySelector(`style[${STYLE_FLAG}]`)) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_FLAG, '');
  style.textContent = suggestionsCss;
  document.head.appendChild(style);
}

async function fetchSuggestions(hostname?: string): Promise<Suggestion[]> {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GET_SUGGESTIONS',
      hostname,
    });
    if (Array.isArray(res)) return res as Suggestion[];
    if (res && typeof res === 'object' && Array.isArray((res as { suggestions?: unknown }).suggestions)) {
      return (res as { suggestions: Suggestion[] }).suggestions;
    }
  } catch {
    // No background handler yet — render the empty state below.
  }
  return [];
}

async function dismiss(id: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'DISMISS_SUGGESTION', id });
  } catch {
    // Best effort.
  }
}

async function accept(id: string): Promise<{ proposedPrompt: string; hostname: string } | null> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'ACCEPT_SUGGESTION', id });
    if (
      res &&
      typeof res === 'object' &&
      typeof (res as { proposedPrompt?: unknown }).proposedPrompt === 'string' &&
      typeof (res as { hostname?: unknown }).hostname === 'string'
    ) {
      return res as { proposedPrompt: string; hostname: string };
    }
  } catch {
    // ignore
  }
  return null;
}

function buildEmptyState(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'bob-suggestion-empty';
  const a = document.createElement('p');
  a.textContent = 'No suggestions yet.';
  const b = document.createElement('p');
  b.textContent = 'BOB will propose features as it learns your patterns.';
  wrap.appendChild(a);
  wrap.appendChild(b);
  return wrap;
}

function buildCard(s: Suggestion): HTMLElement {
  const card = document.createElement('article');
  card.className = 'bob-suggestion-card';
  card.dataset.id = s.id;

  const tag = document.createElement('span');
  tag.className = 'bob-suggestion-tag';
  tag.textContent = '✨ Suggestion';

  const rationale = document.createElement('div');
  rationale.className = 'bob-suggestion-rationale';
  rationale.textContent = s.rationale;

  const prompt = document.createElement('p');
  prompt.className = 'bob-suggestion-prompt';
  prompt.textContent = s.proposedPrompt;

  const actions = document.createElement('div');
  actions.className = 'bob-suggestion-actions';

  const tryBtn = document.createElement('button');
  tryBtn.type = 'button';
  tryBtn.className = 'bob-suggestion-btn bob-suggestion-btn-primary';
  tryBtn.textContent = 'Try it';
  tryBtn.dataset.action = 'try';

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'bob-suggestion-btn bob-suggestion-btn-ghost';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.dataset.action = 'dismiss';

  actions.appendChild(tryBtn);
  actions.appendChild(dismissBtn);

  card.appendChild(tag);
  card.appendChild(rationale);
  card.appendChild(prompt);
  card.appendChild(actions);

  return card;
}

function renderInto(container: HTMLElement, suggestions: Suggestion[]): void {
  container.replaceChildren();
  if (suggestions.length === 0) {
    container.appendChild(buildEmptyState());
    return;
  }
  const list = document.createElement('div');
  list.className = 'bob-suggestion-list';
  for (const s of suggestions) list.appendChild(buildCard(s));
  container.appendChild(list);
}

function bindContainer(container: HTMLElement): void {
  if (container.getAttribute(CONTAINER_FLAG)) return;
  container.setAttribute(CONTAINER_FLAG, '');

  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const btn = target?.closest('button[data-action]') as HTMLButtonElement | null;
    if (!btn) return;
    const card = btn.closest('.bob-suggestion-card') as HTMLElement | null;
    const id = card?.dataset.id;
    if (!card || !id) return;
    const action = btn.dataset.action;
    if (action === 'try') {
      void (async () => {
        await accept(id);
        // The "open overlay on the matching tab" wiring lives on Person D /
        // the merger side. From here we just close the popup; that's the
        // contract documented in the integration patch.
        try {
          window.close();
        } catch {
          // No-op outside extension popup context.
        }
      })();
    } else if (action === 'dismiss') {
      void (async () => {
        await dismiss(id);
        card.remove();
        // If we just removed the last card, fall back to empty state so
        // the section doesn't leave a blank gap.
        const remainingList = container.querySelector('.bob-suggestion-list');
        if (remainingList && remainingList.children.length === 0) {
          renderInto(container, []);
        }
      })();
    }
  });
}

export async function renderSuggestions(
  container: HTMLElement,
  hostname: string | undefined,
): Promise<void> {
  ensureStyles();
  bindContainer(container);
  const suggestions = await fetchSuggestions(hostname);
  renderInto(container, suggestions);
}
