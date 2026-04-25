// Exposes window.__bobObserve(slug, callback) in the page's MAIN
// world. LLM-generated features call it to set up reactive behavior
// that survives DOM mutations from infinite scroll, lazy loads, etc.
//
// REFERENCED FROM: providers/prompt.ts — the system prompt tells the
// LLM to call window.__bobObserve(slug, callback) when it wants
// changes to re-trigger its logic. The slug is used to dedupe across
// re-runs of the same feature: a second call with the same slug
// disconnects the previous observer first, so toggling a feature off
// and back on (or re-running on SPA navigation) doesn't stack
// observers.

const INSTALLED_FLAG = '__bobObserveInstalled';

const HELPER_SOURCE = `(function(){
  if (window.__bobObserve) return;
  var observers = new Map();
  function debounce(fn, ms){
    var t = 0;
    return function(){
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }
  window.__bobObserve = function(slug, callback){
    if (typeof slug !== 'string' || typeof callback !== 'function') return;
    var prev = observers.get(slug);
    if (prev) {
      try { prev.disconnect(); } catch (e) {}
    }
    try { callback(); } catch (e) {
      console.error('[bob] observer init for ' + slug + ' threw:', e);
    }
    var target = document.body || document.documentElement;
    var fire = debounce(function(){
      try { callback(); } catch (e) {
        console.error('[bob] observer cb for ' + slug + ' threw:', e);
      }
    }, 100);
    var mo = new MutationObserver(fire);
    mo.observe(target, { childList: true, subtree: true });
    observers.set(slug, mo);
  };
})();`;

function injectIntoMainWorld(source: string): void {
  // @ts-ignore — trustedTypes isn't in the default lib types
  const tt = (window as any).trustedTypes;
  let scriptValue: unknown = source;
  if (tt && tt.createPolicy) {
    const policy =
      tt.defaultPolicy ??
      tt.createPolicy('bob-observe-' + Math.random().toString(36).slice(2), {
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

export function installObserverHelper(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w[INSTALLED_FLAG]) return;
  w[INSTALLED_FLAG] = true;
  try {
    injectIntoMainWorld(HELPER_SOURCE);
  } catch (e) {
    console.error('[bob] observer helper injection failed:', e);
  }
}
