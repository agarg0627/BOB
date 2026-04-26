# BOB — Pitch Deck Source Material

A research dossier on the codebase, written so we can pull whatever we need
into slides without going back to the source. Numbers are grounded in the
code (see file:line refs).

---

## 1. The one-liner

**BOB is a self-customizing browser extension. Press ⌘K on any webpage,
describe what you want in plain English, and an AI agent inspects the live
DOM and writes a JavaScript content script that ships immediately.**

Think Greasemonkey / Tampermonkey, but the user never writes code — and the
extension keeps watching how they browse and proposes new customizations on
its own.

---

## 2. Why this matters (pitch hook)

- The web is one-size-fits-all. Every user wants something different — fewer
  ads, bigger fonts, hidden Shorts, custom buttons, dimmer sidebars.
- Extensions today are pre-built by developers for the median user. If your
  tweak isn't in the store, you write code.
- LLMs can write that code. BOB closes the loop: prompt → live DOM
  inspection → working extension, in one ⌘K press.
- Result: every webpage becomes programmable by the person actually using
  it, not by the company that ships it.

---

## 3. Product surface — what we shipped

### 3.1 Core flow (the demo)
1. User presses **⌘K** on any page → shadow-DOM overlay opens
   ([overlay.ts:791-807](src/content/overlay/overlay.ts#L791-L807))
2. Types a request ("hide the sidebar")
3. Content script captures a pruned DOM snapshot (≤ 4000 chars, 50ms budget)
   ([dom-prune.ts:54-56](src/content/dom-prune.ts#L54-L56))
4. Background worker runs an agent loop against the chosen LLM with two
   tools — `query_dom` and `test_code`
   ([agent.ts:118-158](src/background/agent.ts#L118-L158))
5. Agent returns a JSON object: `{ code, name, description, urlPattern }`
6. Preview shown; user reviews and clicks **Install**
7. Code injected via `chrome.scripting.executeScript` in `world: 'MAIN'`
   with a Trusted Types policy
   ([index.ts:67-108](src/background/index.ts#L67-L108))
8. On future visits to matching URLs the feature auto-runs

### 3.2 Feature checklist (what's actually built)

**Generation & agent loop**
- Multi-turn agent with tool use (`query_dom`, `test_code`)
  ([tools.ts:4-29](src/background/tools.ts#L4-L29))
- **Standard mode**: 6-iteration cap
- **High-effort mode**: 12 iterations + provider-side extended thinking
  ([agent.ts:90-107](src/background/agent.ts#L90-L107))
- **Reflexion retry**: on runtime error, agent gets the error back and
  retries up to 2× with current DOM
  ([content/index.ts:101-160](src/content/index.ts#L101-L160))
- **Conversational refinement**: after install, the overlay flips into a
  refine mode — the user can iterate ("smaller", "apply more broadly") and
  the agent sees prior turns + existing code
  ([overlay.ts:266-322](src/content/overlay/overlay.ts#L266-L322))
- **Edit existing feature**: ⌘K → Edit re-opens the prompt with prior code
  as context, parent/iteration tree is tracked
  ([overlay.ts:853-874](src/content/overlay/overlay.ts#L853-L874))

**Three providers, one interface**
- Anthropic (default model `claude-sonnet-4-6`)
- OpenAI (default `gpt-5.5`)
- Google (default `gemini-3.1-pro-preview`, also supports Gemma 4 family)
- All three normalize to a single `Provider` interface; switching is one
  radio click in Options
  ([providers/](src/background/providers/))

**Auto-suggestions (the "self-customizing" half)**
- Behavior tracker watches the page for close/dismiss clicks + time-on-site
  ([behavior-tracker.ts](src/content/behavior-tracker.ts))
- Suggestion engine groups by signature; after **3+** same-pattern dismissals
  on a hostname, proposes a feature like *"Automatically click any element
  with text 'Sign up' so I don't have to dismiss it manually"*
  ([suggestions-engine.ts:143-234](src/background/suggestions-engine.ts#L143-L234))
- **Three-state dismissal**: Try / Later (3-day cooldown) / Never
- **Privacy guardrails**: never reads input/textarea/password text; skips
  hostnames matching `bank|auth|login`
  ([behavior-tracker.ts:11-21](src/content/behavior-tracker.ts#L11-L21))

**UX polish**
- ⌘K toggle, shadow-DOM overlay (immune to host page CSS)
- Suggestion chips ("Hide distracting elements", "Make text bigger", …)
- **Voice input** via Web Speech API
  ([voice-input.ts](src/content/voice-input.ts))
- **High-effort toggle** in the overlay header (sessionStorage persisted)
- Preview view with editable name + URL pattern + read-only diff
- "BOB · N active" badge bottom-right when features run on the page
  ([page-badge.ts](src/content/page-badge.ts))
- Popup: per-feature toggle, edit, delete, error expander, run/error counts,
  bulk on/off/delete, "this site" vs "all features" sections
  ([popup.ts](src/popup/popup.ts))
- **Import / export** all features as JSON (single or bulk, merge or
  replace)
  ([import-export.ts](src/popup/import-export.ts))
- Demo seed: 5 ready-made features (YouTube Shorts hider, HN star titles,
  Wikipedia dim sidebar, Reddit ad hider, example.com tint) loadable from
  Options for clean demos
  ([options.ts:179-265](src/options/options.ts#L179-L265))

**Resilience plumbing the user never sees**
- SPA awareness: patches `history.pushState`/`replaceState` in MAIN world
  so features re-run on YouTube/Twitter/Gmail-style navigations
  ([spa.ts](src/content/spa.ts))
- `window.__bobObserve` helper installs a debounced MutationObserver per
  feature slug — generated code stays simple and idempotent
  ([index.ts:202-247](src/background/index.ts#L202-L247))
- Per-key storage locks — no clobbered writes from concurrent tabs
  ([storage.ts:10-20](src/shared/storage.ts#L10-L20))
- Trusted Types policy created on the fly so injection works on YouTube,
  Google, GitHub, etc.
  ([index.ts:81-95](src/background/index.ts#L81-L95))
- DOM pruner: 50 ms time budget, sibling collapse, autogen-class filter,
  stable selector preference (id > data-testid > aria-label > stable class)
  ([dom-prune.ts](src/content/dom-prune.ts))

### 3.3 Tech stack
- TypeScript + Vite + `@crxjs/vite-plugin` for MV3 build
- Chrome Manifest V3, service-worker background, content script on
  `<all_urls>` ([manifest.json](manifest.json))
- ~6,000 lines of TS, ~8,000 lines total incl. CSS/HTML
- No backend, no database, no cloud sync — features live in
  `chrome.storage.local`

---

## 4. Costs (what running BOB actually costs)

### 4.1 Operator cost: $0
BOB is **bring-your-own-key**. The user pastes an API key in Options
([options.ts:14-19](src/options/options.ts#L14-L19)) and chooses a provider;
all LLM calls go directly from the service worker to the provider over
HTTPS ([anthropic.ts:101-110](src/background/providers/anthropic.ts#L101-L110)).
We never proxy, never see prompts, never see keys.

This means:
- No infra cost to host — Chrome runs the extension
- No moderation / abuse cost — provider handles it
- No per-user marginal cost as we scale

The flip side is one onboarding step (paste a key). Pitch this as a feature
("your data never touches our servers") and it stops being a friction.

### 4.2 User cost per ⌘K (rough estimate)

Each generation = one agent loop. Tokens per turn:

| Component                         | ~tokens (input) |
|-----------------------------------|-----------------|
| System prompt                     | ~1,200          |
| Pruned DOM snapshot (cap 4000 ch) | ~1,000          |
| User prompt + URL                 | ~50–200         |
| Tool result (per call)            | ~300–500        |

Typical run: 1–4 iterations, 1–2 tool calls. So **~3K–8K input tokens** and
**~500–1.5K output tokens** per ⌘K.

At provider list prices (early 2026 ballpark — confirm before pitching
specific numbers):

| Provider                | Standard ⌘K | High-effort ⌘K |
|-------------------------|-------------|----------------|
| Claude Sonnet 4.6       | ~$0.02–0.05 | ~$0.10–0.25    |
| GPT-5.5                 | similar     | similar        |
| Gemini 3.1 Pro          | similar     | similar        |
| Gemma 4 (via Gemini API) | cheaper    | cheaper        |

Multipliers to mention if asked:
- Reflexion can re-call up to 2× on failures (so worst case ~3×)
- High-effort doubles the iteration cap *and* enables provider-side
  reasoning (8000-token thinking budget on Anthropic; matching configs on
  OpenAI / Gemini / Gemma)
  ([anthropic.ts:84-96](src/background/providers/anthropic.ts#L84-L96),
  [openai.ts:84-89](src/background/providers/openai.ts#L84-L89),
  [google.ts:99-108](src/background/providers/google.ts#L99-L108))

### 4.3 Cost-free pieces
- Suggestions engine — pure heuristic on local behavior events, no LLM
- Voice input — Web Speech API (browser-native)
- DOM inspection — `chrome.scripting.executeScript`
- Storage — `chrome.storage.local` (~10 MB browser quota; we never approach
  it, biggest objects are 500-event behavior log, capped)
  ([suggestions-engine.ts:25](src/background/suggestions-engine.ts#L25))
- Feature execution — runs locally in the user's tab forever after install,
  zero API calls on subsequent page visits

### 4.4 If we ever wanted to monetize
- **Pro tier**: BOB-hosted key (we eat the API cost, charge subscription).
  Margin = our negotiated provider rate vs. retail price.
- **Cloud sync**: $X/mo for cross-device feature library + import/export
  history. Would require a backend we don't have today.
- **Marketplace**: users publish features; we take a cut. Distribution
  layer; near-zero marginal cost.
- **Team / org plan**: shared feature libraries, SSO, audit logs.
  Enterprise-style pricing.

---

## 5. Differentiation — why a judge cares

| | BOB | Greasemonkey/Tampermonkey | Arc Boost / "AI browsers" |
|---|---|---|---|
| User writes code | No | Yes | No, but limited to canned actions |
| Per-page custom logic | Yes | Yes | No |
| Live DOM-aware agent | Yes | n/a | No (template-driven) |
| Self-proposes features from behavior | **Yes** | No | No |
| Works on any site | Yes (with CSP caveats) | Yes | Locked to their browser |
| Provider-agnostic / BYOK | Yes (3 providers) | n/a | No (vendor-locked) |
| Built today, not roadmap | ✅ | ✅ | mixed |

The hard, novel piece is **the agent loop with live DOM tools + reflexion +
refinement**. That's what lets a non-coder say "make YouTube comments
collapsed by default" and actually get working code on a site that ships
auto-generated CSS class names every deploy.

---

## 6. Augment the Agent — track-specific framing

The hackathon mandate is "tools that augment existing agents." Reframe
BOB this way for the judges: **we did not ship a model — we shipped the
runtime an agent needs to be reliable on the live web.** Every pillar of
the track maps cleanly to a module in this repo.

### 6.1 Better verification for AI outputs
Naked LLM output is not trustworthy. BOB layers four independent checks:

- **`test_code` tool** ([tools.ts:66-104](src/background/tools.ts#L66-L104))
  — agent can execute candidate JS in the user's tab and read DOM-delta
  + thrown error before committing. Verified against ground truth, not
  the model's confidence.
- **Reflexion retry loop**
  ([content/index.ts:101-160](src/content/index.ts#L101-L160)) — runtime
  errors are fed back with a fresh DOM snapshot for up to 2 retries. Pullzgo s
  this out as a "production Reflexion implementation" line.
- **Idempotency contract**
  ([prompt.ts:33-41](src/background/providers/prompt.ts#L33-L41)) — every
  mutation tagged `data-bob='<slug>'`, every observer keyed by slug, so
  verification stays stable across SPA nav and toggle cycles.
- **Strict output parser**
  ([agent.ts:165-211](src/background/agent.ts#L165-L211)) — three
  fallbacks (raw JSON, fenced, balanced-brace extraction) before storage
  is touched. Rambling models get caught at the gate.

### 6.2 Smarter context retrieval
A 2 MB DOM dump destroys both cost and attention. Our pipeline is a
study case any browser-acting agent can borrow:

- **`prunePage`** ([dom-prune.ts](src/content/dom-prune.ts)) — ≤4 KB
  text snapshot under a 50 ms wall budget. Strips autogen classes
  (`css-AbCdEf`, `jsx-12345`), ranks selectors by stability
  (id > data-testid > aria-label > stable class), collapses long sibling
  runs.
- **`query_dom` tool** ([tools.ts:36-64](src/background/tools.ts#L36-L64))
  — targeted CSS-selector probes when the snapshot isn't enough. Tool
  use beats speculative pattern matching.
- **Refinement-history capping**
  ([overlay.ts:283-294](src/content/overlay/overlay.ts#L283-L294)) —
  past assistant turns carry a one-line summary, not full code; last 6
  turns retained. Bounded prompt growth.
- **Behavior-driven retrieval** — the suggestions engine is, in essence,
  context retrieval done by the agent on the user's own behavior log.
  The right action is offered the moment the user has clearly demanded
  it three times.

### 6.3 Agent integrations & extensions
BOB is, by construction, an **extensible agent runtime**:

- **Three frontier providers, one interface** behind a unified
  `Provider.chat(...)` contract
  ([providers/](src/background/providers/)). Adding xAI / Mistral /
  local Ollama is one file.
- **Effort-mode normalization** is the cleanest part of the abstraction.
  One `effortMode: 'high'` flag maps to Anthropic
  `thinking.budget_tokens=8000`
  ([anthropic.ts:84-96](src/background/providers/anthropic.ts#L84-L96)),
  OpenAI `reasoning_effort: 'high'` on gpt-5 reasoning models
  ([openai.ts:84-89](src/background/providers/openai.ts#L84-L89)),
  Gemini `thinkingBudget` / Gemma `thinkingLevel`
  ([google.ts:99-108](src/background/providers/google.ts#L99-L108)).
- **Pluggable tool registry** ([tools.ts:4-29](src/background/tools.ts#L4-L29))
  — declare schema, append to `dispatchTool`, the agent loop is
  unchanged ([agent.ts:118-158](src/background/agent.ts#L118-L158)).
- **Browser-native distribution** via Manifest V3 + `chrome.scripting`
  with on-the-fly Trusted Types policy creation
  ([index.ts:81-95](src/background/index.ts#L81-L95)). This is what
  makes the integration *actually run* on YouTube, Google, etc.
- **Import / export** ([import-export.ts](src/popup/import-export.ts)) —
  features serialize to JSON, so teams can ship curated feature packs
  or hand off agent-generated tooling.

### 6.4 Human–AI collaboration tooling
BOB treats the user as an equal participant — not a fire-and-forget
target:

- **Preview-before-install gate**
  ([overlay.ts:307-322](src/content/overlay/overlay.ts#L307-L322)) — code
  is never auto-applied. Editable name + URL pattern, syntax-aware code
  view, explicit Install click.
- **Conversational refinement** — overlay flips into refine mode after
  install; agent sees prior turns + existing code so iteration is real
  conversation ([overlay.ts:266-322](src/content/overlay/overlay.ts#L266-L322)).
- **Edit-with-context** ([overlay.ts:853-874](src/content/overlay/overlay.ts#L853-L874))
  — re-opening any installed feature seeds the prompt + prior code +
  iteration tree (`parentFeatureId`, `iterationNumber`).
- **Three-state suggestion dismissal** (Try / Later / Never with 3-day
  cooldown) ([suggestions-engine.ts:283-311](src/background/suggestions-engine.ts#L283-L311))
  — the right primitive for proactive agents.
- **Voice input** ([voice-input.ts](src/content/voice-input.ts)) on the
  prompt textarea via Web Speech API.
- **Surfaced failures** — `runCount`, `errorCount`, `lastError` per
  feature; popup expands the stack trace with copy-to-clipboard
  ([popup.ts:416-440](src/popup/popup.ts#L416-L440)).

### 6.5 Eliminating professional toil
Concrete, measurable removal:

- **Userscript engineering, gone.** A workflow that previously meant
  "open DevTools, write a Tampermonkey script, debug selectors, redeploy
  when the site changes" collapses into one ⌘K prompt — without giving
  up MAIN-world content-script power.
- **No copy-paste between tools** — generation, preview, install, and
  monitoring all in one shadow-DOM overlay.
- **No deploy step** — features ship instantly and survive SPA nav via
  the History API patch
  ([index.ts:155-191](src/background/index.ts#L155-L191) +
  [spa.ts](src/content/spa.ts)).
- **Proactive automation discovery** — the user doesn't need to *notice*
  the toil first. Three repeated dismissals on a hostname surface a
  "want this gone?" suggestion
  ([suggestions-engine.ts:143-234](src/background/suggestions-engine.ts#L143-L234)).
- **Operator cost = $0.** BYOK + on-device storage = no server, no
  scaling, no security perimeter, no per-user marginal cost. The
  difference between a hackathon demo and something a team installs
  Monday morning.

### 6.6 One-line per pillar (slide-ready)

| Pillar | What we ship | Code |
|---|---|---|
| Better verification | `test_code` tool, Reflexion 2× retry, idempotency contract, strict JSON parser | tools.ts, content/index.ts, agent.ts, prompt.ts |
| Smarter context retrieval | `prunePage`, `query_dom`, history-capped refinement, behavior-driven retrieval | dom-prune.ts, tools.ts, overlay.ts, suggestions-engine.ts |
| Agent integrations & extensions | 3-provider unified interface, effort-mode normalization, pluggable tool registry, MV3 + Trusted Types injection | providers/, tools.ts, index.ts |
| Human–AI collaboration | Preview gate, conversational refinement, edit with context, three-state suggestions, voice, surfaced errors | overlay.ts, suggestions-engine.ts, voice-input.ts, popup.ts |
| Eliminating toil | No code, no copy-paste, no deploy, proactive discovery, $0 operator cost | (the whole product) |

### 6.7 The closing line for the track

> We didn't build an agent demo. We built the **runtime an agent needs
> to be useful on the live web** — and we shipped it as a tool a
> non-developer can use in 30 seconds. Every pillar of "Augment the
> Agent" maps to a module in this repo, not a slide.

---

## 7. Things judges will probe — be ready

**"Doesn't generated JS break sites?"**
- Trusted Types policy handles strict-CSP sites (YouTube, Google)
  ([index.ts:81-95](src/background/index.ts#L81-L95))
- System prompt forbids `innerHTML`, `eval`, inline handlers, etc.
  ([prompt.ts:43-47](src/background/providers/prompt.ts#L43-L47))
- Idempotency: every modification is tagged `data-bob='<slug>'` so re-runs
  don't duplicate
- Reflexion catches runtime errors and re-prompts with the error message
- Per-feature toggle + delete; error count surfaced in popup

**"What about privacy?"**
- All keys + features stay on-device (`chrome.storage.local`)
- DOM snapshots go directly to the user's chosen provider — we don't see
  them
- Behavior tracker explicitly skips inputs / contenteditable / passwords /
  bank-auth-login hostnames
  ([behavior-tracker.ts:43-55](src/content/behavior-tracker.ts#L43-L55))

**"What's the failure mode?"**
- Generated code wrapped in try/catch; errors recorded per feature, shown
  in popup with copy-to-clipboard
- Up to 2 reflexion retries with the error fed back to the model
- Worst case: feature does nothing → user clicks delete (single click)

**"Why three providers?"**
- Decoupling proves the product isn't tied to any vendor
- Lets us A/B prompts across models for the demo
- BYOK + multi-provider = users keep using whatever they're already paying
  for

**"What's the moat?"**
- Prompt engineering (the system prompt is ~110 lines of hard-won site
  compatibility — Trusted Types, CSP, autogen class avoidance, image CDN
  allowlists)
- The reactivity layer (`__bobObserve`, SPA patch, idempotency contract) is
  the kind of plumbing that's hard to clone in a weekend
- Suggestions engine is genuinely novel — nobody else proposes extensions
  to you based on what you already do manually

---

## 8. Demo script (60 seconds)

1. Open YouTube. Press ⌘K. Type **"hide shorts shelves"**. Show preview.
   Click Install. Shorts disappear.
2. Press ⌘K again on the same page. Type **"and make subscribe button red"**.
   Show this lands as a refinement, not a replacement.
3. Open Reddit. Click the close (×) on three "open in app" banners.
4. Open the popup. Suggestions section already proposes "Auto-dismiss the
   open-in-app banner" — click **Try it**. Overlay opens pre-filled. Install.
5. Show Options → Provider radio → switch from Anthropic to Gemini, save,
   run another ⌘K. Same UX, different model.
6. Show import/export — drag a `bob-features.json` file in, all five demo
   features appear.

---

## 9. What's *not* shipped (be honest)
- No cloud sync — explicit non-goal for hackathon scope
  ([README.md:97-99](README.md#L97-L99))
- Some sites with hard CSPs reject injected scripts — documented as a known
  limitation
- No analytics / telemetry of any kind — we don't know what users build
- No marketplace / sharing UX yet — import/export is the seed
- Async errors inside generated code aren't always captured in
  `__bobLastError` — the synchronous wrapper catches the common case
  ([index.ts:70-78](src/background/index.ts#L70-L78))

---

## 10. Closing pitch (one paragraph)

> Browser extensions are software written by developers for users they'll
> never meet. BOB inverts that: the extension is written *for you*, *by an
> agent*, the moment you ask. Every page becomes programmable, and the
> agent gets better at proposing features the longer it watches you browse.
> It runs on your own API key, stores nothing in the cloud, and works today
> on Chrome. It is, in practice, a personal-software factory bolted onto
> the address bar.
