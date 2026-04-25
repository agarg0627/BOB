// Popup-side helpers for the iteration flow.
//
// These touch the active tab — sending an OPEN_OVERLAY_FOR_EDIT message
// to the content script when the user clicks Edit, and reloading the tab
// after a toggle/delete so the page reflects the change immediately.
//
// Glob matching is duplicated from src/shared/storage.ts (the matcher
// there is internal to the Storage object). Kept identical so the popup
// agrees with the background about which features apply to a URL.
import type { Feature } from '../shared/types';

export type StartEditResult =
  | { ok: true }
  | { ok: false; reason: 'no-tab' | 'mismatch' | 'send-failed' };

function escapeRegexChar(c: string): string {
  return c.replace(/[.+^$(){}|\[\]\\\/]/g, '\\$&');
}

function patternToRegex(pattern: string): RegExp {
  let body = '';
  for (const c of pattern) {
    if (c === '*') body += '.*';
    else if (c === '?') body += '.';
    else body += escapeRegexChar(c);
  }
  return new RegExp('^' + body + '$');
}

export function patternMatchesUrl(pattern: string, url: string): boolean {
  try {
    return patternToRegex(pattern).test(url);
  } catch {
    return false;
  }
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  } catch {
    return null;
  }
}

export async function startEdit(feature: Feature): Promise<StartEditResult> {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) return { ok: false, reason: 'no-tab' };
  if (!patternMatchesUrl(feature.urlPattern, tab.url)) {
    return { ok: false, reason: 'mismatch' };
  }
  try {
    // Fire-and-forget — the content script will respond, but we close the
    // popup immediately so we don't await the round-trip.
    void chrome.tabs.sendMessage(tab.id, {
      type: 'OPEN_OVERLAY_FOR_EDIT',
      featureId: feature.id,
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'send-failed' };
  }
}

export async function maybeReloadActiveTab(
  feature: Feature,
): Promise<{ reloaded: boolean; matched: boolean }> {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) return { reloaded: false, matched: false };
  if (!patternMatchesUrl(feature.urlPattern, tab.url)) {
    return { reloaded: false, matched: false };
  }
  try {
    await chrome.tabs.reload(tab.id);
    return { reloaded: true, matched: true };
  } catch {
    return { reloaded: false, matched: true };
  }
}
