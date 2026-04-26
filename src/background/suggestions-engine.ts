// Analyzes accumulated behavior events and produces Suggestion rows.
//
// Storage layout in chrome.storage.local:
//   behavior:        UserBehaviorEvent[]   (capped at MAX_BEHAVIOR_EVENTS)
//   suggestions:     Suggestion[]
//   suggestionsMeta: {
//     lastAnalyzedAt:    { [hostname]: number },  // heuristic, 1 min
//     lastLlmAnalyzedAt: { [hostname]: number },  // LLM, 1 hour
//   }
//
// Two analyzers run side-by-side:
//
//   1. Heuristic A — "if the user has clicked close-like elements with
//      the same text/selector signature 3+ times on the same hostname,
//      propose an auto-dismiss feature." Fast, free, deterministic.
//      Always runs (subject to its own throttle).
//
//   2. LLM analyzer — sends a summary of recent events to the user's
//      configured provider and asks for 0-3 natural-language
//      suggestions. Slow + costs API tokens, so throttled to once per
//      hour per hostname. Failure of any kind (no API key, network
//      error, malformed response) silently falls back to whatever the
//      heuristic produced — the heuristic NEVER goes away.
//
// Suggestion rows from the two paths use disjoint id namespaces:
//   - heuristic: "auto-dismiss::<host>::<sigKey-hash>"
//   - LLM:       "sugg-<hash>"
// so neither analyzer can clobber the other's rows.
import type {
  ExtensionSettings,
  Suggestion,
  SuggestionDismissalState,
  UserBehaviorEvent,
} from '../shared/types';
import { withStorageLock } from '../shared/storage';
import { getSettings } from './settings';
import { anthropicProvider } from './providers/anthropic';
import { openaiProvider } from './providers/openai';
import { googleProvider } from './providers/google';
import type { Provider } from './providers/types';
import { SUGGESTIONS_SYSTEM_PROMPT } from './providers/prompt';

const PROVIDERS: Record<string, Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  google: googleProvider,
};

const LATER_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

const MAX_BEHAVIOR_EVENTS = 500;
const ANALYZE_THROTTLE_MS = 60_000;
// LLM throttles. The recordEvent path waits at least an hour before
// kicking off a new LLM call; the popup-open path uses a looser 30
// minutes (so users see fresh suggestions sooner after some browsing).
const LLM_THROTTLE_RECORD_MS = 60 * 60_000;
const LLM_THROTTLE_OPEN_MS = 30 * 60_000;
// LLM analysis looks at the trailing slice of behavior to keep prompt
// cost predictable. 50 events is enough to see the patterns.
const LLM_MAX_EVENTS = 50;
const LLM_LOOKBACK_MS = 3 * 24 * 60 * 60_000; // 3 days
const MIN_EVIDENCE = 3;
const PER_HOSTNAME_CAP = 5;

const KEY_BEHAVIOR = 'behavior';
const KEY_SUGGESTIONS = 'suggestions';
const KEY_META = 'suggestionsMeta';

