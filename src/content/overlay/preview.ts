import type { GenerateResponse } from '../../shared/types';

export interface PreviewElements {
  root: HTMLDivElement;
  nameInput: HTMLInputElement;
  descEl: HTMLParagraphElement;
  urlInput: HTMLInputElement;
  codeWrap: HTMLDivElement;
  codePre: HTMLPreElement;
  codeToggleBtn: HTMLButtonElement;
  status: HTMLDivElement;
  cancelBtn: HTMLButtonElement;
  installBtn: HTMLButtonElement;
  installLabel: HTMLSpanElement;
}

export function buildPreviewView(): PreviewElements {
  const root = document.createElement('div');
  root.className = 'view view-preview';

  const header = document.createElement('div');
  header.className = 'preview-header';

  const nameInput = document.createElement('input');
  nameInput.className = 'preview-name';
  nameInput.type = 'text';
  nameInput.spellcheck = false;
  nameInput.autocomplete = 'off';
  nameInput.setAttribute('aria-label', 'Feature name');

  const descEl = document.createElement('p');
  descEl.className = 'preview-desc';

  header.appendChild(nameInput);
  header.appendChild(descEl);

  const meta = document.createElement('div');
  meta.className = 'preview-meta';
  const urlLabel = document.createElement('label');
  urlLabel.className = 'preview-meta-label';
  urlLabel.textContent = 'URL pattern';
  const urlInput = document.createElement('input');
  urlInput.className = 'preview-url';
  urlInput.type = 'text';
  urlInput.spellcheck = false;
  urlInput.autocomplete = 'off';
  urlInput.setAttribute('aria-label', 'URL pattern');
  meta.appendChild(urlLabel);
  meta.appendChild(urlInput);

  const codeToggleBtn = document.createElement('button');
  codeToggleBtn.type = 'button';
  codeToggleBtn.className = 'preview-code-toggle';
  codeToggleBtn.setAttribute('aria-expanded', 'false');
  codeToggleBtn.textContent = 'Show code ▾';

  const codeWrap = document.createElement('div');
  codeWrap.className = 'preview-code-wrap collapsed';
  const codePre = document.createElement('pre');
  codePre.className = 'preview-code';
  codeWrap.appendChild(codePre);

  codeToggleBtn.addEventListener('click', () => {
    const collapsed = codeWrap.classList.toggle('collapsed');
    codeToggleBtn.textContent = collapsed ? 'Show code ▾' : 'Hide code ▴';
    codeToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });

  const status = document.createElement('div');
  status.className = 'preview-status';
  status.setAttribute('role', 'alert');
  status.setAttribute('aria-live', 'polite');

  const actions = document.createElement('div');
  actions.className = 'preview-actions';

  const previewHint = document.createElement('span');
  previewHint.className = 'preview-hint';
  const kbdMeta = document.createElement('kbd');
  kbdMeta.textContent = '⌘';
  const kbdEnter = document.createElement('kbd');
  kbdEnter.textContent = '↵';
  previewHint.appendChild(kbdMeta);
  previewHint.appendChild(kbdEnter);
  previewHint.appendChild(document.createTextNode(' to install'));

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';

  const installBtn = document.createElement('button');
  installBtn.type = 'button';
  installBtn.className = 'btn btn-primary';
  const installLabel = document.createElement('span');
  installLabel.textContent = 'Install';
  const installSpinner = document.createElement('div');
  installSpinner.className = 'spinner spinner-sm';
  installSpinner.setAttribute('aria-hidden', 'true');
  installBtn.appendChild(installLabel);
  installBtn.appendChild(installSpinner);

  actions.appendChild(previewHint);
  actions.appendChild(cancelBtn);
  actions.appendChild(installBtn);

  root.appendChild(header);
  root.appendChild(meta);
  root.appendChild(codeToggleBtn);
  root.appendChild(codeWrap);
  root.appendChild(status);
  root.appendChild(actions);

  return {
    root,
    nameInput,
    descEl,
    urlInput,
    codeWrap,
    codePre,
    codeToggleBtn,
    status,
    cancelBtn,
    installBtn,
    installLabel,
  };
}

