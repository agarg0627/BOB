// Owned by Person C.
import type { Feature, Suggestion, UserBehaviorEvent } from './types';

const KEY = 'features';

function escapeRegexChar(c: string): string {
  return c.replace(/[.+^$(){}|\[\]\\\/]/g, '\\$&');
}

function globToRegex(pattern: string): RegExp {
  let body = '';
  for (const c of pattern) {
    if (c === '*') body += '.*';
    else if (c === '?') body += '.';
    else body += escapeRegexChar(c);
  }
  return new RegExp('^' + body + '$');
}

async function readAll(): Promise<Feature[]> {
  const result = await chrome.storage.local.get(KEY);
  const arr = result[KEY];
  return Array.isArray(arr) ? (arr as Feature[]) : [];
}

async function writeAll(features: Feature[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: features });
}

export const Storage = {
  async list(): Promise<Feature[]> {
    return readAll();
  },

  async get(id: string): Promise<Feature | null> {
    const all = await readAll();
    return all.find((f) => f.id === id) ?? null;
  },

  async add(input: Omit<Feature, 'id' | 'createdAt'>): Promise<Feature> {
    const feature: Feature = {
      ...input,
      runCount: input.runCount ?? 0,
      errorCount: input.errorCount ?? 0,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    const all = await readAll();
    all.push(feature);
    await writeAll(all);
    return feature;
  },

  async update(id: string, patch: Partial<Feature>): Promise<void> {
    const all = await readAll();
    const idx = all.findIndex((f) => f.id === id);
    if (idx === -1) return;
    const existing = all[idx];
    all[idx] = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
    };
    await writeAll(all);
  },

  async remove(id: string): Promise<void> {
    const all = await readAll();
    await writeAll(all.filter((f) => f.id !== id));
  },

  async matching(url: string): Promise<Feature[]> {
    const all = await readAll();
    return all.filter((f) => f.enabled && globToRegex(f.urlPattern).test(url));
  },
};


// --- Phase 3: Behavior tracking and Suggestions ---

const BEHAVIOR_KEY = 'behavior';
const SUGGESTIONS_KEY = 'suggestions';
const MAX_BEHAVIOR_EVENTS = 500;

export const Behavior = {
  async append(event: UserBehaviorEvent): Promise<void> {
    const stored = (await chrome.storage.local.get(BEHAVIOR_KEY))[BEHAVIOR_KEY];
    const all = (Array.isArray(stored) ? stored : []) as UserBehaviorEvent[];
    all.push(event);
    if (all.length > MAX_BEHAVIOR_EVENTS) {
      all.splice(0, all.length - MAX_BEHAVIOR_EVENTS);
    }
    await chrome.storage.local.set({ [BEHAVIOR_KEY]: all });
  },
  async list(hostname?: string): Promise<UserBehaviorEvent[]> {
    const stored = (await chrome.storage.local.get(BEHAVIOR_KEY))[BEHAVIOR_KEY];
    const all = (Array.isArray(stored) ? stored : []) as UserBehaviorEvent[];
    return hostname ? all.filter((e) => e.hostname === hostname) : all;
  },
  async clear(): Promise<void> {
    await chrome.storage.local.set({ [BEHAVIOR_KEY]: [] });
  },
};

export const Suggestions = {
  async list(): Promise<Suggestion[]> {
    const stored = (await chrome.storage.local.get(SUGGESTIONS_KEY))[SUGGESTIONS_KEY];
    return (Array.isArray(stored) ? stored : []) as Suggestion[];
  },
  async upsert(s: Suggestion): Promise<void> {
    const all = await Suggestions.list();
    const i = all.findIndex((x) => x.id === s.id);
    if (i >= 0) all[i] = s;
    else all.push(s);
    await chrome.storage.local.set({ [SUGGESTIONS_KEY]: all });
  },
  async remove(id: string): Promise<void> {
    const all = await Suggestions.list();
    await chrome.storage.local.set({
      [SUGGESTIONS_KEY]: all.filter((s) => s.id !== id),
    });
  },
  async clear(): Promise<void> {
    await chrome.storage.local.set({ [SUGGESTIONS_KEY]: [] });
  },
};
