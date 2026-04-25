import overlayCss from './overlay.css?inline';
import type { Feature, GenerateResponse } from '../../shared/types';
import { buildPreviewView, populatePreview, showToast, type PreviewElements } from './preview';

export interface OnGenerateOptions {
  existingCode?: string;
  existingFeatureName?: string;
  parentFeatureId?: string;
  signal?: AbortSignal;
}

export interface OverlayCallbacks {
  onGenerate: (
    prompt: string,
    options?: OnGenerateOptions,
  ) => Promise<GenerateResponse>;
  onInstall: (
    feature: GenerateResponse & {
      userPrompt: string;
      parentFeatureId?: string;
      iterationNumber?: number;
    },
  ) => Promise<void>;
}

type State = 'closed' | 'open' | 'loading' | 'preview' | 'installing';

interface EditingContext {
  feature: Feature;
}

interface OverlayInstance {
  host: HTMLElement;
  root: ShadowRoot;
  backdrop: HTMLDivElement;
  modal: HTMLDivElement;
  promptView: HTMLDivElement;
  banner: HTMLDivElement;
  bannerText: HTMLSpanElement;
  input: HTMLInputElement;
  promptAction: HTMLButtonElement;
  promptActionLabel: HTMLSpanElement;
  status: HTMLDivElement;
  preview: PreviewElements;
  state: State;
  requestToken: number;
  originalPrompt: string;
  currentResponse: GenerateResponse | null;
  editing: EditingContext | null;
  installedTimer: ReturnType<typeof setTimeout> | null;
}

const HOST_TAG = 'bob-overlay-host';
const INSTALLED_DELAY_MS = 800;

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

  // Prompt action button label switches between Generate and Stop.
  if (next === 'loading') {
    instance.promptAction.classList.add('stop');
    instance.promptActionLabel.textContent = 'Stop';
    instance.promptAction.setAttribute('aria-label', 'Stop generation');
  } else {
    instance.promptAction.classList.remove('stop');
    instance.promptActionLabel.textContent = 'Generate';
    instance.promptAction.setAttribute('aria-label', 'Generate');
  }
}

function setEditing(ctx: EditingContext | null): void {
  if (!instance) return;
  instance.editing = ctx;
  if (ctx) {
    instance.banner.removeAttribute('hidden');
    instance.bannerText.textContent = ctx.feature.name || '(unnamed)';
    instance.backdrop.dataset.edit = 'true';
    instance.preview.installLabel.textContent = 'Update';
  } else {
    instance.banner.setAttribute('hidden', '');
    instance.bannerText.textContent = '';
    delete instance.backdrop.dataset.edit;
    instance.preview.installLabel.textContent = 'Install';
  }
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

  const editing = instance.editing;
  const options: OnGenerateOptions | undefined = editing
    ? {
        existingCode: editing.feature.code,
        existingFeatureName: editing.feature.name,
        parentFeatureId: editing.feature.id,
      }
    : undefined;

  try {
    const response = await callbacks.onGenerate(value, options);
    if (!instance || instance.requestToken !== token) return;
    instance.currentResponse = response;
    populatePreview(instance.preview, response);
    // Re-apply Update/Install label since populatePreview doesn't know.
    instance.preview.installLabel.textContent = editing ? 'Update' : 'Install';
    setState('preview');
    requestAnimationFrame(() => instance?.preview.nameInput.focus());
  } catch (err) {
    if (!instance || instance.requestToken !== token) return;
    const message = err instanceof Error ? err.message : String(err);
    setState('open');
    showPromptError(message || 'Something went wrong.');
  }
}

function stopGeneration(): void {
  if (!instance) return;
  if (instance.state !== 'loading') return;
  // Per spec's hackathon-mode "fake cancel": bump the token so the
  // in-flight onGenerate result is ignored when it eventually resolves,
  // then close the overlay. The integration side can later wire a real
  // AbortSignal through OnGenerateOptions.signal.
  instance.requestToken++;
  closeOverlay();
}

