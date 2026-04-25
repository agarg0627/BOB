import overlayCss from './overlay.css?inline';
import type { GenerateResponse } from '../../shared/types';
import { buildPreviewView, populatePreview, showToast, type PreviewElements } from './preview';

export interface OverlayCallbacks {
  onGenerate: (prompt: string) => Promise<GenerateResponse>;
  onInstall: (feature: GenerateResponse & { userPrompt: string }) => Promise<void>;
}

type State = 'closed' | 'open' | 'loading' | 'preview' | 'installing';

interface OverlayInstance {
  host: HTMLElement;
  root: ShadowRoot;
  backdrop: HTMLDivElement;
  modal: HTMLDivElement;
  promptView: HTMLDivElement;
  input: HTMLInputElement;
  status: HTMLDivElement;
  preview: PreviewElements;
  state: State;
  requestToken: number;
  originalPrompt: string;
  currentResponse: GenerateResponse | null;
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
  instance.preview.installBtn.disabled = next === 'installing';
  instance.preview.cancelBtn.disabled = next === 'installing';
}

function showPromptError(message: string): void {
  if (!instance) return;
  instance.status.textContent = message;
  instance.status.classList.add('visible');
  requestAnimationFrame(() => instance?.input.focus());
}

function clearPromptError(): void {
  if (!instance) return;
  if (!instance.status.classList.contains('visible')) return;
  instance.status.textContent = '';
  instance.status.classList.remove('visible');
}

function showPreviewError(message: string): void {
  if (!instance) return;
  instance.preview.status.textContent = message;
  instance.preview.status.classList.add('visible');
}

function clearPreviewError(): void {
  if (!instance) return;
  if (!instance.preview.status.classList.contains('visible')) return;
  instance.preview.status.textContent = '';
  instance.preview.status.classList.remove('visible');
}

async function submitPrompt(): Promise<void> {
  if (!instance || !callbacks) return;
  if (instance.state !== 'open') return;
  const value = instance.input.value.trim();
  if (value.length === 0) return;

  instance.originalPrompt = value;
  clearPromptError();
  setState('loading');
  const token = ++instance.requestToken;

  try {
    const response = await callbacks.onGenerate(value);
    if (!instance || instance.requestToken !== token) return;
    instance.currentResponse = response;
    populatePreview(instance.preview, response);
    setState('preview');
    requestAnimationFrame(() => instance?.preview.nameInput.focus());
  } catch (err) {
    if (!instance || instance.requestToken !== token) return;
    const message = err instanceof Error ? err.message : String(err);
    setState('open');
    showPromptError(message || 'Something went wrong.');
  }
}

async function install(): Promise<void> {
  if (!instance || !callbacks) return;
  if (instance.state !== 'preview') return;
  if (!instance.currentResponse) return;

  const editedName = instance.preview.nameInput.value.trim();
  const editedUrl = instance.preview.urlInput.value.trim();

  if (editedName.length === 0) {
    showPreviewError('Name cannot be empty.');
    return;
  }
  if (editedUrl.length === 0) {
    showPreviewError('URL pattern cannot be empty.');
    return;
  }

  const feature = {
    code: instance.currentResponse.code,
    name: editedName,
    description: instance.currentResponse.description,
    urlPattern: editedUrl,
    userPrompt: instance.originalPrompt,
  };

  clearPreviewError();
  setState('installing');
  const token = ++instance.requestToken;

  try {
    await callbacks.onInstall(feature);
    if (!instance || instance.requestToken !== token) return;
    closeOverlay();
    showToast(`Installed: ${editedName}`);
  } catch (err) {
    if (!instance || instance.requestToken !== token) return;
    const message = err instanceof Error ? err.message : String(err);
    setState('preview');
    showPreviewError(message || 'Install failed.');
  }
}

function cancelPreview(): void {
  if (!instance) return;
  if (instance.state !== 'preview') return;
  clearPreviewError();
  instance.requestToken++;
  setState('open');
  instance.input.value = instance.originalPrompt;
  requestAnimationFrame(() => {
    instance?.input.focus();
    instance?.input.select();
  });
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
  modal.setAttribute('aria-label', 'BOB');

  // --- Prompt view ---
  const promptView = document.createElement('div');
  promptView.className = 'view view-prompt';

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

  promptView.appendChild(row);
  promptView.appendChild(status);
  promptView.appendChild(hint);

  // --- Preview view ---
  const preview = buildPreviewView();

  modal.appendChild(promptView);
  modal.appendChild(preview.root);
  backdrop.appendChild(modal);
  root.appendChild(backdrop);

  // Backdrop click closes (only when click lands on backdrop, not modal contents)
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target !== backdrop) return;
    closeOverlay();
  });

  // Capture-phase keydown — handle our shortcuts before they reach inputs
  backdrop.addEventListener(
    'keydown',
    (e) => {
      if (!instance) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeOverlay();
        return;
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        if (instance.state === 'preview') {
          e.preventDefault();
          e.stopPropagation();
          void install();
        }
        return;
      }
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (instance.state === 'open' && e.target === input) {
          e.preventDefault();
          e.stopPropagation();
          void submitPrompt();
        }
        return;
      }
    },
    true,
  );

  // Bubble-phase swallow — keep host page shortcuts inert while overlay is open
  const swallow = (e: Event): void => {
    e.stopPropagation();
  };
  backdrop.addEventListener('keydown', swallow);
  backdrop.addEventListener('keyup', swallow);
  backdrop.addEventListener('keypress', swallow);

  // Clear error visuals when the user starts typing again
  input.addEventListener('input', () => {
    if (!instance) return;
    if (instance.state === 'open' || instance.state === 'loading') {
      clearPromptError();
    }
  });
  preview.nameInput.addEventListener('input', clearPreviewError);
  preview.urlInput.addEventListener('input', clearPreviewError);

  // Preview button clicks
  preview.installBtn.addEventListener('click', () => void install());
  preview.cancelBtn.addEventListener('click', cancelPreview);

  return {
    host,
    root,
    backdrop,
    modal,
    promptView,
    input,
    status,
    preview,
    state: 'closed',
    requestToken: 0,
    originalPrompt: '',
    currentResponse: null,
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
      if (!instance) return;
      e.preventDefault();
      e.stopPropagation();
      if (instance.state === 'closed') openOverlay();
      else if (instance.state === 'open') closeOverlay();
      // ignored in loading / preview / installing — Esc is the universal close
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
  if (instance.state !== 'closed') return;
  setState('open');
  requestAnimationFrame(() => {
    instance?.input.focus();
    instance?.input.select();
  });
}

export function closeOverlay(): void {
  if (!instance) return;
  // Bump the token so any in-flight onGenerate / onInstall result is discarded
  instance.requestToken++;
  clearPromptError();
  clearPreviewError();
  setState('closed');
  instance.input.value = '';
  instance.originalPrompt = '';
  instance.currentResponse = null;
}
