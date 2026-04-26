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
// LLM throttles. Relaxed from 1h/30m → 30m/15m so users see new
// suggestions sooner after they've actually browsed something. Cost
// stays bounded because each call still summarizes ≤80 events into a
// single chat() turn (no agent loop).
const LLM_THROTTLE_RECORD_MS = 30 * 60_000;
const LLM_THROTTLE_OPEN_MS = 15 * 60_000;
// LLM analysis looks at the trailing slice of behavior to keep prompt
// cost predictable. 80 events + 7-day window catches the new
// site_sequence and frequent_search_destination patterns which are
// inherently spread out over time.
const LLM_MAX_EVENTS = 80;
const LLM_LOOKBACK_MS = 7 * 24 * 60 * 60_000; // 7 days
// Heuristic evidence threshold relaxed from 3 → 2 so the simplest
// auto-dismiss suggestions show up after the second repeat dismissal,
// not the third. The LLM analyzer still gates its own output on
// confidence, so this won't make LLM suggestions noisier.
const MIN_EVIDENCE = 2;
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

// Shared upsert that respects three-state dismissal (never blocks
// re-creation; cooling-down 'later' doesn't refresh; revival clears
// dismissal). Used by every heuristic analyzer below.
function upsertHeuristic(
  suggestions: Suggestion[],
  now: number,
  candidate: {
    id: string;
    hostname: string;
    proposedPrompt: string;
    rationale: string;
    confidence: number;
    evidenceCount: number;
  },
): boolean {
  const idx = suggestions.findIndex((s) => s.id === candidate.id);
  if (idx >= 0) {
    const existing = suggestions[idx];
    if (existing.dismissalState === 'never') return false;
    if (
      existing.dismissalState === 'later' &&
      (existing.laterUntil ?? 0) > now
    ) {
      return false;
    }
    const reviving =
      existing.dismissalState === 'later' &&
      (existing.laterUntil ?? 0) <= now;
    suggestions[idx] = {
      ...existing,
      proposedPrompt: candidate.proposedPrompt,
      rationale: candidate.rationale,
      confidence: candidate.confidence,
      evidenceCount: candidate.evidenceCount,
      // Preserve original createdAt so per-hostname-cap "oldest first"
      // reflects when the suggestion first appeared, not the upsert.
      createdAt: existing.createdAt,
      ...(reviving || existing.dismissed
        ? {
            dismissalState: 'none' as SuggestionDismissalState,
            laterUntil: undefined,
            dismissed: false,
          }
        : {}),
    };
    return true;
  }
  suggestions.push({
    ...candidate,
    createdAt: now,
    dismissalState: 'none',
  });
  return true;
}

// Auto-dismiss heuristic (the original): if the user has clicked a
// close-like signature MIN_EVIDENCE+ times, propose an auto-dismiss.
function analyzeAutoDismiss(
  suggestions: Suggestion[],
  hostEvents: UserBehaviorEvent[],
  hostname: string,
  now: number,
): number {
  const closeEvents = hostEvents.filter(
    (e) => e.type === 'click_close' || e.type === 'click_dismiss',
  );
  if (closeEvents.length === 0) return 0;

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

  let upserted = 0;
  for (const [key, g] of groups) {
    if (g.count < MIN_EVIDENCE) continue;
    const sample = g.sampleText || 'this dialog';
    if (
      upsertHeuristic(suggestions, now, {
        id: suggestionId(hostname, key),
        hostname,
        proposedPrompt:
          `Automatically click any element with text "${sample}" or class matching the close button so I don't have to dismiss it manually`,
        rationale: `You've dismissed "${sample}" ${g.count} times on this site`,
        confidence: Math.min(0.4 + 0.1 * g.count, 0.9),
        evidenceCount: g.count,
      })
    ) {
      upserted++;
    }
  }
  return upserted;
}

