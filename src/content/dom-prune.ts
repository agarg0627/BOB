// Owned by Person C (extension): produces a compact text rendering of
// document.body suitable for use as LLM context. Synchronous, no-throw,
// bounded by maxChars (default 4000) and a soft 50ms wall budget.

export interface PruneOptions {
  maxDepth?: number;
  maxChars?: number;
  maxChildren?: number;
}

const PRIORITY_ATTRS = [
  'id',
  'role',
  'aria-label',
  'data-testid',
  'name',
  'type',
  'href',
  'placeholder',
  'alt',
  'title',
] as const;

const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'link',
  'meta',
  'template',
]);

const TEXT_INLINE_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'label',
  'button',
  'a',
]);

const URL_ATTRS = new Set(['href', 'src']);

const MAX_PRIORITY_ATTRS = 4;
const MAX_CLASS_FALLBACK = 2;
const MAX_INLINE_TEXT = 80;
const MAX_URL = 60;
const MAX_ATTR_VALUE = 80;

const TRUNC_MARK = '... (truncated)';
const TIME_BUDGET_MS = 50;
const TIME_SAFETY_MS = 5;
const SIBLING_COLLAPSE_THRESHOLD = 5;

interface State {
  lines: string[];
  chars: number;
  aborted: boolean;
  start: number;
  maxChars: number;
  maxDepth: number;
  maxChildren: number;
}

