// Owned by Person B.
import overlayCss from './overlay.css?inline';

export interface OverlayCallbacks {
  onSubmit: (prompt: string) => Promise<void>;
}

type State = 'closed' | 'open' | 'loading' | 'error';

interface OverlayInstance {
  host: HTMLElement;
  root: ShadowRoot;
  backdrop: HTMLDivElement;
  input: HTMLInputElement;
  status: HTMLDivElement;
  state: State;
}

const HOST_TAG = 'bob-overlay-host';

let instance: OverlayInstance | null = null;
let callbacks: OverlayCallbacks | null = null;
let keydownAttached = false;

function setState(next: State): void {
  if (!instance) return;
  instance.state = next;
  instance.backdrop.dataset.state = next;
  instance.input.disabled = next === 'loading';
  if (next !== 'error') {
    instance.status.textContent = '';
  }
}

function showError(message: string): void {
  if (!instance) return;
  instance.status.textContent = message;
  setState('error');
  // Re-focus so the user can retry without grabbing the mouse.
  requestAnimationFrame(() => instance?.input.focus());
}

async function submit(): Promise<void> {
  if (!instance || !callbacks) return;
  if (instance.state === 'loading') return;
  const value = instance.input.value.trim();
  if (value.length === 0) return;
  setState('loading');
  try {
    await callbacks.onSubmit(value);
    if (!instance) return;
    instance.input.value = '';
    setState('closed');
    instance.input.blur();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showError(message || 'Something went wrong.');
  }
}

function buildOverlay(): OverlayInstance {
  const host = document.createElement(HOST_TAG);
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = overlayCss;
  root.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.dataset.state = 'closed';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'BOB prompt');

  const row = document.createElement('div');
  row.className = 'row';

  const input = document.createElement('input');
  input.className = 'prompt';
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'What do you want to change about this page?';
  input.setAttribute('aria-label', 'Prompt');

  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');

  row.appendChild(input);
  row.appendChild(spinner);

  const status = document.createElement('div');
  status.className = 'status';
  status.setAttribute('role', 'alert');
  status.setAttribute('aria-live', 'polite');

  const hint = document.createElement('div');
  hint.className = 'hint';
  const left = document.createElement('span');
  left.textContent = 'BOB';
  const right = document.createElement('span');
  const enterKbd = document.createElement('kbd');
  enterKbd.textContent = 'Enter';
  const escKbd = document.createElement('kbd');
  escKbd.textContent = 'Esc';
  right.appendChild(enterKbd);
  right.appendChild(document.createTextNode(' to submit · '));
  right.appendChild(escKbd);
  right.appendChild(document.createTextNode(' to close'));
  hint.appendChild(left);
  hint.appendChild(right);

  modal.appendChild(row);
  modal.appendChild(status);
  modal.appendChild(hint);
  backdrop.appendChild(modal);
  root.appendChild(backdrop);

  // Backdrop click closes (only when the click is on the backdrop itself,
  // not bubbling up from modal contents). Ignored while loading.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target !== backdrop) return;
    if (instance?.state === 'loading') return;
    closeOverlay();
  });

  // Single keydown handler on the input: Esc closes, Enter submits, all
  // other keys are swallowed so the host page can't react to them
  // (e.g. GitHub's single-key shortcuts, "/" focusing search, etc.).
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      if (instance?.state === 'loading') return;
      e.preventDefault();
      closeOverlay();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
      return;
    }
  });
  input.addEventListener('keyup', (e) => {
    e.stopPropagation();
  });
  input.addEventListener('keypress', (e) => {
    e.stopPropagation();
  });

  // When the user clears the error and starts typing again, drop the error
  // visual but keep focus where it is.
  input.addEventListener('input', () => {
    if (instance?.state === 'error') {
      setState('open');
    }
  });

  return {
    host,
    root,
    backdrop,
    input,
    status,
    state: 'closed',
  };
}

function ensureKeydownListener(): void {
  if (keydownAttached) return;
  keydownAttached = true;
  // Capture phase so we beat the host page's own Cmd+K handlers
  // (GitHub, Slack, Twitter all bind it).
  window.addEventListener(
    'keydown',
    (e) => {
      const isToggle = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (!isToggle) return;
      // Only swallow the event once we know the overlay is wired up.
      if (!instance) return;
      e.preventDefault();
      e.stopPropagation();
      if (instance.state === 'closed') openOverlay();
      else if (instance.state !== 'loading') closeOverlay();
    },
    true,
  );
}

export function initOverlay(cb: OverlayCallbacks): void {
  callbacks = cb;
  if (!instance) {
    instance = buildOverlay();
    document.body.appendChild(instance.host);
  }
  ensureKeydownListener();
}

export function openOverlay(): void {
  if (!instance) return;
  if (instance.state === 'loading') return;
  setState('open');
  // Focus on the next frame so the browser has applied the visibility
  // change first; otherwise some sites steal focus back.
  requestAnimationFrame(() => {
    instance?.input.focus();
    instance?.input.select();
  });
}

export function closeOverlay(): void {
  if (!instance) return;
  if (instance.state === 'loading') return;
  setState('closed');
  instance.input.blur();
}
