// Detects same-origin SPA navigation by patching the History API in
// the page's MAIN world. Content scripts run in an isolated world, so
// patching there wouldn't see page-initiated pushState/replaceState
// calls. The MAIN-world patch dispatches a CustomEvent on `window`
// which we listen for from the isolated world to drive listeners.

export type UrlChangeListener = (newUrl: string, oldUrl: string) => void;

const URL_EVENT = '__bob_url_change';
const ACTIVE_FLAG = '__bobSpaWatcherActive';
const DEBOUNCE_MS = 50;

const listeners = new Set<UrlChangeListener>();
let lastUrl = '';
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const PATCH_SOURCE = `(function(){
  if (window.__bobSpaPatched) return;
  window.__bobSpaPatched = true;
  var fire = function(){
    try { window.dispatchEvent(new CustomEvent('${URL_EVENT}')); } catch (e) {}
  };
  var _ps = history.pushState;
  history.pushState = function(){
    var r = _ps.apply(this, arguments);
    fire();
    return r;
  };
  var _rs = history.replaceState;
  history.replaceState = function(){
    var r = _rs.apply(this, arguments);
    fire();
    return r;
  };
  window.addEventListener('popstate', fire);
  window.addEventListener('hashchange', fire);
})();`;

function injectIntoMainWorld(source: string): void {
  // @ts-ignore — trustedTypes isn't in the default lib types
  const tt = (window as any).trustedTypes;
  let scriptValue: unknown = source;
  if (tt && tt.createPolicy) {
    const policy =
      tt.defaultPolicy ??
      tt.createPolicy('bob-spa-' + Math.random().toString(36).slice(2), {
        createScript: (s: string) => s,
        createHTML: (s: string) => s,
        createScriptURL: (s: string) => s,
      });
    scriptValue = policy.createScript(source);
  }
  const script = document.createElement('script');
  // @ts-ignore — TrustedScript is structurally a string at runtime
  script.textContent = scriptValue;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

function flush(): void {
  debounceTimer = null;
  const current = location.href;
  if (current === lastUrl) return;
  const old = lastUrl;
  lastUrl = current;
  // Snapshot so listeners can unsubscribe themselves without affecting
  // this dispatch loop.
  const snapshot = Array.from(listeners);
  for (const fn of snapshot) {
    try {
      fn(current, old);
    } catch (e) {
      console.error('[bob] url-change listener threw:', e);
    }
  }
}

function onMainWorldEvent(): void {
  if (debounceTimer != null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flush, DEBOUNCE_MS);
}

export function onUrlChange(listener: UrlChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function initSpaWatcher(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w[ACTIVE_FLAG]) return;
  w[ACTIVE_FLAG] = true;

  lastUrl = location.href;

  try {
    injectIntoMainWorld(PATCH_SOURCE);
  } catch (e) {
    console.error('[bob] SPA patch injection failed:', e);
  }

  window.addEventListener(URL_EVENT, onMainWorldEvent);
}