function isAutoGenClass(c: string): boolean {
  if (!c) return true;
  if (c.startsWith('css-')) return true;
  if (c.startsWith('jsx-')) return true;
  if (c.startsWith('_')) return true;
  if (/^[a-f0-9]{6,}$/i.test(c)) return true;
  if (/^[A-Za-z0-9]{12,}$/.test(c)) return true;
  return false;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

function escapeAttrValue(v: string): string {
  return v.replace(/"/g, "'").replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function safeGetAttr(el: Element, name: string): string | null {
  try {
    const v = el.getAttribute(name);
    return v == null ? null : v;
  } catch {
    return null;
  }
}

function safeTagName(el: Element): string {
  try {
    return (el.tagName || '').toLowerCase();
  } catch {
    return '';
  }
}

function safeTextContent(el: Element): string {
  try {
    return el.textContent || '';
  } catch {
    return '';
  }
}

function safeChildren(el: Element): Element[] {
  try {
    const out: Element[] = [];
    const kids = el.children;
    if (!kids) return out;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      const tag = safeTagName(c);
      // Filter explicit skip-list. Unreadable children (empty tag) pass
      // through so emitOne can render them as <unreadable/>.
      if (tag && SKIP_TAGS.has(tag)) continue;
      out.push(c);
    }
    return out;
  } catch {
    return [];
  }
}

function buildAttrs(el: Element): { str: string; keys: string[] } {
  const parts: string[] = [];
  const keys: string[] = [];
  for (const name of PRIORITY_ATTRS) {
    if (parts.length >= MAX_PRIORITY_ATTRS) break;
    const raw = safeGetAttr(el, name);
    if (raw == null) continue;
    let value = raw;
    if (URL_ATTRS.has(name)) value = truncate(value, MAX_URL);
    value = truncate(value, MAX_ATTR_VALUE);
    parts.push(`${name}="${escapeAttrValue(value)}"`);
    keys.push(name);
  }
  if (parts.length === 0) {
    const cls = safeGetAttr(el, 'class') ?? '';
    if (cls) {
      const tokens = cls
        .split(/\s+/)
        .filter((t) => t && !isAutoGenClass(t))
        .slice(0, MAX_CLASS_FALLBACK);
      if (tokens.length > 0) {
        parts.push(`class="${escapeAttrValue(tokens.join(' '))}"`);
        keys.push('class');
      }
    }
  }
  return { str: parts.join(' '), keys };
}

function indentStr(depth: number): string {
  return '  '.repeat(depth);
}

function checkLimits(state: State): boolean {
  if (state.aborted) return false;
  if (performance.now() - state.start > TIME_BUDGET_MS - TIME_SAFETY_MS) {
    state.aborted = true;
    return false;
  }
  return true;
}

function tryPush(state: State, line: string): boolean {
  if (!checkLimits(state)) return false;
  // +1 for the newline that join('\n') will insert between this line and the next.
  const len = line.length + 1;
  // Reserve room for the truncation marker plus its leading newline.
  const reserve = TRUNC_MARK.length + 1;
  if (state.chars + len > state.maxChars - reserve) {
    state.aborted = true;
    return false;
  }
  state.lines.push(line);
  state.chars += len;
  return true;
}

function siblingSignature(el: Element): string {
  const tag = safeTagName(el) || '<unreadable>';
  let keys: string[] = [];
  try {
    keys = buildAttrs(el).keys;
  } catch {
    keys = [];
  }
  return tag + '|' + keys.slice().sort().join(',');
}

function summaryRepr(el: Element): string {
  const tag = safeTagName(el) || 'unreadable';
  let attrStr = '';
  try {
    attrStr = buildAttrs(el).str;
  } catch {
    attrStr = '';
  }
  return attrStr ? `<${tag} ${attrStr}>` : `<${tag}>`;
}

function emitOne(el: Element, depth: number, state: State): void {
  if (state.aborted) return;
  if (depth > state.maxDepth) return;

  const tag = safeTagName(el);
  if (!tag) {
    tryPush(state, indentStr(depth) + '<unreadable/>');
    return;
  }
  if (SKIP_TAGS.has(tag)) return;

  // Self-closing summaries.
  if (tag === 'svg') {
    tryPush(state, indentStr(depth) + '<svg/>');
    return;
  }
  if (tag === 'iframe') {
    const src = safeGetAttr(el, 'src');
    const line = src
      ? `<iframe src="${escapeAttrValue(truncate(src, MAX_URL))}"/>`
      : '<iframe/>';
    tryPush(state, indentStr(depth) + line);
    return;
  }

  let attrs = '';
  try {
    attrs = buildAttrs(el).str;
  } catch {
    tryPush(state, indentStr(depth) + '<unreadable/>');
    return;
  }
  const open = attrs ? `<${tag} ${attrs}>` : `<${tag}>`;
  const selfClose = attrs ? `<${tag} ${attrs}/>` : `<${tag}/>`;
  const close = `</${tag}>`;

  const children = safeChildren(el);
  const hasChildren = children.length > 0;

  // Headings, labels, buttons, links: collapse to a single line with text.
  if (TEXT_INLINE_TAGS.has(tag)) {
    const raw = safeTextContent(el);
    const txt = truncate(raw.replace(/\s+/g, ' ').trim(), MAX_INLINE_TEXT);
    if (txt) {
      tryPush(state, indentStr(depth) + `${open}${txt}${close}`);
      return;
    }
    if (!hasChildren) {
      tryPush(state, indentStr(depth) + selfClose);
      return;
    }
    if (!tryPush(state, indentStr(depth) + open)) return;
    walkChildren(children, depth + 1, state);
    if (state.aborted) return;
    tryPush(state, indentStr(depth) + close);
    return;
  }

  // Leaf element: optionally show [text N chars].
  if (!hasChildren) {
    const txt = safeTextContent(el).trim();
    if (txt.length > 0) {
      tryPush(
        state,
        indentStr(depth) + `${open}[text ${txt.length} chars]${close}`,
      );
    } else {
      tryPush(state, indentStr(depth) + selfClose);
    }
    return;
  }

  // Standard non-leaf: open / recurse / close.
  if (!tryPush(state, indentStr(depth) + open)) return;
  if (depth + 1 <= state.maxDepth) {
    walkChildren(children, depth + 1, state);
  } else if (children.length > 0) {
    tryPush(
      state,
      indentStr(depth + 1) + `... ${children.length} more children`,
    );
  }
  if (state.aborted) return;
  tryPush(state, indentStr(depth) + close);
}

function walkChildren(children: Element[], depth: number, state: State): void {
  if (state.aborted) return;
  if (depth > state.maxDepth) {
    if (children.length > 0) {
      tryPush(state, indentStr(depth) + `... ${children.length} more children`);
    }
    return;
  }

  const slice = children.slice(0, state.maxChildren);
  const overflow = children.length - slice.length;

  let i = 0;
  while (i < slice.length && !state.aborted) {
    const sig = siblingSignature(slice[i]);
    let j = i + 1;
    while (j < slice.length && siblingSignature(slice[j]) === sig) j++;
    const runLen = j - i;

    if (runLen >= SIBLING_COLLAPSE_THRESHOLD) {
      try {
        emitOne(slice[i], depth, state);
      } catch {
        tryPush(state, indentStr(depth) + '<unreadable/>');
      }
      if (state.aborted) return;
      try {
        emitOne(slice[i + 1], depth, state);
      } catch {
        tryPush(state, indentStr(depth) + '<unreadable/>');
      }
      if (state.aborted) return;
      tryPush(
        state,
        indentStr(depth) + `... ${runLen - 2} more ${summaryRepr(slice[i])}`,
      );
      i = j;
    } else {
      try {
        emitOne(slice[i], depth, state);
      } catch {
        tryPush(state, indentStr(depth) + '<unreadable/>');
      }
      i++;
    }
  }

  if (overflow > 0 && !state.aborted) {
    tryPush(state, indentStr(depth) + `... ${overflow} more children`);
  }
}

export function prunePage(opts: PruneOptions = {}): string {
  const state: State = {
    lines: [],
    chars: 0,
    aborted: false,
    start: performance.now(),
    maxChars: Math.max(64, opts.maxChars ?? 4000),
    maxDepth: Math.max(1, opts.maxDepth ?? 8),
    maxChildren: Math.max(1, opts.maxChildren ?? 30),
  };

  try {
    const body = document.body;
    if (body) emitOne(body, 0, state);
  } catch {
    // Last-ditch: if even reading body throws, return whatever we have.
  }

  const body = state.lines.join('\n');
  return state.aborted ? body + '\n' + TRUNC_MARK : body;
}