interface SuggestionsMeta {
  lastAnalyzedAt: Record<string, number>;
  // Optional for back-compat with rows written before the LLM analyzer
  // landed. resolved as 0 (never analyzed) when missing.
  lastLlmAnalyzedAt?: Record<string, number>;
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

async function readBehavior(): Promise<UserBehaviorEvent[]> {
  const r = await chrome.storage.local.get(KEY_BEHAVIOR);
  const arr = (r as Record<string, unknown>)[KEY_BEHAVIOR];
  return Array.isArray(arr) ? (arr as UserBehaviorEvent[]) : [];
}

async function writeBehavior(list: UserBehaviorEvent[]): Promise<void> {
  await chrome.storage.local.set({ [KEY_BEHAVIOR]: list });
}

async function readSuggestions(): Promise<Suggestion[]> {
  const r = await chrome.storage.local.get(KEY_SUGGESTIONS);
  const arr = (r as Record<string, unknown>)[KEY_SUGGESTIONS];
  return Array.isArray(arr) ? (arr as Suggestion[]) : [];
}

async function writeSuggestions(list: Suggestion[]): Promise<void> {
  await chrome.storage.local.set({ [KEY_SUGGESTIONS]: list });
}

async function readMeta(): Promise<SuggestionsMeta> {
  const r = await chrome.storage.local.get(KEY_META);
  const meta = (r as Record<string, unknown>)[KEY_META];
  if (
    meta &&
    typeof meta === 'object' &&
    typeof (meta as SuggestionsMeta).lastAnalyzedAt === 'object'
  ) {
    const m = meta as SuggestionsMeta;
    if (!m.lastLlmAnalyzedAt) m.lastLlmAnalyzedAt = {};
    return m;
  }
  return { lastAnalyzedAt: {}, lastLlmAnalyzedAt: {} };
}

async function writeMeta(meta: SuggestionsMeta): Promise<void> {
  await chrome.storage.local.set({ [KEY_META]: meta });
}

// Group key for heuristic A: prefer the visible text the user clicked,
// fall back to the selector key. Lowercased + trimmed for stability.
function signatureKey(ev: UserBehaviorEvent): string {
  const t = (ev.text ?? '').toLowerCase().trim();
  if (t) return 't:' + t;
  const s = (ev.selector ?? '').toLowerCase().trim();
  if (s) return 's:' + s;
  return 'unknown';
}

function suggestionId(hostname: string, sigKey: string): string {
  return `auto-dismiss::${hostname}::${djb2(sigKey)}`;
}

// Decide whether a suggestion is currently visible. Handles both the
// new dismissalState field and the legacy `dismissed` boolean for rows
// written before three-state dismissal landed.
function isVisible(s: Suggestion, now: number): boolean {
  if (s.dismissalState === 'never') return false;
  if (s.dismissalState === 'later') {
    return (s.laterUntil ?? 0) <= now;
  }
  // No dismissalState (legacy / fresh row) — fall back to the boolean.
  if (s.dismissalState === undefined && s.dismissed) return false;
  return true;
}

export async function recordEvent(event: UserBehaviorEvent): Promise<void> {
  if (!event || typeof event !== 'object') return;

  // Append + trim to MAX_BEHAVIOR_EVENTS, oldest dropped first.
  await withStorageLock(KEY_BEHAVIOR, async () => {
    const list = await readBehavior();
    list.push(event);
    if (list.length > MAX_BEHAVIOR_EVENTS) {
      list.splice(0, list.length - MAX_BEHAVIOR_EVENTS);
    }
    await writeBehavior(list);
  });

  const host = event.hostname;
  if (!host) return;

  // Throttle heuristic analysis: at most one analyzeAndUpsert call per
  // minute per hostname. Wrap the read-check-write under the meta lock
  // so two concurrent recordEvent calls for the same host don't both
  // pass.
  const shouldAnalyze = await withStorageLock(KEY_META, async () => {
    const meta = await readMeta();
    const last = meta.lastAnalyzedAt[host] ?? 0;
    const now = Date.now();
    if (now - last < ANALYZE_THROTTLE_MS) return false;
    meta.lastAnalyzedAt[host] = now;
    await writeMeta(meta);
    return true;
  });
  if (shouldAnalyze) {
    await analyzeAndUpsert(host);
  }

  // Independent of the heuristic throttle, opportunistically kick off
  // an LLM analysis when its own (much looser) throttle allows. Fire
  // and forget — we don't await; the recordEvent call returns as soon
  // as the heuristic is done, and the LLM result lands in storage
  // whenever it lands.
  void maybeRunLlmAnalysis(host, LLM_THROTTLE_RECORD_MS);
}

export async function analyzeAndUpsert(hostname: string): Promise<void> {
  return withStorageLock(KEY_SUGGESTIONS, () => analyzeAndUpsertLocked(hostname));
}

async function analyzeAndUpsertLocked(hostname: string): Promise<void> {
  const events = await readBehavior();
  const closeEvents = events.filter(
    (e) =>
      e.hostname === hostname &&
      (e.type === 'click_close' || e.type === 'click_dismiss'),
  );
  if (closeEvents.length === 0) return;

  // Group by signature; keep the most-recent sample text and timestamp.
  type Group = { count: number; sampleText: string; latestTs: number };
  const groups = new Map<string, Group>();
  for (const ev of closeEvents) {
    const key = signatureKey(ev);
    const sample = (ev.text ?? '').trim() || (ev.selector ?? '');
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (sample && !existing.sampleText) existing.sampleText = sample;
      if (ev.timestamp > existing.latestTs) existing.latestTs = ev.timestamp;
    } else {
      groups.set(key, { count: 1, sampleText: sample, latestTs: ev.timestamp });
    }
  }

  const suggestions = await readSuggestions();
  const now = Date.now();

