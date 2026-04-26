import overlayCss from './overlay.css?inline';
import type { Feature, GenerateResponse, KeybindSettings } from '../../shared/types';
import { buildPreviewView, populatePreview, showToast, type PreviewElements } from './preview';
import { isVoiceSupported, startVoiceInput } from '../voice-input';
import { eventToHotkey } from '../../shared/hotkey';

// ---- Public types ----

export interface OnGenerateOptions {
  existingCode?: string;
  existingFeatureName?: string;
  parentFeatureId?: string;
  signal?: AbortSignal;
  refinementHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  effortMode?: 'standard' | 'high';
  onProgress?: (event: { type: 'status' | 'thinking'; text: string }) => void;
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
  ) => Promise<{ id: string } | void>;
  // Optional: returns up to N most-recent userPrompts (deduped, newest
  // first) to render as recent-prompt chips in the empty 'open' state.
  onLoadRecentPrompts?: () => Promise<string[]>;
}

type State = 'closed' | 'open' | 'loading' | 'preview' | 'installing' | 'refine';

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
  input: HTMLTextAreaElement;
  chipsContainer: HTMLDivElement;
  micBtn: HTMLButtonElement;
  effortCheckbox: HTMLInputElement;
  refineBanner: HTMLDivElement;
  refineBannerLabel: HTMLSpanElement;
  refineBannerName: HTMLSpanElement;
  helpBtn: HTMLButtonElement;
  helpPopover: HTMLDivElement;
  promptAction: HTMLButtonElement;
  promptActionLabel: HTMLSpanElement;
  progressLog: HTMLDivElement;
  thinkingDisclosure: HTMLDetailsElement;
  thinkingContent: HTMLDivElement;
  status: HTMLDivElement;
  preview: PreviewElements;
  state: State;
  requestToken: number;
  originalPrompt: string;
  currentResponse: GenerateResponse | null;
  editing: EditingContext | null;
  installedTimer: ReturnType<typeof setTimeout> | null;
  // Refinement state
  refinementCount: number;
  refinementHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  installedFeatureId: string | null;
  installedFeatureName: string;
  installedCode: string;
  // 'edit' = entered via Edit button (banner reads "Editing:");
  // 'refine' = entered after a fresh install (banner reads "Installed ✓").
  // Functionally identical refine state, only the banner copy differs.
  entryMode: 'edit' | 'refine';
  // Most-recent userPrompts cached at openOverlay time. Rendered as
  // chips ahead of INITIAL_CHIPS when input is empty.
  recentPrompts: string[];
  // Voice
  stopVoice: (() => void) | null;
}

// ---- Constants ----

const HOST_TAG = 'bob-overlay-host';
const INSTALLED_DELAY_MS = 800;

const INITIAL_CHIPS = [
  'Hide distracting elements',
  'Add a useful button',
  'Make text bigger',
  'Reformat the page',
];

const REFINE_CHIPS = [
  'Make it smaller',
  'Apply more broadly',
  'Add a tooltip',
  'Undo this',
];

// ---- Module state ----

let instance: OverlayInstance | null = null;
let callbacks: OverlayCallbacks | null = null;
let keydownAttached = false;

// Configured keybinds. Defaults match background/settings.ts so the
// overlay still toggles on Cmd+K before the content script has had a
// chance to load and forward the user's settings.
const DEFAULT_KEYBINDS: KeybindSettings = {
  overlay: 'Ctrl+K',
  refineLast: 'Ctrl+I',
  quickToggle: 'Ctrl+Shift+Y',
};
let cachedKeybinds: KeybindSettings = { ...DEFAULT_KEYBINDS };

export function setOverlayKeybinds(next: Partial<KeybindSettings>): void {
  cachedKeybinds = {
    overlay: next.overlay || DEFAULT_KEYBINDS.overlay,
    refineLast: next.refineLast || DEFAULT_KEYBINDS.refineLast,
    quickToggle: next.quickToggle || DEFAULT_KEYBINDS.quickToggle,
  };
  refreshKbdHelp();
}

