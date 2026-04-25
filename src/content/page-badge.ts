const HOST_TAG = 'bob-badge-host';
const AUTO_FADE_MS = 4000;

const badgeCss = `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483646;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.badge {
  position: fixed;
  bottom: 20px;
  right: 20px;
  background: rgba(26, 26, 26, 0.85);
  color: #f5f5f5;
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 20px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  pointer-events: auto;
  opacity: 0;
  transform: translateY(6px);
  transition: opacity 250ms ease, transform 250ms ease;
  cursor: default;
  user-select: none;
  white-space: nowrap;
}
.badge.visible {
  opacity: 1;
  transform: translateY(0);
}
.badge.faded {
  opacity: 0.3;
  transform: translateY(0);
}
.badge.faded:hover {
  opacity: 1;
}
.badge .tooltip {
  display: none;
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  background: rgba(26, 26, 26, 0.95);
  color: #e5e5e5;
  font-size: 11px;
  padding: 8px 10px;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  max-width: 240px;
  white-space: pre-wrap;
  line-height: 1.4;
}
.badge:hover .tooltip {
  display: block;
}
`;

let host: HTMLElement | null = null;
let badgeEl: HTMLDivElement | null = null;
let tooltipEl: HTMLDivElement | null = null;
let fadeTimer: ReturnType<typeof setTimeout> | null = null;

function ensureBadge(): void {
  if (host) return;
  host = document.createElement(HOST_TAG);
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = badgeCss;
  root.appendChild(style);

  badgeEl = document.createElement('div');
  badgeEl.className = 'badge';

  tooltipEl = document.createElement('div');
  tooltipEl.className = 'tooltip';
  badgeEl.appendChild(tooltipEl);

  root.appendChild(badgeEl);
  document.body.appendChild(host);
}

export function showActiveBadge(count: number, names?: string[]): void {
  if (count <= 0) {
    hideActiveBadge();
    return;
  }
  ensureBadge();
  if (!badgeEl || !tooltipEl) return;

  // Set main text (keep tooltip separate)
  const textNode = badgeEl.firstChild;
  if (textNode && textNode.nodeType === Node.TEXT_NODE) {
    textNode.textContent = `BOB \u00b7 ${count} active`;
  } else {
    badgeEl.insertBefore(
      document.createTextNode(`BOB \u00b7 ${count} active`),
      tooltipEl,
    );
  }

  tooltipEl.textContent = names && names.length > 0
    ? names.join('\n')
    : `${count} feature${count === 1 ? '' : 's'} running`;

  badgeEl.classList.remove('faded');
  badgeEl.classList.add('visible');

  if (fadeTimer) clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => {
    badgeEl?.classList.add('faded');
  }, AUTO_FADE_MS);
}

export function hideActiveBadge(): void {
  if (!badgeEl) return;
  badgeEl.classList.remove('visible', 'faded');
}
