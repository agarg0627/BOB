// Analyzes accumulated behavior events and produces Suggestion rows.
//
// Storage layout in chrome.storage.local:
//   behavior:        UserBehaviorEvent[]   (capped at MAX_BEHAVIOR_EVENTS)
//   suggestions:     Suggestion[]
//   suggestionsMeta: { lastAnalyzedAt: { [hostname]: number } }
//
// Heuristic A (the "demo" one): if the user has clicked close-like
// elements with the same text/selector signature 3+ times on the same
// hostname, propose an auto-dismiss feature.
//
// Heuristic B (declutter on long sessions) is documented in the spec
// as optional; not implemented here. The tracker still emits
// time_on_site events so a future heuristic can pick them up without
// changing the data plane.
import type { Suggestion, UserBehaviorEvent } from '../shared/types';

const MAX_BEHAVIOR_EVENTS = 500;
const ANALYZE_THROTTLE_MS = 60_000;
const MIN_EVIDENCE = 3;
const PER_HOSTNAME_CAP = 5;

const KEY_BEHAVIOR = 'behavior';
const KEY_SUGGESTIONS = 'suggestions';
const KEY_META = 'suggestionsMeta';

interface SuggestionsMeta {
  lastAnalyzedAt: Record<string, number>;
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
    return meta as SuggestionsMeta;
  }
  return { lastAnalyzedAt: {} };
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

export async function recordEvent(event: UserBehaviorEvent): Promise<void> {
  if (!event || typeof event !== 'object') return;

  // Append + trim to MAX_BEHAVIOR_EVENTS, oldest dropped first.
  const list = await readBehavior();
  list.push(event);
  if (list.length > MAX_BEHAVIOR_EVENTS) {
    list.splice(0, list.length - MAX_BEHAVIOR_EVENTS);
  }
  await writeBehavior(list);

  const host = event.hostname;
  if (!host) return;

  // Throttle analysis: at most one analyzeAndUpsert call per minute per
  // hostname.
  const meta = await readMeta();
  const last = meta.lastAnalyzedAt[host] ?? 0;
  const now = Date.now();
  if (now - last < ANALYZE_THROTTLE_MS) return;
  meta.lastAnalyzedAt[host] = now;
  await writeMeta(meta);

  await analyzeAndUpsert(host);
}

export async function analyzeAndUpsert(hostname: string): Promise<void> {
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
      });
    }
  }

  enforcePerHostnameCap(suggestions, hostname);
  await writeSuggestions(suggestions);
}

function enforcePerHostnameCap(suggestions: Suggestion[], hostname: string): void {
  const active = suggestions
    .filter((s) => s.hostname === hostname && !s.dismissed)
    .sort((a, b) => a.createdAt - b.createdAt); // oldest first
  let overflow = active.length - PER_HOSTNAME_CAP;
  for (let i = 0; i < active.length && overflow > 0; i++) {
    const idx = suggestions.findIndex((s) => s.id === active[i].id);
    if (idx >= 0) {
      suggestions[idx] = { ...suggestions[idx], dismissed: true };
      overflow--;
    }
  }
}

export async function getSuggestions(hostname?: string): Promise<Suggestion[]> {
  const list = await readSuggestions();
  return list
    .filter((s) => !s.dismissed)
    .filter((s) => (hostname ? s.hostname === hostname : true))
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.createdAt - a.createdAt;
    });
}

export async function dismissSuggestion(id: string): Promise<void> {
  const list = await readSuggestions();
  const idx = list.findIndex((s) => s.id === id);
  if (idx < 0) return;
  list[idx] = { ...list[idx], dismissed: true };
  await writeSuggestions(list);
}

export async function acceptSuggestion(
  id: string,
): Promise<{ proposedPrompt: string; hostname: string }> {
  const list = await readSuggestions();
  const idx = list.findIndex((s) => s.id === id);
  if (idx < 0) {
    throw new Error('suggestion not found: ' + id);
  }
  const s = list[idx];
  list[idx] = { ...s, dismissed: true };
  await writeSuggestions(list);
  return { proposedPrompt: s.proposedPrompt, hostname: s.hostname };
}