// Render the keyboard-shortcuts popover from the current cached
// keybinds. Called on overlay build and again whenever keybinds change.
function refreshKbdHelp(): void {
  if (!instance) return;
  const dl = instance.helpPopover.querySelector('dl');
  if (!dl) return;
  const items: Array<[string, string]> = [
    [cachedKeybinds.overlay, 'Open / close BOB'],
    ['Ctrl+Enter', 'Submit'],
    ['Esc', 'Close'],
    [cachedKeybinds.refineLast, 'Refine last feature for this site'],
    [cachedKeybinds.quickToggle, 'Quick-toggle bar'],
  ];
  dl.replaceChildren();
  for (const [k, v] of items) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
}

// ---- Effort mode ----

function getEffortMode(): 'standard' | 'high' {
  try {
    return sessionStorage.getItem('bob-effort-mode') === 'high' ? 'high' : 'standard';
  } catch {
    return 'standard';
  }
}

function setEffortMode(mode: 'standard' | 'high'): void {
  try {
    sessionStorage.setItem('bob-effort-mode', mode);
  } catch {
    // storage unavailable
  }
}

// ---- Textarea auto-grow ----

function autoGrow(): void {
  if (!instance) return;
  const ta = instance.input;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
}

// ---- Chip management ----

const RECENT_CHIP_MAX_LEN = 28;

interface ChipDescriptor {
  text: string;       // what to fill into the input on click
  display: string;    // truncated label rendered on the chip
  tooltip?: string;   // full text for the title attribute
  variant: 'static' | 'recent' | 'done';
}

function makeChip(d: ChipDescriptor): HTMLButtonElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  if (d.variant === 'done') chip.classList.add('chip-done');
  if (d.variant === 'recent') chip.classList.add('chip-recent');
  chip.textContent = d.display;
  if (d.tooltip) chip.title = d.tooltip;
  chip.addEventListener('click', () => {
    if (!instance) return;
    if (d.variant === 'done') {
      closeOverlay();
      return;
    }
    instance.input.value = d.text;
    instance.input.focus();
    autoGrow();
    updateChips();
  });
  return chip;
}

function updateChips(): void {
  if (!instance) return;
  const container = instance.chipsContainer;
  container.replaceChildren();

  let descriptors: ChipDescriptor[] = [];

  if (instance.state === 'refine') {
    const list = instance.refinementCount >= 3
      ? [...REFINE_CHIPS, 'Done']
      : REFINE_CHIPS;
    descriptors = list.map((t) => ({
      text: t,
      display: t,
      variant: t === 'Done' ? 'done' : 'static',
    }));
  } else if (
    instance.state === 'open' &&
    instance.input.value.length === 0
  ) {
    // Recent prompts first (already deduped + capped by the loader).
    for (const p of instance.recentPrompts) {
      const display =
        p.length > RECENT_CHIP_MAX_LEN
          ? p.slice(0, RECENT_CHIP_MAX_LEN - 1) + '…'
          : p;
      descriptors.push({
        text: p,
        display,
        tooltip: p,
        variant: 'recent',
      });
    }
    for (const t of INITIAL_CHIPS) {
      descriptors.push({ text: t, display: t, variant: 'static' });
    }
  }

  if (descriptors.length === 0) {
    container.setAttribute('hidden', '');
    return;
  }

  for (const d of descriptors) container.appendChild(makeChip(d));
  container.removeAttribute('hidden');
}

// Refresh the recent-prompt cache by asking the host (content script) for
// the most-recent userPrompts. Best-effort — failure leaves the cache
// untouched. Re-runs updateChips so chips appear as soon as data arrives,
// even if the user is already looking at the empty 'open' state.
async function refreshRecentPrompts(): Promise<void> {
  if (!instance || !callbacks?.onLoadRecentPrompts) return;
  try {
    const list = await callbacks.onLoadRecentPrompts();
    if (!instance) return;
    instance.recentPrompts = Array.isArray(list) ? list.slice(0, 3) : [];
    updateChips();
  } catch {
    // Silent — chips just don't refresh.
  }
}