// Time-management heuristic for shorts/reels doomscroll signal. Tailored
// to the surface so the proposedPrompt is concrete enough for the agent
// to actually generate working code.
function analyzeShortsDoomscroll(
  suggestions: Suggestion[],
  hostEvents: UserBehaviorEvent[],
  hostname: string,
  now: number,
): number {
  const dsEvents = hostEvents.filter((e) => e.type === 'shorts_doomscroll');
  if (dsEvents.length === 0) return 0;

  const latest = dsEvents[dsEvents.length - 1];
  const surface = String(latest.metadata?.surface ?? '');

  let proposedPrompt: string | null = null;
  if (hostname.includes('youtube.com') && surface.startsWith('/shorts')) {
    proposedPrompt =
      "Hide the YouTube Shorts shelf on the homepage and remove the Shorts tab from the sidebar so I don't end up scrolling them.";
  } else if (
    hostname.includes('instagram.com') &&
    (surface.startsWith('/reels') || surface.startsWith('/reel'))
  ) {
    proposedPrompt =
      "Replace the Instagram Reels feed with a blank page that says 'go do something else' so I'm not tempted to scroll.";
  } else if (hostname.includes('tiktok.com')) {
    proposedPrompt =
      'Show a banner with a 5-minute timer that asks if I still want to keep scrolling TikTok.';
  } else {
    return 0; // unknown surface — let the LLM handle it
  }

  const sessions = dsEvents.length;
  const rationale =
    sessions === 1
      ? "You've had a 15+ second active scrolling session here recently."
      : `You've had ${sessions} extended scrolling sessions here recently.`;

  return upsertHeuristic(suggestions, now, {
    id: `shorts-doomscroll::${hostname}`,
    hostname,
    proposedPrompt,
    rationale,
    confidence: Math.min(0.55 + 0.05 * (sessions - 1), 0.85),
    evidenceCount: sessions,
  })
    ? 1
    : 0;
}

// Auto-bookmark heuristic for repeated search arrivals.
function analyzeFrequentSearchDestination(
  suggestions: Suggestion[],
  hostEvents: UserBehaviorEvent[],
  hostname: string,
  now: number,
): number {
  const fsEvents = hostEvents.filter(
    (e) => e.type === 'frequent_search_destination',
  );
  if (fsEvents.length === 0) return 0;

  const latest = fsEvents[fsEvents.length - 1];
  const count = Number(latest.metadata?.count ?? 0);
  if (count < 3) return 0;
  const referrer = String(latest.metadata?.referrer ?? 'a search engine');

  return upsertHeuristic(suggestions, now, {
    id: `freq-search::${hostname}`,
    hostname,
    proposedPrompt:
      `On ${hostname}, show a small banner reminding me to bookmark this site (I keep ending up here from ${referrer}).`,
    rationale: `You've arrived at ${hostname} from ${referrer} ${count} times in the last week.`,
    confidence: Math.min(0.55 + 0.04 * (count - 3), 0.85),
    evidenceCount: count,
  })
    ? 1
    : 0;
}

// Cross-site shortcut heuristic. Emits one suggestion per (from, to)
// pair seen 3+ times. The hostname on the event IS the FROM site, so
// the suggestion lands on the right surface.
function analyzeSiteSequences(
  suggestions: Suggestion[],
  hostEvents: UserBehaviorEvent[],
  hostname: string,
  now: number,
): number {
  const ssEvents = hostEvents.filter((e) => e.type === 'site_sequence');
  if (ssEvents.length === 0) return 0;

  const byDestination = new Map<string, UserBehaviorEvent[]>();
  for (const e of ssEvents) {
    const to = String(e.metadata?.to ?? '');
    if (!to) continue;
    const list = byDestination.get(to) ?? [];
    list.push(e);
    byDestination.set(to, list);
  }

  let upserted = 0;
  for (const [to, list] of byDestination) {
    const latest = list[list.length - 1];
    const count = Number(latest.metadata?.count ?? 0);
    if (count < 3) continue;

    if (
      upsertHeuristic(suggestions, now, {
        id: `site-seq::${hostname}::${to}`,
        hostname,
        proposedPrompt:
          `Add a button on ${hostname} pages that opens ${to} in a new tab with the current page's title as a search query.`,
        rationale: `You've gone from ${hostname} to ${to} ${count} times — a one-click shortcut would save tab juggling.`,
        confidence: Math.min(0.55 + 0.04 * (count - 3), 0.85),
        evidenceCount: count,
      })
    ) {
      upserted++;
    }
  }
  return upserted;
}