  for (const [key, g] of groups) {
    if (g.count < MIN_EVIDENCE) continue;
    const id = suggestionId(hostname, key);
    const sample = g.sampleText || 'this dialog';
    const proposedPrompt =
      `Automatically click any element with text "${sample}" or class matching the close button so I don't have to dismiss it manually`;
    const rationale = `You've dismissed "${sample}" ${g.count} times on this site`;
    const confidence = Math.min(0.4 + 0.1 * g.count, 0.9);

    const idx = suggestions.findIndex((s) => s.id === id);
    if (idx >= 0) {
      const existing = suggestions[idx];
      // Three-state dedup: respect the user's prior decisions.
      // - 'never' → never re-upsert
      // - 'later' still cooling down → don't surface again yet
      // - 'later' expired or 'none'/legacy → revive and refresh fields
      if (existing.dismissalState === 'never') continue;
      if (
        existing.dismissalState === 'later' &&
        (existing.laterUntil ?? 0) > now
      ) {
        continue;
      }
      const reviving =
        existing.dismissalState === 'later' &&
        (existing.laterUntil ?? 0) <= now;
      suggestions[idx] = {
        ...existing,
        proposedPrompt,
        rationale,
        confidence,
        evidenceCount: g.count,
        // Preserve original createdAt so per-hostname-cap "oldest first"
        // reflects when the suggestion first appeared, not the latest
        // upsert.
        createdAt: existing.createdAt,
        // On revival, clear the dismissal so the suggestion shows up
        // again. Legacy rows with only `dismissed: true` are also
        // cleared since we're explicitly re-promoting this signature.
        ...(reviving || existing.dismissed
          ? { dismissalState: 'none' as SuggestionDismissalState, laterUntil: undefined, dismissed: false }
          : {}),
      };
    } else {
      suggestions.push({
        id,
        hostname,
        proposedPrompt,
        rationale,
        confidence,
        evidenceCount: g.count,
        createdAt: now,
        dismissalState: 'none',
      });
    }
  }

  enforcePerHostnameCap(suggestions, hostname);
  await writeSuggestions(suggestions);
}

// ---------------------------------------------------------------------
// LLM analyzer (additive — heuristic above is the always-on fallback)
// ---------------------------------------------------------------------

interface LlmSuggestionItem {
  proposedPrompt: string;
  rationale: string;
  confidence?: number;
}