// ---- State management ----

function setState(next: State): void {
  if (!instance) return;
  instance.state = next;
  instance.backdrop.dataset.state = next;
  instance.input.disabled = next === 'loading';
  instance.preview.installBtn.disabled = next === 'installing';
  instance.preview.cancelBtn.disabled = next === 'installing';

  if (next === 'loading') {
    instance.promptAction.classList.add('stop');
    instance.promptActionLabel.textContent = 'Stop';
    instance.promptAction.setAttribute('aria-label', 'Stop generation');
  } else if (next === 'refine') {
    instance.promptAction.classList.remove('stop');
    instance.promptActionLabel.textContent = 'Refine';
    instance.promptAction.setAttribute('aria-label', 'Refine');
  } else {
    instance.promptAction.classList.remove('stop');
    instance.promptActionLabel.textContent = 'Build it';
    instance.promptAction.setAttribute('aria-label', 'Build it');
  }

  updateChips();
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

function setRefineMode(
  id: string,
  name: string,
  code: string,
  entryMode: 'edit' | 'refine' = 'refine',
): void {
  if (!instance) return;
  instance.installedFeatureId = id;
  instance.installedFeatureName = name;
  instance.installedCode = code;
  instance.entryMode = entryMode;
  instance.refineBannerLabel.textContent =
    entryMode === 'edit' ? 'Editing:' : 'Installed ✓';
  instance.refineBanner.removeAttribute('hidden');
  instance.refineBannerName.textContent = name;
  // Clear editing context — the legacy `editing` state is not used in
  // refine entry; refine is the unified path.
  setEditing(null);
}

function clearRefineMode(): void {
  if (!instance) return;
  instance.installedFeatureId = null;
  instance.installedFeatureName = '';
  instance.installedCode = '';
  instance.refinementCount = 0;
  instance.refinementHistory = [];
  instance.entryMode = 'refine';
  instance.refineBanner.setAttribute('hidden', '');
  instance.refineBannerName.textContent = '';
  instance.refineBannerLabel.textContent = 'Installed ✓';
}

// ---- Error display ----

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

// ---- Progress display ----

const MAX_PROGRESS_LINES = 3;

function showProgressMessage(text: string): void {
  if (!instance) return;
  const log = instance.progressLog;

  const line = document.createElement('div');
  line.className = 'progress-line';
  line.textContent = text;

  log.appendChild(line);

  // Cap visible lines
  while (log.children.length > MAX_PROGRESS_LINES) {
    log.removeChild(log.firstChild!);
  }
}

function clearProgress(): void {
  if (!instance) return;
  instance.progressLog.replaceChildren();
  clearThinking();
}

function appendThinking(text: string): void {
  if (!instance) return;
  const disc = instance.thinkingDisclosure;
  const content = instance.thinkingContent;
  // Show the disclosure element
  disc.removeAttribute('hidden');
  // Append text (each call may be a full thinking block from one iteration)
  if (content.textContent) {
    content.textContent += '\n\n' + text;
  } else {
    content.textContent = text;
  }
  // Auto-scroll to bottom
  content.scrollTop = content.scrollHeight;
}

function clearThinking(): void {
  if (!instance) return;
  instance.thinkingDisclosure.setAttribute('hidden', '');
  instance.thinkingDisclosure.removeAttribute('open');
  instance.thinkingContent.textContent = '';
}

// ---- Actions ----

async function submitPrompt(): Promise<void> {
  if (!instance || !callbacks) return;
  if (instance.state !== 'open' && instance.state !== 'refine') return;
  const value = instance.input.value.trim();
  if (value.length === 0) return;

  const wasRefining = instance.state === 'refine';
  instance.originalPrompt = value;
  clearPromptError();
  clearProgress();
  setState('loading');
  const token = ++instance.requestToken;

  const effortMode = getEffortMode();
  const progressCb = (event: { type: 'status' | 'thinking'; text: string }) => {
    if (!instance || instance.requestToken !== token) return;
    if (event.type === 'thinking') {
      appendThinking(event.text);
    } else {
      showProgressMessage(event.text);
    }
  };
  let options: OnGenerateOptions | undefined;

  if (wasRefining && instance.installedFeatureId) {
    // Refinement: pass existing code and history
    instance.refinementHistory.push({ role: 'user', content: value });
    // Cap refinement history at last 6 entries to keep prompts under context limits
    const cappedHistory = instance.refinementHistory.length > 6
      ? instance.refinementHistory.slice(-6)
      : [...instance.refinementHistory];
    options = {
      existingCode: instance.installedCode,
      existingFeatureName: instance.installedFeatureName,
      parentFeatureId: instance.installedFeatureId,
      refinementHistory: cappedHistory,
      effortMode: effortMode !== 'standard' ? effortMode : undefined,
      onProgress: progressCb,
    };
  } else if (instance.editing) {
    // Editing an existing feature
    options = {
      existingCode: instance.editing.feature.code,
      existingFeatureName: instance.editing.feature.name,
      parentFeatureId: instance.editing.feature.id,
      effortMode: effortMode !== 'standard' ? effortMode : undefined,
      onProgress: progressCb,
    };
  } else {
    options = {
      effortMode: effortMode !== 'standard' ? effortMode : undefined,
      onProgress: progressCb,
    };
  }

  try {
    const response = await callbacks.onGenerate(value, options);
    if (!instance || instance.requestToken !== token) return;
    instance.currentResponse = response;
    populatePreview(instance.preview, response);
    instance.preview.installLabel.textContent =
      (wasRefining || instance.editing) ? 'Update' : 'Install';
    setState('preview');
    requestAnimationFrame(() => instance?.preview.nameInput.focus());
  } catch (err) {
    if (!instance || instance.requestToken !== token) return;
    const message = err instanceof Error ? err.message : String(err);
    setState(wasRefining ? 'refine' : 'open');
    showPromptError(message || 'Something went wrong.');
  }
}

function stopGeneration(): void {
  if (!instance) return;
  if (instance.state !== 'loading') return;
  instance.requestToken++;
  if (instance.installedFeatureId) {
    // Return to refine state if we were refining
    setState('refine');
    instance.input.value = '';
    autoGrow();
  } else {
    closeOverlay();
  }
}

function markInstalledTransient(): void {
  if (!instance) return;
  const btn = instance.preview.installBtn;
  btn.classList.add('installed');
  instance.preview.installLabel.textContent = 'Installed \u2713';
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

  const isRefinement = !!instance.installedFeatureId;
  const editing = instance.editing;

  const feature = {
    code: instance.currentResponse.code,
    name: editedName,
    description: instance.currentResponse.description,
    urlPattern: editedUrl,
    userPrompt: instance.originalPrompt,
    ...(isRefinement
      ? {
          parentFeatureId: instance.installedFeatureId!,
          iterationNumber: instance.refinementCount + 1,
        }
      : editing
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
    const result = await callbacks.onInstall(feature);
    if (!instance || instance.requestToken !== token) return;
    markInstalledTransient();

    const installedId = result && 'id' in result ? result.id : null;
    const installedCode = instance.currentResponse!.code;

    // Add assistant turn to refinement history
    instance.refinementHistory.push({
      role: 'assistant',
      content: instance.currentResponse!.description,
    });
    instance.refinementCount++;

    if (instance.installedTimer) clearTimeout(instance.installedTimer);
    instance.installedTimer = setTimeout(() => {
      if (!instance || instance.requestToken !== token) return;
      instance.preview.installBtn.classList.remove('installed');

      if (installedId) {
        // Transition to refine state
        const wasRefinement = isRefinement;
        setRefineMode(installedId, editedName, installedCode);
        instance.input.value = '';
        autoGrow();
        instance.input.placeholder = 'Refine this feature\u2026 (Cmd+Enter to submit)';
        setState('refine');
        requestAnimationFrame(() => instance?.input.focus());
        if (wasRefinement) {
          showToast(`Refined: ${editedName}`);
        }
      } else {
        // No id returned — close with toast (legacy behavior)
        const verb = editing ? 'Updated' : 'Installed';
        closeOverlay();
        showToast(`${verb}: ${editedName}`);
      }
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

  if (instance.installedFeatureId) {
    // Go back to refine state
    setState('refine');
    instance.input.value = '';
    autoGrow();
  } else {
    setState('open');
    instance.input.value = instance.originalPrompt;
    autoGrow();
  }

  requestAnimationFrame(() => {
    instance?.input.focus();
  });
}

// ---- Voice input ----

function toggleVoice(): void {
  if (!instance) return;

  if (instance.stopVoice) {
    instance.stopVoice();
    instance.stopVoice = null;
    instance.micBtn.classList.remove('recording');
    return;
  }

  instance.stopVoice = startVoiceInput({
    onResult: (text) => {
      if (!instance) return;
      const current = instance.input.value;
      instance.input.value = current
        ? current + ' ' + text
        : text;
      autoGrow();
      updateChips();
    },
    onError: (err) => {
      if (err === 'not-allowed') {
        showToast('Microphone permission denied');
      } else if (err !== 'aborted' && err !== 'no-speech') {
        showToast('Voice input failed: ' + err);
      }
    },
    onStart: () => {
      instance?.micBtn.classList.add('recording');
    },
    onEnd: () => {
      if (!instance) return;
      instance.micBtn.classList.remove('recording');
      instance.stopVoice = null;
    },
  });
}

// ---- Build DOM ----

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
  bannerClose.textContent = '\u00d7';
  bannerClose.addEventListener('click', () => closeOverlay());
  banner.appendChild(bannerLabel);
  banner.appendChild(bannerText);
  banner.appendChild(bannerClose);

  // Refine-mode banner
  const refineBanner = document.createElement('div');
  refineBanner.className = 'refine-banner';
  refineBanner.setAttribute('hidden', '');
  const refineBannerLabel = document.createElement('span');
  refineBannerLabel.className = 'refine-banner-label';
  refineBannerLabel.textContent = 'Installed \u2713';
  const refineBannerName = document.createElement('span');
  refineBannerName.className = 'refine-banner-name';
  const refineBannerClose = document.createElement('button');
  refineBannerClose.type = 'button';
  refineBannerClose.className = 'refine-banner-close';
  refineBannerClose.setAttribute('aria-label', 'Close');
  refineBannerClose.textContent = '\u00d7';
  refineBannerClose.addEventListener('click', () => closeOverlay());
  refineBanner.appendChild(refineBannerLabel);
  refineBanner.appendChild(refineBannerName);
  refineBanner.appendChild(refineBannerClose);

  // Effort toggle header
  const promptHeader = document.createElement('div');
  promptHeader.className = 'prompt-header';

  const effortLabel = document.createElement('label');
  effortLabel.className = 'effort-toggle';
  effortLabel.title = 'Slower, more thorough \u2014 uses extended reasoning. Good for complex tasks.';

  const effortCheckbox = document.createElement('input');
  effortCheckbox.type = 'checkbox';
  effortCheckbox.className = 'effort-checkbox';
  effortCheckbox.checked = getEffortMode() === 'high';
  effortCheckbox.addEventListener('change', () => {
    setEffortMode(effortCheckbox.checked ? 'high' : 'standard');
  });

  const effortSlider = document.createElement('span');
  effortSlider.className = 'effort-slider';

  const effortLabelText = document.createElement('span');
  effortLabelText.className = 'effort-label';
  effortLabelText.textContent = 'High effort';

  effortLabel.appendChild(effortCheckbox);
  effortLabel.appendChild(effortSlider);
  effortLabel.appendChild(effortLabelText);
  promptHeader.appendChild(effortLabel);

  // Input row
  const row = document.createElement('div');
  row.className = 'row';

  const input = document.createElement('textarea');
  input.className = 'prompt';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.rows = 1;
  input.placeholder = 'Describe what you want\u2026 (Cmd+Enter to submit)';
  input.setAttribute('aria-label', 'Prompt');

  // Mic button (hidden if not supported)
  const micBtn = document.createElement('button');
  micBtn.type = 'button';
  micBtn.className = 'mic-btn';
  micBtn.setAttribute('aria-label', 'Voice input');
  micBtn.title = 'Voice input';
  const micSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  micSvg.setAttribute('width', '16');
  micSvg.setAttribute('height', '16');
  micSvg.setAttribute('viewBox', '0 0 24 24');
  micSvg.setAttribute('fill', 'none');
  micSvg.setAttribute('stroke', 'currentColor');
  micSvg.setAttribute('stroke-width', '2');
  micSvg.setAttribute('stroke-linecap', 'round');
  micSvg.setAttribute('stroke-linejoin', 'round');
  const micPath1 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  micPath1.setAttribute('x', '9');
  micPath1.setAttribute('y', '2');
  micPath1.setAttribute('width', '6');
  micPath1.setAttribute('height', '12');
  micPath1.setAttribute('rx', '3');
  const micPath2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  micPath2.setAttribute('d', 'M5 10a7 7 0 0 0 14 0');
  const micPath3 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  micPath3.setAttribute('x1', '12');
  micPath3.setAttribute('y1', '17');
  micPath3.setAttribute('x2', '12');
  micPath3.setAttribute('y2', '22');
  micSvg.appendChild(micPath1);
  micSvg.appendChild(micPath2);
  micSvg.appendChild(micPath3);
  micBtn.appendChild(micSvg);
  if (!isVoiceSupported()) {
    micBtn.style.display = 'none';
  }
  micBtn.addEventListener('click', toggleVoice);

  const promptAction = document.createElement('button');
  promptAction.type = 'button';
  promptAction.className = 'prompt-action btn btn-primary';
  const promptActionLabel = document.createElement('span');
  promptActionLabel.textContent = 'Build it';
  promptAction.appendChild(promptActionLabel);
  promptAction.setAttribute('aria-label', 'Build it');
  promptAction.addEventListener('click', () => {
    if (!instance) return;
    if (instance.state === 'loading') stopGeneration();
    else if (instance.state === 'open' || instance.state === 'refine') void submitPrompt();
  });

  row.appendChild(input);
  row.appendChild(micBtn);
  row.appendChild(promptAction);

  // Suggestion chips
  const chipsContainer = document.createElement('div');
  chipsContainer.className = 'chips';
  chipsContainer.setAttribute('hidden', '');

  // Progress log (shown during loading)
  const progressLog = document.createElement('div');
  progressLog.className = 'progress-log';

  // Thinking disclosure (shown during loading in high-effort mode)
  const thinkingDisclosure = document.createElement('details');
  thinkingDisclosure.className = 'thinking-disclosure';
  thinkingDisclosure.setAttribute('hidden', '');
  const thinkingSummary = document.createElement('summary');
  thinkingSummary.className = 'thinking-summary';
  thinkingSummary.textContent = 'Model thinking';
  const thinkingContent = document.createElement('div');
  thinkingContent.className = 'thinking-content';
  thinkingDisclosure.appendChild(thinkingSummary);
  thinkingDisclosure.appendChild(thinkingContent);

  const status = document.createElement('div');
  status.className = 'status';
  status.setAttribute('role', 'alert');
  status.setAttribute('aria-live', 'polite');

  const hint = document.createElement('div');
  hint.className = 'hint';

  // Left side: keyboard-shortcuts disclosure ("?" button + popover).
  const helpWrap = document.createElement('span');
  helpWrap.className = 'kbd-help';
  const helpBtn = document.createElement('button');
  helpBtn.type = 'button';
  helpBtn.className = 'kbd-help-btn';
  helpBtn.textContent = '?';
  helpBtn.setAttribute('aria-label', 'Keyboard shortcuts');
  helpBtn.setAttribute('aria-expanded', 'false');
  const helpPopover = document.createElement('div');
  helpPopover.className = 'kbd-help-popover';
  helpPopover.setAttribute('role', 'tooltip');
  // Populated by refreshKbdHelp() after the instance is created so the
  // shortcut list always reflects the user's configured keybinds.
  const dl = document.createElement('dl');
  helpPopover.appendChild(dl);
  helpWrap.appendChild(helpBtn);
  helpWrap.appendChild(helpPopover);

  const setHelpOpen = (open: boolean): void => {
    if (open) {
      helpPopover.dataset.open = 'true';
      helpBtn.setAttribute('aria-expanded', 'true');
    } else {
      delete helpPopover.dataset.open;
      helpBtn.setAttribute('aria-expanded', 'false');
    }
  };
  helpBtn.addEventListener('mouseenter', () => setHelpOpen(true));
  helpWrap.addEventListener('mouseleave', () => setHelpOpen(false));
  helpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setHelpOpen(helpPopover.dataset.open !== 'true');
  });

  const right = document.createElement('span');
  const cmdKbd = document.createElement('kbd');
  cmdKbd.textContent = '\u2318Enter';
  const escKbd = document.createElement('kbd');
  escKbd.textContent = 'Esc';
  right.appendChild(cmdKbd);
  right.appendChild(document.createTextNode(' to submit \u00b7 '));
  right.appendChild(escKbd);
  right.appendChild(document.createTextNode(' to close'));
  hint.appendChild(helpWrap);
  hint.appendChild(right);

  promptView.appendChild(banner);
  promptView.appendChild(refineBanner);
  promptView.appendChild(promptHeader);
  promptView.appendChild(row);
  promptView.appendChild(chipsContainer);
  promptView.appendChild(progressLog);
  promptView.appendChild(thinkingDisclosure);
  promptView.appendChild(status);
  promptView.appendChild(hint);

  // --- Preview view ---
  const preview = buildPreviewView();

  modal.appendChild(promptView);
  modal.appendChild(preview.root);
  backdrop.appendChild(modal);
  root.appendChild(backdrop);

  // Backdrop click closes
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target !== backdrop) return;
    closeOverlay();
  });

  // Capture-phase keydown
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
        e.preventDefault();
        e.stopPropagation();
        if (instance.state === 'preview') {
          void install();
        } else if (instance.state === 'open' || instance.state === 'refine') {
          void submitPrompt();
        }
        return;
      }
      // Plain Enter in textarea — let it insert newline (don't prevent)
    },
    true,
  );

  // Bubble-phase swallow
  const swallow = (e: Event): void => {
    e.stopPropagation();
  };
  backdrop.addEventListener('keydown', swallow);
  backdrop.addEventListener('keyup', swallow);
  backdrop.addEventListener('keypress', swallow);

  // Input events
  input.addEventListener('input', () => {
    if (!instance) return;
    autoGrow();
    if (instance.state === 'open' || instance.state === 'refine' || instance.state === 'loading') {
      clearPromptError();
    }
    updateChips();
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
    chipsContainer,
    micBtn,
    effortCheckbox,
    refineBanner,
    refineBannerLabel,
    refineBannerName,
    helpBtn,
    helpPopover,
    promptAction,
    promptActionLabel,
    progressLog,
    thinkingDisclosure,
    thinkingContent,
    status,
    preview,
    state: 'closed',
    requestToken: 0,
    originalPrompt: '',
    currentResponse: null,
    editing: null,
    installedTimer: null,
    refinementCount: 0,
    refinementHistory: [],
    installedFeatureId: null,
    installedFeatureName: '',
    installedCode: '',
    entryMode: 'refine',
    recentPrompts: [],
    stopVoice: null,
  };
}

