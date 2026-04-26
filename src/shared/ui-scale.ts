// Match the rendered size of fixed-px UI surfaces (popup, options) across
// machines with different display scaling. Call once before first render.
//
// Reference 1440px = 13" MacBook at Default Retina → scale 1.0.
// Capped at 1.4 so 4K external displays don't go absurd.

export function applyUiScale(): void {
  const screenWidth = window.screen.width;
  const scale = Math.min(Math.max(screenWidth / 1440, 1), 1.4);
  // `zoom` is non-standard but supported in Chromium and Firefox 126+.
  // It scales layout, fonts, and dimensions uniformly — unlike `transform`,
  // which keeps the original layout box and breaks click targets.
  (document.documentElement.style as CSSStyleDeclaration & { zoom?: string }).zoom =
    String(scale);
  // eslint-disable-next-line no-console
  console.debug(
    `[BOB] ui-scale: screen.width=${screenWidth} dpr=${window.devicePixelRatio} → zoom=${scale.toFixed(3)}`,
  );
}