function markInstalledTransient(): void {
  if (!instance) return;
  const btn = instance.preview.installBtn;
  btn.classList.add('installed');
  instance.preview.installLabel.textContent = 'Installed ✓';
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

  const editing = instance.editing;
  const feature = {
    code: instance.currentResponse.code,
    name: editedName,
    description: instance.currentResponse.description,
    urlPattern: editedUrl,
    userPrompt: instance.originalPrompt,
    ...(editing
      ? {
          parentFeatureId: editing.feature.id,
          iterationNumber: (editing.feature.iterationNumber ?? 0) + 1,
        }
      : {}),
  };

  clearPreviewError();
  setState('installing');
  const token = ++instance.requestToken;

  try {
    await callbacks.onInstall(feature);
    if (!instance || instance.requestToken !== token) return;
    markInstalledTransient();
    if (instance.installedTimer) clearTimeout(instance.installedTimer);
    instance.installedTimer = setTimeout(() => {
      if (!instance || instance.requestToken !== token) return;
      const verb = editing ? 'Updated' : 'Installed';
      closeOverlay();
      showToast(`${verb}: ${editedName}`);
    }, INSTALLED_DELAY_MS);
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

  // Edit-mode banner
  const banner = document.createElement('div');
  banner.className = 'edit-banner';
  banner.setAttribute('hidden', '');
  const bannerLabel = document.createElement('span');
  bannerLabel.className = 'edit-banner-label';
  bannerLabel.textContent = 'Editing:';
  const bannerText = document.createElement('span');
  bannerText.className = 'edit-banner-name';
  const bannerClose = document.createElement('button');
  bannerClose.type = 'button';
  bannerClose.className = 'edit-banner-close';
  bannerClose.setAttribute('aria-label', 'Cancel edit');
  bannerClose.textContent = '×';
  bannerClose.addEventListener('click', () => closeOverlay());
  banner.appendChild(bannerLabel);
  banner.appendChild(bannerText);
  banner.appendChild(bannerClose);

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

  const promptAction = document.createElement('button');
  promptAction.type = 'button';
  promptAction.className = 'prompt-action btn btn-primary';
  const promptActionLabel = document.createElement('span');
  promptActionLabel.textContent = 'Generate';
  promptAction.appendChild(promptActionLabel);
  promptAction.setAttribute('aria-label', 'Generate');
  promptAction.addEventListener('click', () => {
    if (!instance) return;
    if (instance.state === 'loading') stopGeneration();
    else if (instance.state === 'open') void submitPrompt();
  });

  row.appendChild(input);
  row.appendChild(spinner);
  row.appendChild(promptAction);

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

  promptView.appendChild(banner);
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
    banner,
    bannerText,
    input,
    promptAction,
    promptActionLabel,
    status,
    preview,
    state: 'closed',
    requestToken: 0,
    originalPrompt: '',
    currentResponse: null,
    editing: null,
    installedTimer: null,
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

export function openOverlayForEdit(feature: Feature): void {
  if (!instance) return;
  // If we're mid-flight on something else, bump the token so it's discarded.
  instance.requestToken++;
  if (instance.installedTimer) {
    clearTimeout(instance.installedTimer);
    instance.installedTimer = null;
  }
  // Reset any stale state, then enter edit mode.
  instance.currentResponse = null;
  clearPromptError();
  clearPreviewError();
  instance.preview.installBtn.classList.remove('installed');
  setEditing({ feature });
  instance.input.value = feature.userPrompt ?? '';
  instance.originalPrompt = instance.input.value;
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
  if (instance.installedTimer) {
    clearTimeout(instance.installedTimer);
    instance.installedTimer = null;
  }
  clearPromptError();
  clearPreviewError();
  setState('closed');
  setEditing(null);
  instance.input.value = '';
  instance.originalPrompt = '';
  instance.currentResponse = null;
  instance.preview.installBtn.classList.remove('installed');
  instance.preview.installLabel.textContent = 'Install';
}
