/**
 * Coordinates feature execution across the page lifecycle.
 *
 * Cleanup is delegated to page reloads (Person D triggers a reload
 * on toggle-off / delete) and to feature idempotency on re-run
 * (the system prompt instructs the LLM to make features safely
 * re-runnable). This module does NOT attempt DOM rollback.
 */

import { onUrlChange } from './spa';

export interface LifecycleHooks {
  onPageReady: () => Promise<void>;
  onUrlChange: () => Promise<void>;
}

const COOLDOWN_MS = 300;

let started = false;
let lastUrlFireAt = 0;

export function initLifecycle(hooks: LifecycleHooks): void {
  if (started) return;
  started = true;

  // Initial page-load run. Fire and forget — the integration code
  // wraps onPageReady in its own try/catch, but we still detach the
  // promise here so initLifecycle stays synchronous for callers.
  void hooks.onPageReady();

  onUrlChange(async () => {
    const now = Date.now();
    if (now - lastUrlFireAt < COOLDOWN_MS) return;
    lastUrlFireAt = now;
    try {
      await hooks.onUrlChange();
    } catch (e) {
      console.error('[bob] lifecycle.onUrlChange threw:', e);
    }
  });
}