// ---- Keydown listener ----

function ensureKeydownListener(): void {
  if (keydownAttached) return;
  keydownAttached = true;
  window.addEventListener(
    'keydown',
    (e) => {
      const hk = eventToHotkey(e);
      if (!hk) return;
      if (hk !== cachedKeybinds.overlay) return;
      if (!instance) return;
      e.preventDefault();
      e.stopPropagation();
      if (instance.state === 'closed') openOverlay();
      else if (instance.state === 'open' || instance.state === 'refine') closeOverlay();
    },
    true,
  );
}

// ---- Public API ----

export function initOverlay(cb: OverlayCallbacks): void {
  callbacks = cb;
  if (!instance) {
    instance = buildOverlay();
    document.body.appendChild(instance.host);
  }
  // Render the keyboard-help popover with whatever keybinds are
  // currently cached (defaults until the host pushes saved settings).
  refreshKbdHelp();
  ensureKeydownListener();
}

export function openOverlay(): void {
  if (!instance) return;
  if (instance.state !== 'closed') return;
  instance.input.placeholder = 'Describe what you want\u2026 (Cmd+Enter to submit)';
  setState('open');
  void refreshRecentPrompts();
  requestAnimationFrame(() => {
    instance?.input.focus();
  });
}

export function openOverlayWithPrompt(prompt: string): void {
  if (!instance) return;
  instance.requestToken++;
  if (instance.installedTimer) {
    clearTimeout(instance.installedTimer);
    instance.installedTimer = null;
  }
  instance.currentResponse = null;
  clearPromptError();
  clearPreviewError();
  clearRefineMode();
  instance.preview.installBtn.classList.remove('installed');
  setEditing(null);
  instance.input.value = prompt ?? '';
  instance.input.placeholder = 'Describe what you want\u2026 (Cmd+Enter to submit)';
  instance.originalPrompt = instance.input.value;
  setState('open');
  void refreshRecentPrompts();
  autoGrow();
  requestAnimationFrame(() => {
    instance?.input.focus();
  });
}

