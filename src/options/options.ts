import type { ExtensionSettings, LLMProvider } from '../shared/types';
import { getSettings, setSettings } from '../background/settings';
import { anthropicProvider } from '../background/providers/anthropic';
import { openaiProvider } from '../background/providers/openai';
import { googleProvider } from '../background/providers/google';
import { exportFeatures, importFeatures } from '../popup/import-export';

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

const MODEL_PLACEHOLDERS: Record<LLMProvider, string> = {
  anthropic: PROVIDER_DEFAULTS.anthropic,
  openai: PROVIDER_DEFAULTS.openai,
  google: 'gemini-3.1-pro-preview · gemma-4-31b-it · gemma-4-26b-a4b-it',
};

const modelHintEl = document.getElementById('model-hint') as HTMLParagraphElement | null;

function updateModelPlaceholder(): void {
  const provider = selectedProvider();
  modelInput.placeholder = MODEL_PLACEHOLDERS[provider];
  if (modelHintEl) {
    if (provider === 'google') {
      modelHintEl.textContent =
        'Gemma 4 models run via Gemini API and use the same key. gemma-4-31b-it is recommended for quality.';
      modelHintEl.hidden = false;
    } else {
      modelHintEl.hidden = true;
    }
  }
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
    apiKeys[p] = keyInputs[p].value.trim();
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

// ---- Demo seed ----

const DEMO_FEATURES = [
  {
    name: 'Hide YouTube Shorts',
    description: 'Hides Shorts shelves from the YouTube homepage.',
    urlPattern: '*://*.youtube.com/*',
    userPrompt: 'Hide YouTube Shorts',
    code: `(function(){try{
  var slug='hide-yt-shorts';
  if(window.__bobObserve){
    window.__bobObserve(slug,function(){
      document.querySelectorAll('ytd-rich-shelf-renderer, ytd-reel-shelf-renderer').forEach(function(el){
        if(el.getAttribute('data-bob')===slug)return;
        el.setAttribute('data-bob',slug);
        el.style.display='none';
      });
    });
  }else{
    document.querySelectorAll('ytd-rich-shelf-renderer, ytd-reel-shelf-renderer').forEach(function(el){
      el.setAttribute('data-bob',slug);
      el.style.display='none';
    });
  }
}catch(e){console.error('[bob]',e);window.__bobLastError=String(e);}})();`,
  },
  {
    name: 'HN Star Titles',
    description: 'Prepends a star emoji to every Hacker News story title.',
    urlPattern: '*://news.ycombinator.com/*',
    userPrompt: 'Add stars to HN titles',
    code: `(function(){try{
  var slug='hn-star-titles';
  function apply(){
    document.querySelectorAll('.titleline > a:first-child').forEach(function(a){
      if(a.getAttribute('data-bob')===slug)return;
      a.setAttribute('data-bob',slug);
      a.textContent='\\u2b50 '+a.textContent;
    });
  }
  if(window.__bobObserve){window.__bobObserve(slug,apply);}
  else{apply();}
}catch(e){console.error('[bob]',e);window.__bobLastError=String(e);}})();`,
  },
  {
    name: 'Wikipedia Dim Sidebar',
    description: 'Dims the Wikipedia sidebar to reduce visual clutter.',
    urlPattern: '*://*.wikipedia.org/*',
    userPrompt: 'Dim Wikipedia sidebar',
    code: `(function(){try{
  var slug='wp-dim-sidebar';
  var el=document.getElementById('mw-panel')||document.getElementById('mw-navigation');
  if(el&&!el.getAttribute('data-bob')){
    el.setAttribute('data-bob',slug);
    el.style.opacity='0.5';
  }
}catch(e){console.error('[bob]',e);window.__bobLastError=String(e);}})();`,
  },
  {
    name: 'Reddit Hide Ads',
    description: 'Hides promoted posts on Reddit.',
    urlPattern: '*://*.reddit.com/*',
    userPrompt: 'Hide Reddit ads',
    code: `(function(){try{
  var slug='reddit-hide-ads';
  function apply(){
    document.querySelectorAll('[data-promoted="true"], shreddit-ad-post').forEach(function(el){
      if(el.getAttribute('data-bob')===slug)return;
      el.setAttribute('data-bob',slug);
      el.style.display='none';
    });
  }
  if(window.__bobObserve){window.__bobObserve(slug,apply);}
  else{apply();}
}catch(e){console.error('[bob]',e);window.__bobLastError=String(e);}})();`,
  },
  {
    name: 'Example.com Tint',
    description: 'Applies a soft blue tint to example.com.',
    urlPattern: '*://example.com/*',
    userPrompt: 'Tint example.com blue',
    code: `(function(){try{
  var slug='example-tint';
  if(document.body.getAttribute('data-bob')===slug)return;
  document.body.setAttribute('data-bob',slug);
  document.body.style.backgroundColor='#e8f0fe';
}catch(e){console.error('[bob]',e);window.__bobLastError=String(e);}})();`,
  },
];

const loadDemosBtn = document.getElementById('load-demos') as HTMLButtonElement | null;
const demoStatusEl = document.getElementById('demo-status') as HTMLSpanElement | null;

async function loadDemos(): Promise<void> {
  if (!loadDemosBtn) return;
  loadDemosBtn.disabled = true;
  let count = 0;
  for (const demo of DEMO_FEATURES) {
    try {
      await chrome.runtime.sendMessage({
        type: 'INSTALL_FEATURE',
        feature: {
          ...demo,
          enabled: true,
          runCount: 0,
          errorCount: 0,
        },
      });
      count++;
    } catch {
      // skip individual failures
    }
  }
  if (demoStatusEl) {
    demoStatusEl.textContent = `Loaded ${count} demo features.`;
    demoStatusEl.classList.add('status-ok');
  }
}

loadDemosBtn?.addEventListener('click', () => void loadDemos());

// ---- Backup & Restore ----

const exportBtn = document.getElementById('export-btn') as HTMLButtonElement | null;
const importBtn = document.getElementById('import-btn') as HTMLButtonElement | null;
const importFileInput = document.getElementById('import-file') as HTMLInputElement | null;
const importModeEl = document.getElementById('import-mode') as HTMLDivElement | null;
const importMergeBtn = document.getElementById('import-merge') as HTMLButtonElement | null;
const importReplaceBtn = document.getElementById('import-replace') as HTMLButtonElement | null;
const backupStatusEl = document.getElementById('backup-status') as HTMLSpanElement | null;

let pendingFile: File | null = null;

function showBackupStatus(message: string, kind: 'ok' | 'error'): void {
  if (!backupStatusEl) return;
  backupStatusEl.textContent = message;
  backupStatusEl.classList.remove('status-ok', 'status-error');
  backupStatusEl.classList.add(kind === 'ok' ? 'status-ok' : 'status-error');
}

exportBtn?.addEventListener('click', async () => {
  try {
    await exportFeatures();
    showBackupStatus('Exported.', 'ok');
  } catch (e) {
    showBackupStatus((e as Error).message || 'Export failed.', 'error');
  }
});

importBtn?.addEventListener('click', () => {
  importFileInput?.click();
});

importFileInput?.addEventListener('change', () => {
  const file = importFileInput.files?.[0];
  if (!file) return;
  pendingFile = file;
  importModeEl?.removeAttribute('hidden');
});

async function doImport(mode: 'merge' | 'replace'): Promise<void> {
  if (!pendingFile) return;
  try {
    const result = await importFeatures(pendingFile, mode);
    pendingFile = null;
    importModeEl?.setAttribute('hidden', '');
    showBackupStatus(`Imported ${result.count} feature${result.count === 1 ? '' : 's'}.`, 'ok');
  } catch (e) {
    showBackupStatus((e as Error).message || 'Import failed.', 'error');
  }
}

importMergeBtn?.addEventListener('click', () => void doImport('merge'));
importReplaceBtn?.addEventListener('click', () => void doImport('replace'));

void init();
