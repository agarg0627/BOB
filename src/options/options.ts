import type { ExtensionSettings, LLMProvider } from '../shared/types';
import { getSettings, setSettings } from '../background/settings';
import { anthropicProvider } from '../background/providers/anthropic';
import { openaiProvider } from '../background/providers/openai';
import { googleProvider } from '../background/providers/google';

const PROVIDER_DEFAULTS: Record<LLMProvider, string> = {
  anthropic: anthropicProvider.defaultModel,
  openai: openaiProvider.defaultModel,
  google: googleProvider.defaultModel,
};

const KEY_VALIDATORS: Record<LLMProvider, (key: string) => string | null> = {
  anthropic: (k) => (k.startsWith('sk-ant-') ? null : 'Anthropic keys usually start with "sk-ant-".'),
  openai: (k) => (k.startsWith('sk-') ? null : 'OpenAI keys usually start with "sk-".'),
  google: (k) =>
    /^[A-Za-z0-9_-]{30,}$/.test(k) ? null : 'Google keys are typically ~39 alphanumeric chars.',
};

const form = document.getElementById('settings-form') as HTMLFormElement;
const modelInput = document.getElementById('model') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;

const keyInputs: Record<LLMProvider, HTMLInputElement> = {
  anthropic: document.getElementById('key-anthropic') as HTMLInputElement,
  openai: document.getElementById('key-openai') as HTMLInputElement,
  google: document.getElementById('key-google') as HTMLInputElement,
};

const warnEls: Record<LLMProvider, HTMLParagraphElement> = {
  anthropic: document.getElementById('warn-anthropic') as HTMLParagraphElement,
  openai: document.getElementById('warn-openai') as HTMLParagraphElement,
  google: document.getElementById('warn-google') as HTMLParagraphElement,
};

let statusTimer: number | undefined;

function selectedProvider(): LLMProvider {
  const checked = form.querySelector<HTMLInputElement>('input[name="provider"]:checked');
  return (checked?.value as LLMProvider) || 'anthropic';
}

function updateModelPlaceholder(): void {
  modelInput.placeholder = PROVIDER_DEFAULTS[selectedProvider()];
}

function validateKey(provider: LLMProvider): void {
  const value = keyInputs[provider].value.trim();
  const warn = warnEls[provider];
  if (!value) {
    warn.hidden = true;
    warn.textContent = '';
    return;
  }
  const message = KEY_VALIDATORS[provider](value);
  if (message) {
    warn.textContent = `Warning: ${message}`;
    warn.hidden = false;
  } else {
    warn.hidden = true;
    warn.textContent = '';
  }
}

function showStatus(message: string, kind: 'ok' | 'error'): void {
  statusEl.textContent = message;
  statusEl.classList.remove('status-ok', 'status-error');
  statusEl.classList.add(kind === 'ok' ? 'status-ok' : 'status-error');
  if (statusTimer !== undefined) window.clearTimeout(statusTimer);
  if (kind === 'ok') {
    statusTimer = window.setTimeout(() => {
      statusEl.textContent = '';
      statusEl.classList.remove('status-ok');
    }, 2500);
  }
}

function populate(settings: ExtensionSettings): void {
  const radio = form.querySelector<HTMLInputElement>(
    `input[name="provider"][value="${settings.provider}"]`,
  );
  if (radio) radio.checked = true;

  keyInputs.anthropic.value = settings.apiKeys.anthropic ?? '';
  keyInputs.openai.value = settings.apiKeys.openai ?? '';
  keyInputs.google.value = settings.apiKeys.google ?? '';

  modelInput.value = settings.model ?? '';
  updateModelPlaceholder();

  (Object.keys(keyInputs) as LLMProvider[]).forEach(validateKey);
}

function wireRevealButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('button.reveal').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.target;
      if (!id) return;
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (!input) return;
      const willShow = input.type === 'password';
      input.type = willShow ? 'text' : 'password';
      btn.textContent = willShow ? 'Hide' : 'Show';
    });
  });
}

function wireProviderRadios(): void {
  form.querySelectorAll<HTMLInputElement>('input[name="provider"]').forEach((radio) => {
    radio.addEventListener('change', updateModelPlaceholder);
  });
}

function wireKeyValidation(): void {
  (Object.keys(keyInputs) as LLMProvider[]).forEach((provider) => {
    keyInputs[provider].addEventListener('input', () => validateKey(provider));
  });
}

async function handleSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();

  const provider = selectedProvider();
  const apiKeys: Partial<Record<LLMProvider, string>> = {};
  (Object.keys(keyInputs) as LLMProvider[]).forEach((p) => {
    const value = keyInputs[p].value.trim();
    if (value) apiKeys[p] = value;
  });

  const modelValue = modelInput.value.trim();
  const patch: Partial<ExtensionSettings> = {
    provider,
    apiKeys,
    model: modelValue || undefined,
  };

  try {
    await setSettings(patch);
    showStatus('Saved.', 'ok');
  } catch (e) {
    showStatus(`Error: ${(e as Error).message}`, 'error');
  }
}

async function init(): Promise<void> {
  wireRevealButtons();
  wireProviderRadios();
  wireKeyValidation();
  form.addEventListener('submit', handleSubmit);

  try {
    const settings = await getSettings();
    populate(settings);
  } catch (e) {
    showStatus(`Error loading settings: ${(e as Error).message}`, 'error');
  }
}

void init();