// Same balanced-brace recovery as the agent's parser, scoped to first
// {...}. Handles strings + escapes. Returns parsed object or null on
// any failure. Inlined here so the agent module doesn't have to export
// internals.
function findFirstJsonObjectString(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseFirstJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  const extracted = findFirstJsonObjectString(trimmed);
  if (extracted) candidates.push(extracted);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

// Stable id derived from hostname + (lowercased, capped) prompt. Same
// pattern → same id, so re-analysis updates the existing row instead of
// creating duplicates. The "sugg-" prefix is the LLM-namespace and
// stays disjoint from the heuristic's "auto-dismiss::..." ids.
function llmSuggestionId(hostname: string, proposedPrompt: string): string {
  const s = `${hostname}:${proposedPrompt.toLowerCase().slice(0, 60)}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return `sugg-${Math.abs(h).toString(36)}`;
}

function buildSuggestionsUserPrompt(
  hostname: string,
  events: UserBehaviorEvent[],
): string {
  const byType: Record<string, UserBehaviorEvent[]> = {};
  for (const e of events) {
    (byType[e.type] = byType[e.type] || []).push(e);
  }

  const lines: string[] = [];
  lines.push(`Hostname: ${hostname}`);
  lines.push('');
  lines.push('Recent behavior summary:');

  for (const [type, list] of Object.entries(byType)) {
    lines.push('');
    lines.push(`${type}: ${list.length} occurrences`);
    // Show up to 5 most-recent samples — newest matters most for
    // patterns the user is currently dealing with.
    const samples = list.slice(-5);
    for (const s of samples) {
      const parts: string[] = [];
      if (s.text) parts.push(`text="${s.text.slice(0, 60)}"`);
      if (s.selector) parts.push(`selector=${s.selector.slice(0, 80)}`);
      const md = s.metadata as Record<string, unknown> | undefined;
      if (md && typeof md.parentContext === 'string') {
        parts.push(`context="${(md.parentContext as string).slice(0, 100)}"`);
      }
      if (md && md.isModal === true) parts.push('isModal=true');
      lines.push(`  - ${parts.join(' ')}`);
    }
  }

  return lines.join('\n');
}

async function llmGenerateSuggestions(
  hostname: string,
  events: UserBehaviorEvent[],
  settings: ExtensionSettings,
): Promise<Suggestion[] | null> {
  try {
    const provider = PROVIDERS[settings.provider];
    if (!provider) return null;
    const apiKey = settings.apiKeys[settings.provider];
    if (!apiKey) return null;

    const userPrompt = buildSuggestionsUserPrompt(hostname, events);

    const turn = await provider.chat({
      messages: [{ role: 'user', content: userPrompt }],
      system: SUGGESTIONS_SYSTEM_PROMPT,
      tools: [], // single-turn; no tools, no agent loop
      apiKey,
      model: settings.model,
      // Speed > thoroughness for suggestions; ignore the user's
      // global high-effort preference here.
      effortMode: 'standard',
    });

    const text = turn.text || '';
    const parsed = parseFirstJsonObject(text);
    const raw = parsed?.suggestions;
    if (!Array.isArray(raw)) return null;

    const now = Date.now();
    const out: Suggestion[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      const proposedPrompt =
        typeof it.proposedPrompt === 'string' ? it.proposedPrompt.trim() : '';
      const rationale =
        typeof it.rationale === 'string' ? it.rationale.trim() : '';
      if (!proposedPrompt || !rationale) continue;
      const rawConf = typeof it.confidence === 'number' ? it.confidence : 0.6;
      const confidence = Math.min(0.95, Math.max(0, rawConf));
      out.push({
        id: llmSuggestionId(hostname, proposedPrompt),
        hostname,
        proposedPrompt,
        rationale,
        confidence,
        evidenceCount: events.length,
        createdAt: now,
        dismissalState: 'none',
      });
      if (out.length >= 3) break;
    }
    return out;
  } catch (e) {
    // Any failure (no API key, network error, malformed JSON, provider
    // throw) silently degrades: the heuristic suggestions remain.
    console.warn('[bob] LLM suggestions failed:', e);
    return null;
  }
}

// Upsert LLM-produced suggestions, respecting the existing dismissal
// lifecycle (never / later / none). Disjoint id namespace from
// heuristic so the two analyzers can't clobber each other.
async function upsertLlmSuggestions(
  hostname: string,
  next: Suggestion[],
): Promise<void> {
  if (next.length === 0) return;
  await withStorageLock(KEY_SUGGESTIONS, async () => {
    const all = await readSuggestions();
    const now = Date.now();
    for (const s of next) {
      const idx = all.findIndex((x) => x.id === s.id);
      if (idx >= 0) {
        const existing = all[idx];
        // Same precedence as the heuristic upsert: never blocks
        // re-creation; cooling-down 'later' rows aren't refreshed;
        // anything else gets the new fields and revives if 'later'
        // expired or legacy `dismissed` was set.
        if (existing.dismissalState === 'never') continue;
        if (
          existing.dismissalState === 'later' &&
          (existing.laterUntil ?? 0) > now
        ) {
          continue;
        }
        const reviving =
          existing.dismissalState === 'later' &&
          (existing.laterUntil ?? 0) <= now;
        all[idx] = {
          ...existing,
          proposedPrompt: s.proposedPrompt,
          rationale: s.rationale,
          confidence: s.confidence,
          evidenceCount: s.evidenceCount,
          // Keep original createdAt so per-hostname-cap "oldest first"
          // still reflects when the row first appeared.
          createdAt: existing.createdAt,
          ...(reviving || existing.dismissed
            ? {
                dismissalState: 'none' as SuggestionDismissalState,
                laterUntil: undefined,
                dismissed: false,
              }
            : {}),
        };
      } else {
        all.push(s);
      }
    }
    enforcePerHostnameCap(all, hostname);
    await writeSuggestions(all);
  });
}

// Trigger an LLM analysis if the throttle allows and there's actually
// new behavior to look at. `minIntervalMs` differs by trigger source
// (recordEvent uses 1h; popup-open uses 30m). The lock around the meta
// claim prevents two callers from both kicking off the call.
export async function maybeRunLlmAnalysis(
  hostname: string,
  minIntervalMs: number,
): Promise<void> {
  if (!hostname) return;

  // Snapshot the events for this host to decide whether there's
  // anything new since the last LLM run. Done before the lock claim so
  // we don't hold the meta lock during the LLM call.
  const allEvents = await readBehavior();
  const hostEvents = allEvents.filter((e) => e.hostname === hostname);
  if (hostEvents.length === 0) return;
  const maxEventTs = hostEvents.reduce(
    (acc, e) => (e.timestamp > acc ? e.timestamp : acc),
    0,
  );

  // Reserve the slot atomically: read meta, check throttle + new
  // behavior, write the timestamp. Two parallel callers can't both
  // pass.
  const cleared = await withStorageLock(KEY_META, async () => {
    const meta = await readMeta();
    const map = meta.lastLlmAnalyzedAt ?? {};
    const last = map[hostname] ?? 0;
    const now = Date.now();
    if (now - last < minIntervalMs) return false;
    if (last > 0 && maxEventTs <= last) return false;
    map[hostname] = now;
    meta.lastLlmAnalyzedAt = map;
    await writeMeta(meta);
    return true;
  });
  if (!cleared) return;

  let settings: ExtensionSettings;
  try {
    settings = await getSettings();
  } catch {
    return;
  }
  if (!settings.apiKeys[settings.provider]) {
    // No API key — heuristic remains; we just don't run the LLM.
    return;
  }

  // Trim the slice we send to the model: trailing 50 events from the
  // last LLM_LOOKBACK_MS window.
  const cutoff = Date.now() - LLM_LOOKBACK_MS;
  const recent = hostEvents
    .filter((e) => e.timestamp >= cutoff)
    .slice(-LLM_MAX_EVENTS);
  if (recent.length === 0) return;

  const result = await llmGenerateSuggestions(hostname, recent, settings);
  if (!result || result.length === 0) return;

  await upsertLlmSuggestions(hostname, result);
}

function enforcePerHostnameCap(suggestions: Suggestion[], hostname: string): void {
  const now = Date.now();
  const active = suggestions
    .filter((s) => s.hostname === hostname && isVisible(s, now))
    .sort((a, b) => a.createdAt - b.createdAt); // oldest first
  let overflow = active.length - PER_HOSTNAME_CAP;
  for (let i = 0; i < active.length && overflow > 0; i++) {
    const idx = suggestions.findIndex((s) => s.id === active[i].id);
    if (idx >= 0) {
      // Capped suggestions are demoted to 'never' so they don't keep
      // bouncing back. The legacy `dismissed` boolean is mirrored.
      suggestions[idx] = {
        ...suggestions[idx],
        dismissalState: 'never',
        laterUntil: undefined,
        dismissed: true,
      };
      overflow--;
    }
  }
}

export async function getSuggestions(hostname?: string): Promise<Suggestion[]> {
  // Popup-open trigger: kick off an LLM analysis for the requested
  // hostname under the looser 30-minute throttle. Fire-and-forget so
  // the popup gets the current rows immediately; new LLM rows land in
  // storage by the next time the popup is opened.
  if (hostname) void maybeRunLlmAnalysis(hostname, LLM_THROTTLE_OPEN_MS);

  const list = await readSuggestions();
  const now = Date.now();
  return list
    .filter((s) => isVisible(s, now))
    .filter((s) => (hostname ? s.hostname === hostname : true))
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.createdAt - a.createdAt;
    });
}

// Same shape as getSuggestions but defensively re-applies the
// dismissal filter so callers (popup) get the canonical "what should
// the user see right now" list. Cheap to call repeatedly.
export async function getVisibleSuggestions(
  hostname?: string,
): Promise<Suggestion[]> {
  const all = await getSuggestions(hostname);
  const now = Date.now();
  return all.filter(
    (s) => s.dismissalState !== 'later' || (s.laterUntil ?? 0) <= now,
  );
}

export async function setSuggestionState(
  id: string,
  state: SuggestionDismissalState,
): Promise<void> {
  return withStorageLock(KEY_SUGGESTIONS, async () => {
    const list = await readSuggestions();
    const idx = list.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const existing = list[idx];
    const next: Suggestion = {
      ...existing,
      dismissalState: state,
      laterUntil:
        state === 'later' ? Date.now() + LATER_COOLDOWN_MS : undefined,
      // Keep the legacy `dismissed` boolean in sync so older code paths
      // that still read it (e.g. popup rendering before the migration)
      // see the right thing.
      dismissed: state === 'never' || state === 'later',
    };
    list[idx] = next;
    await writeSuggestions(list);
  });
}

// Backward-compatible alias. Existing callers (DISMISS_SUGGESTION
// handler, popup) continue to work and now get permanent dismissal.
export async function dismissSuggestion(id: string): Promise<void> {
  return setSuggestionState(id, 'never');
}

export async function acceptSuggestion(
  id: string,
): Promise<{ proposedPrompt: string; hostname: string }> {
  return withStorageLock(KEY_SUGGESTIONS, async () => {
    const list = await readSuggestions();
    const idx = list.findIndex((s) => s.id === id);
    if (idx < 0) {
      throw new Error('suggestion not found: ' + id);
    }
    const s = list[idx];
    // Accepting transitions to 'never' — the user has acted on the
    // suggestion and we shouldn't keep proposing the same one.
    list[idx] = {
      ...s,
      dismissalState: 'never',
      laterUntil: undefined,
      dismissed: true,
    };
    await writeSuggestions(list);
    return { proposedPrompt: s.proposedPrompt, hostname: s.hostname };
  });
}