export function populatePreview(els: PreviewElements, response: GenerateResponse): void {
  els.nameInput.value = response.name;
  els.descEl.textContent = response.description;
  els.urlInput.value = response.urlPattern;
  renderCode(els.codePre, response.code);
  els.status.textContent = '';
  els.status.classList.remove('visible');
  // Reset to collapsed each time a new response is shown.
  els.codeWrap.classList.add('collapsed');
  els.codeToggleBtn.textContent = 'Show code ▾';
  els.codeToggleBtn.setAttribute('aria-expanded', 'false');
}

function renderCode(pre: HTMLPreElement, code: string): void {
  while (pre.firstChild) pre.removeChild(pre.firstChild);
  const codeEl = document.createElement('code');
  for (const tok of tokenize(code)) {
    if (tok.type === 'plain') {
      codeEl.appendChild(document.createTextNode(tok.value));
    } else {
      const span = document.createElement('span');
      span.className = `tok-${tok.type}`;
      span.textContent = tok.value;
      codeEl.appendChild(span);
    }
  }
  pre.appendChild(codeEl);
}

type TokenType = 'plain' | 'comment' | 'string' | 'keyword' | 'number';
interface Token {
  type: TokenType;
  value: string;
}

const KEYWORDS = new Set([
  'function', 'var', 'let', 'const', 'if', 'else', 'return', 'for', 'while',
  'try', 'catch', 'finally', 'new', 'null', 'undefined', 'true', 'false',
  'this', 'class', 'extends', 'throw', 'typeof', 'instanceof', 'of', 'in',
  'do', 'switch', 'case', 'break', 'continue', 'delete', 'void', 'async',
  'await',
]);

const TOKEN_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|([A-Za-z_$][A-Za-z0-9_$]*)|(\d+(?:\.\d+)?)/g;

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    if (m.index > lastIndex) {
      out.push({ type: 'plain', value: src.slice(lastIndex, m.index) });
    }
    const [, comment, str, ident, num] = m;
    if (comment !== undefined) {
      out.push({ type: 'comment', value: comment });
    } else if (str !== undefined) {
      out.push({ type: 'string', value: str });
    } else if (ident !== undefined) {
      out.push({ type: KEYWORDS.has(ident) ? 'keyword' : 'plain', value: ident });
    } else if (num !== undefined) {
      out.push({ type: 'number', value: num });
    }
    lastIndex = TOKEN_RE.lastIndex;
  }
  if (lastIndex < src.length) {
    out.push({ type: 'plain', value: src.slice(lastIndex) });
  }
  return out;
}

const TOAST_HOST_TAG = 'bob-toast-host';
const TOAST_VISIBLE_MS = 2500;
const TOAST_FADE_MS = 250;

const toastCss = `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.toast-stack {
  position: fixed;
  bottom: 24px;
  right: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #1a1a1a;
  color: #f5f5f5;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.3;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 200ms ease-out, transform 200ms ease-out;
  pointer-events: auto;
  max-width: 360px;
}
.toast.visible {
  opacity: 1;
  transform: translateY(0);
}
.toast.leaving {
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 250ms ease-out, transform 250ms ease-out;
}
.toast-icon {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  background: #34c759;
  color: #0d0d0d;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  flex: 0 0 auto;
}
`;

let toastStack: HTMLDivElement | null = null;

function ensureToastHost(): void {
  if (toastStack) return;
  const host = document.createElement(TOAST_HOST_TAG);
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = toastCss;
  root.appendChild(style);
  const stack = document.createElement('div');
  stack.className = 'toast-stack';
  root.appendChild(stack);
  document.body.appendChild(host);
  toastStack = stack;
}

export function showToast(message: string): void {
  ensureToastHost();
  if (!toastStack) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = '✓';
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  toast.appendChild(icon);
  toast.appendChild(text);
  toastStack.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('visible'));

  window.setTimeout(() => {
    toast.classList.remove('visible');
    toast.classList.add('leaving');
    window.setTimeout(() => toast.remove(), TOAST_FADE_MS + 30);
  }, TOAST_VISIBLE_MS);
}