async function analyzeAndUpsertLocked(hostname: string): Promise<void> {
  const events = await readBehavior();
  const hostEvents = events.filter((e) => e.hostname === hostname);
  if (hostEvents.length === 0) return;

  const suggestions = await readSuggestions();
  const now = Date.now();

  // Run every heuristic. Each is no-op when its signal isn't present,
  // so calling them all unconditionally is cheap and means new signal
  // types can never silently lack a fallback.
  const counts = {
    autoDismiss: analyzeAutoDismiss(suggestions, hostEvents, hostname, now),
    shorts: analyzeShortsDoomscroll(suggestions, hostEvents, hostname, now),
    search: analyzeFrequentSearchDestination(
      suggestions,
      hostEvents,
      hostname,
      now,
    ),
    sequence: analyzeSiteSequences(suggestions, hostEvents, hostname, now),
  };
  const total = counts.autoDismiss + counts.shorts + counts.search + counts.sequence;
  if (total > 0) {
    console.log(
      `[bob][suggestions] heuristic upserted ${total} for ${hostname}:`,
      counts,
    );
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
      if (md) {
        if (typeof md.parentContext === 'string') {
          parts.push(`context="${(md.parentContext as string).slice(0, 100)}"`);
        }
        if (md.isModal === true) parts.push('isModal=true');
        // Surface metadata that's specific to the new event types so
        // the LLM can infer intent: shorts surface, search referrer,
        // and (from, to, count) for cross-site sequences.
        if (typeof md.surface === 'string') {
          parts.push(`surface=${(md.surface as string).slice(0, 60)}`);
        }
        if (typeof md.activeScrollMs === 'number') {
          parts.push(`activeScrollMs=${md.activeScrollMs}`);
        }
        if (typeof md.referrer === 'string') {
          parts.push(`referrer=${(md.referrer as string).slice(0, 60)}`);
        }
        if (typeof md.from === 'string') {
          parts.push(`from=${(md.from as string).slice(0, 60)}`);
        }
        if (typeof md.to === 'string') {
          parts.push(`to=${(md.to as string).slice(0, 60)}`);
        }
        if (typeof md.count === 'number') {
          parts.push(`count=${md.count}`);
        }
      }
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
    if (!parsed) {
      // Visibility into the silent-no-op case: model returned text we
      // couldn't parse as JSON at all. Without this log the user sees
      // "no suggestions appeared" and can't tell why.
      console.warn(
        `[bob][suggestions] LLM response was not parseable JSON. First 300 chars:`,
        text.slice(0, 300),
      );
      return null;
    }
    const raw = parsed.suggestions;
    if (!Array.isArray(raw)) {
      console.warn(
        `[bob][suggestions] LLM response missing "suggestions" array. Got keys:`,
        Object.keys(parsed),
      );
      return null;
    }

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
// (recordEvent uses 30m; popup-open uses 15m). The lock around the
// meta claim prevents two callers from both kicking off the call.
//
// CRITICAL ordering: API-key + provider availability is checked
// BEFORE the throttle slot is claimed. An earlier version reversed
// these and silently consumed the throttle on every event when no
// key was set, which prevented LLM analysis from running for the
// next 30 minutes after the user added a key. Don't reorder.
export async function maybeRunLlmAnalysis(
  hostname: string,
  minIntervalMs: number,
): Promise<void> {
  if (!hostname) return;

  let settings: ExtensionSettings;
  try {
    settings = await getSettings();
  } catch (e) {
    console.warn('[bob][suggestions] getSettings failed:', e);
    return;
  }
  const provider = PROVIDERS[settings.provider];
  if (!provider) {
    console.log(
      `[bob][suggestions] unknown provider "${settings.provider}", skipping LLM`,
    );
    return;
  }
  const apiKey = settings.apiKeys[settings.provider];
  if (!apiKey) {
    // Don't claim the throttle — heuristic-only mode, but the moment
    // the user adds a key we want LLM analysis to be eligible.
    console.log(
      `[bob][suggestions] no ${settings.provider} API key — heuristic only for ${hostname}`,
    );
    return;
  }

  // Snapshot events and decide whether there's anything new since the
  // last LLM run. Done before the lock claim so we don't hold the meta
  // lock during the LLM call (which is several seconds long).
  const allEvents = await readBehavior();
  const hostEvents = allEvents.filter((e) => e.hostname === hostname);
  if (hostEvents.length === 0) return;
  const maxEventTs = hostEvents.reduce(
    (acc, e) => (e.timestamp > acc ? e.timestamp : acc),
    0,
  );

  // Reserve the slot atomically.
  const cleared = await withStorageLock(KEY_META, async () => {
    const meta = await readMeta();
    const map = meta.lastLlmAnalyzedAt ?? {};
    const last = map[hostname] ?? 0;
    const now = Date.now();
    if (now - last < minIntervalMs) {
      console.log(
        `[bob][suggestions] LLM throttled for ${hostname} (${Math.round(
          (minIntervalMs - (now - last)) / 1000,
        )}s remaining)`,
      );
      return false;
    }
    if (last > 0 && maxEventTs <= last) {
      console.log(
        `[bob][suggestions] LLM skipped for ${hostname} — no new events since last run`,
      );
      return false;
    }
    map[hostname] = now;
    meta.lastLlmAnalyzedAt = map;
    await writeMeta(meta);
    return true;
  });
  if (!cleared) return;

  // Trim slice: trailing LLM_MAX_EVENTS events from the LLM_LOOKBACK_MS
  // window. The signal carriers (site_sequence, frequent_search_*,
  // shorts_doomscroll) need the wider window because they're inherently
  // sparse.
  const cutoff = Date.now() - LLM_LOOKBACK_MS;
  const recent = hostEvents
    .filter((e) => e.timestamp >= cutoff)
    .slice(-LLM_MAX_EVENTS);
  if (recent.length === 0) {
    console.log(
      `[bob][suggestions] LLM skipped for ${hostname} — no events in lookback window`,
    );
    return;
  }

  console.log(
    `[bob][suggestions] running LLM for ${hostname} on ${recent.length} events`,
  );
  const result = await llmGenerateSuggestions(hostname, recent, settings);
  if (!result) {
    console.warn(
      `[bob][suggestions] LLM call for ${hostname} returned null (failure or unparseable response)`,
    );
    return;
  }
  if (result.length === 0) {
    console.log(
      `[bob][suggestions] LLM for ${hostname}: 0 suggestions (restraint)`,
    );
    return;
  }

  console.log(
    `[bob][suggestions] LLM produced ${result.length} suggestion(s) for ${hostname}:`,
    result.map((r) => r.proposedPrompt.slice(0, 60)),
  );
  await upsertLlmSuggestions(hostname, result);
}

// LLM-produced rows have ids starting with `sugg-`. Heuristic rows use
// other namespaces (`auto-dismiss::*`, `shorts-doomscroll::*`, etc.).
function isLlmSuggestion(s: Suggestion): boolean {
  return s.id.startsWith('sugg-');
}

function enforcePerHostnameCap(suggestions: Suggestion[], hostname: string): void {
  const now = Date.now();
  // Sort so LLM rows demote first (heuristic rows are the safety net
  // and we never want them silently lost when the LLM produces a
  // bunch of fresh suggestions). Tie-break: oldest createdAt first.
  const active = suggestions
    .filter((s) => s.hostname === hostname && isVisible(s, now))
    .sort((a, b) => {
      const aLlm = isLlmSuggestion(a) ? 0 : 1;
      const bLlm = isLlmSuggestion(b) ? 0 : 1;
      if (aLlm !== bLlm) return aLlm - bLlm;
      return a.createdAt - b.createdAt;
    });
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

// ---------------------------------------------------------------------
// Debug helpers — surfaced to the SW console for testing the pipeline.
// Not used by production UI.
// ---------------------------------------------------------------------

export interface DebugForceReport {
  hostname: string;
  ranHeuristic: boolean;
  ranLlm: boolean;
  llmSkippedReason?: string;
  llmRows: number;
  totalAfter: number;
}

// Bypass throttles and run BOTH heuristic and LLM analysis right now
// for the requested hostname. Returns a small report so the user can
// see what actually fired. Useful when manually testing in the SW
// console: `await chrome.runtime.sendMessage({ type: 'DEBUG_FORCE_SUGGESTIONS', hostname: 'amazon.com' })`.
export async function debugForceSuggestions(
  hostname: string,
): Promise<DebugForceReport> {
  if (!hostname) {
    return {
      hostname,
      ranHeuristic: false,
      ranLlm: false,
      llmSkippedReason: 'empty hostname',
      llmRows: 0,
      totalAfter: 0,
    };
  }
  console.log(`[bob][suggestions] DEBUG_FORCE for ${hostname}`);

  // Always run the heuristic.
  await analyzeAndUpsert(hostname);

  // Run the LLM directly (skipping the throttle gate).
  let ranLlm = false;
  let llmRows = 0;
  let llmSkippedReason: string | undefined;
  try {
    const settings = await getSettings();
    const provider = PROVIDERS[settings.provider];
    const apiKey = settings.apiKeys[settings.provider];
    if (!provider) {
      llmSkippedReason = `unknown provider "${settings.provider}"`;
    } else if (!apiKey) {
      llmSkippedReason = `no API key for ${settings.provider}`;
    } else {
      const allEvents = await readBehavior();
      const cutoff = Date.now() - LLM_LOOKBACK_MS;
      const recent = allEvents
        .filter((e) => e.hostname === hostname && e.timestamp >= cutoff)
        .slice(-LLM_MAX_EVENTS);
      if (recent.length === 0) {
        llmSkippedReason = 'no events in lookback window';
      } else {
        ranLlm = true;
        const result = await llmGenerateSuggestions(hostname, recent, settings);
        if (!result) {
          llmSkippedReason = 'LLM call returned null (parse failure or error)';
        } else if (result.length === 0) {
          llmSkippedReason = 'LLM returned 0 suggestions (restraint)';
        } else {
          llmRows = result.length;
          await upsertLlmSuggestions(hostname, result);
          // Update throttle so subsequent natural triggers don't immediately re-run.
          await withStorageLock(KEY_META, async () => {
            const meta = await readMeta();
            const map = meta.lastLlmAnalyzedAt ?? {};
            map[hostname] = Date.now();
            meta.lastLlmAnalyzedAt = map;
            await writeMeta(meta);
          });
        }
      }
    }
  } catch (e) {
    llmSkippedReason = `error: ${(e as Error).message}`;
    console.warn('[bob][suggestions] DEBUG_FORCE LLM path threw:', e);
  }

  const after = await readSuggestions();
  const totalAfter = after.filter((s) => s.hostname === hostname).length;

  const report: DebugForceReport = {
    hostname,
    ranHeuristic: true,
    ranLlm,
    llmSkippedReason,
    llmRows,
    totalAfter,
  };
  console.log('[bob][suggestions] DEBUG_FORCE report:', report);
  return report;
}

export interface DebugStateReport {
  hostname: string | undefined;
  totalEvents: number;
  eventsByType: Record<string, number>;
  totalSuggestions: number;
  suggestionsByState: Record<string, number>;
  visibleSuggestions: number;
  visibleSuggestionsForHost: number;
  apiKeyConfigured: boolean;
  provider: string;
  lastHeuristicAnalyzedAt: number | undefined;
  lastLlmAnalyzedAt: number | undefined;
  msSinceLastLlm: number | undefined;
  llmThrottleRecordMs: number;
  llmThrottleOpenMs: number;
}

// Snapshot of the entire pipeline state for a hostname (or globally if
// hostname is omitted). Useful when the user reports "suggestions
// aren't appearing" — call this and the report shows where the
// pipeline is stuck.
export async function debugSuggestionsState(
  hostname?: string,
): Promise<DebugStateReport> {
  const events = await readBehavior();
  const filtered = hostname
    ? events.filter((e) => e.hostname === hostname)
    : events;
  const eventsByType: Record<string, number> = {};
  for (const e of filtered) {
    eventsByType[e.type] = (eventsByType[e.type] ?? 0) + 1;
  }

  const suggestions = await readSuggestions();
  const all = hostname
    ? suggestions.filter((s) => s.hostname === hostname)
    : suggestions;
  const now = Date.now();
  const suggestionsByState: Record<string, number> = {
    none: 0,
    later: 0,
    never: 0,
    legacyDismissed: 0,
  };
  for (const s of all) {
    if (s.dismissalState === 'never') suggestionsByState.never++;
    else if (s.dismissalState === 'later') suggestionsByState.later++;
    else if (s.dismissalState === 'none' || !s.dismissalState)
      suggestionsByState.none++;
    if (s.dismissed && !s.dismissalState) suggestionsByState.legacyDismissed++;
  }

  const visible = suggestions.filter((s) => isVisible(s, now));
  const visibleForHost = hostname
    ? visible.filter((s) => s.hostname === hostname)
    : visible;

  let apiKeyConfigured = false;
  let provider = 'unknown';
  try {
    const settings = await getSettings();
    provider = settings.provider;
    apiKeyConfigured = !!settings.apiKeys[settings.provider];
  } catch {
    // ignore
  }

  const meta = await readMeta();
  const lastH = hostname ? meta.lastAnalyzedAt[hostname] : undefined;
  const lastL = hostname ? meta.lastLlmAnalyzedAt?.[hostname] : undefined;

  const report: DebugStateReport = {
    hostname,
    totalEvents: filtered.length,
    eventsByType,
    totalSuggestions: all.length,
    suggestionsByState,
    visibleSuggestions: visible.length,
    visibleSuggestionsForHost: visibleForHost.length,
    apiKeyConfigured,
    provider,
    lastHeuristicAnalyzedAt: lastH,
    lastLlmAnalyzedAt: lastL,
    msSinceLastLlm: lastL ? now - lastL : undefined,
    llmThrottleRecordMs: LLM_THROTTLE_RECORD_MS,
    llmThrottleOpenMs: LLM_THROTTLE_OPEN_MS,
  };
  console.log('[bob][suggestions] DEBUG_STATE report:', report);
  return report;
}