// Edit and refine are unified: clicking "Edit" from the popup drops the
// user straight into refine mode, with the feature's prior prompt /
// description seeded as the first round-trip in the refinement history.
// The banner reads "Editing: <name>" (instead of "Installed \u2713") to
// reflect entry context \u2014 functionally identical state.
export function openOverlayForEdit(feature: Feature): void {
  if (!instance) return;
  instance.requestToken++;
  if (instance.installedTimer) {
    clearTimeout(instance.installedTimer);
    instance.installedTimer = null;
  }
  instance.currentResponse = null;
  clearPromptError();
  clearPreviewError();
  clearProgress();
  clearRefineMode();
  instance.preview.installBtn.classList.remove('installed');
  setEditing(null);

  // Seed refine state as if the user had just installed this feature.
  // refinementCount=1 reflects the implicit "create + describe" turn so
  // the "Done" chip behavior (>=3 refinements) stays consistent.
  setRefineMode(feature.id, feature.name, feature.code, 'edit');
  instance.refinementHistory = [
    { role: 'user', content: feature.userPrompt ?? '' },
    { role: 'assistant', content: feature.description ?? '' },
  ];
  instance.refinementCount = 1;
  instance.originalPrompt = '';
  instance.input.value = '';
  instance.input.placeholder =
    'Refine this feature\u2026 or describe a totally different change';
  setState('refine');
  autoGrow();
  requestAnimationFrame(() => {
    instance?.input.focus();
  });
}

export function closeOverlay(): void {
  if (!instance) return;
  instance.requestToken++;
  if (instance.installedTimer) {
    clearTimeout(instance.installedTimer);
    instance.installedTimer = null;
  }
  if (instance.stopVoice) {
    instance.stopVoice();
    instance.stopVoice = null;
    instance.micBtn.classList.remove('recording');
  }
  clearPromptError();
  clearPreviewError();
  clearProgress();
  clearRefineMode();
  setState('closed');
  setEditing(null);
  instance.input.value = '';
  instance.input.style.height = '';
  instance.originalPrompt = '';
  instance.currentResponse = null;
  instance.preview.installBtn.classList.remove('installed');
  instance.preview.installLabel.textContent = 'Install';
}
