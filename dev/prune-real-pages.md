# prunePage real-page captures

Notes for capturing `prunePage()` output on real sites and sanity-checking
the result. Owned by the dom-prune work. Update as samples are taken.

## How to capture

`prunePage` lives in `src/content/dom-prune.ts` and only depends on
`document` + `performance.now()`. To run it inside any tab's DevTools
console:

```sh
# from repo root
npx esbuild src/content/dom-prune.ts \
  --bundle --format=iife --global-name=BOBPrune \
  --target=chrome120 \
  > /tmp/dom-prune.bundle.js
pbcopy < /tmp/dom-prune.bundle.js   # macOS; xclip on Linux
```

Then in a browser tab on the target site, open DevTools → Console and:

1. Paste the bundle (it exposes the IIFE result as `BOBPrune`).
2. Run:
   ```js
   console.time('prune');
   const out = BOBPrune.prunePage();
   console.timeEnd('prune');
   console.log('bytes:', new Blob([out]).size);
   console.log(out);
   ```
3. Re-run with shadow-heavy components in view (open a menu, hover a
   tooltip) to confirm no-throw on weird custom elements.

## What to look for in each capture

- **Size:** must be `<= 4000` chars (Blob byte size will be slightly
  larger only if there are non-ASCII chars).
- **Time:** typically `<10ms` for a small viewport, must stay
  `<50ms` even on heavy pages.
- **Key interactive elements present:** the user-visible primary
  controls (post buttons, search box, primary nav, video controls,
  add-to-cart, etc.) should appear in the output by `id`,
  `data-testid`, `role`, or `aria-label`.
- **No crash:** function always returns a string, never throws.

If size hits 4000 with `... (truncated)` at the end, that's expected
on dense pages — just confirm key controls appear *before* the cut.

## Per-site samples

> Fill these in by running the recipe above. Keep snippets short
> (first ~20 lines is usually enough to confirm the output is sane).

### x.com / twitter.com (logged-out home)

- URL: `https://x.com/`
- Output bytes: __ chars
- Time: __ ms
- Expected key elements: `<a href="/login">`, `<a href="/signup">`,
  the timeline article cards (`<article data-testid="...">`), search box.
- First ~20 lines:

```
TODO: paste capture here
```

Notes:

### youtube.com (homepage)

- URL: `https://www.youtube.com/`
- Output bytes: __ chars
- Time: __ ms
- Expected key elements: `#search` input, sidebar nav links, video
  card thumbnails (likely `ytd-rich-item-renderer` custom elements
  — confirm they don't crash the walker).
- First ~20 lines:

```
TODO: paste capture here
```

Notes:

### amazon.com (any product page)

- URL: a product detail page
- Output bytes: __ chars
- Time: __ ms
- Expected key elements: `#add-to-cart-button`, `#buy-now-button`,
  `#productTitle`, search input, the price block.
- First ~20 lines:

```
TODO: paste capture here
```

Notes:

### reddit.com (subreddit page)

- URL: e.g. `https://www.reddit.com/r/programming/`
- Output bytes: __ chars
- Time: __ ms
- Expected key elements: post links, upvote/downvote buttons (often
  custom elements), the `<faceplate-search-input>` style elements.
- First ~20 lines:

```
TODO: paste capture here
```

Notes:

### github.com (any PR page)

- URL: e.g. `https://github.com/anthropics/claude-code/pull/1`
- Output bytes: __ chars
- Time: __ ms
- Expected key elements: `Files changed` tab, `Conversation` tab,
  Merge button, `<a>` to commits, the diff containers
  (`data-testid` or class fallback).
- First ~20 lines:

```
TODO: paste capture here
```

Notes:

## Integration note (for the merger)

`src/content/index.ts` (Person A's file) should call `prunePage()`
right before sending `GENERATE_FEATURE`:

```ts
import { prunePage } from './dom-prune';
// ...inside onGenerate:
const domSnapshot = prunePage();
return await send({
  type: 'GENERATE_FEATURE',
  req: { prompt, url: location.href, domSnapshot },
});
```

The shape of `req.domSnapshot` is already `string | undefined` per
`src/shared/types.ts::GenerateRequest`, so no type-side changes are
needed.

## Local pre-flight checks (run before each capture session)

- `npx tsc --noEmit` — clean
- `npm run dev` then open `http://localhost:5173/dev/prune-test.html`
  — the synthetic sandbox should auto-run and render the pruned
  output in the green `<pre>` panel; a click on each button should
  re-run with different `maxChars` budgets.
