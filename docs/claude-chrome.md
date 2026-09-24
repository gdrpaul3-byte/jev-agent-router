# JEV decisions in Claude Code + Claude in Chrome

This bridge keeps the TypeSafe direct API. Claude Code reads and operates the existing Claude in Chrome session using its own official tools; the local Node helper only proposes and validates the next host-approved action. It does not connect to Chrome's private native messaging protocol, attach a personal profile through CDP, or bypass extension permissions.

**Status (2026-09-24 UTC): live-tested.** Claude Code acted as the host with the Claude in Chrome extension (1.0.94) on Windows and completed two local fixtures end to end: a two-click demo and a four-step Korean notice search with text input, category filter and article selection. With the final, reviewed build both completed on the first attempt; the earlier development attempts that stopped are listed too, in [the live results](../benchmarks/results/claude-chrome-live-20260924/RESULTS.md). Install the Claude skill with `node -- scripts/install-skill.mjs --agent claude --skill claude-chrome`.

The loop is host-assisted: every action needs several Claude tool calls, so one action took about 30–60 s in the live runs. No speed advantage is claimed.

**Real-site A/B (2026-09-25): not recommended over Claude alone.** On three pre-registered public-site tasks (a GitHub repository and two Korean university pages), Opus 5.5 alone completed 6 of 6 attempts (mean 80 s, $0.44 at API list price) and Opus 5.5 + this bridge completed 0 of 7 (mean 277 s, $1.28). The stops came from text-heavy pages, hover menus, the confidence gate and a minimized Chrome window; see [Real-site limitations](#real-site-limitations-2026-09-25) and [the A/B results](../benchmarks/results/claude-ab-20260925/RESULTS.md). JEV's own cost was $0.0026 for 12 requests; Claude still reads every page, so in this setup JEV adds host cost instead of saving it.

## What the live test changed

The first live run used the earlier contract (a host-written JSON envelope and a stateless CLI). It showed that Claude could not reliably satisfy that contract from the real tool output, so the bridge now includes:

| Live observation | Change |
| --- | --- |
| The host had to hand-convert `read_page` output into JSON, including `visible`, `disabled` and `value`, which the tool does not print. | `observe` / `--raw`: a strict parser for the observed `read_page`, `tabs_context_mcp` and `get_page_text` text. Unknown line shapes stop instead of being guessed. |
| `read_page` never shows the value of a labelled field, even after `form_input`, so text input could never be verified. | Verification accepts the official `form_input` report (`Set search value to "…" (previous: "…")`) when the fresh observation shows the same field unchanged, and a field whose name changed to exactly the text (nameless fields are named by their value). An observed value always wins. The evidence used is reported as `inputEvidence`. |
| A `ref` click reported "Clicked on element" but reached the page 0/6 times when no screenshot had been taken since the last navigation; 4/4 after a 0.1-scale screenshot. The old verify step correctly stopped with `NO_OBSERVABLE_PROGRESS`. | The observation recipe takes a small screenshot before each click authorization. |
| One batch right after a navigating click read the old page with `tabs_context`/`read_page` and the new page with `get_page_text`. | The parser rejects a batch whose `get_page_text` header URL/title differs from the tab metadata (`OBSERVATION_INCONSISTENT`). |
| The host had to carry history, the total call budget and one workflow deadline across separate CLI processes. | A private session ledger enforces them across processes. |
| A 30 s screenshot timeout pushed verification past a 60 s window measured from the decision. | Verification is bounded by 60 s from the authorization instead; the proposal must still be authorized within 60 s. |
| JEV stopped at the 0.75 confidence gate after a typing step (0.55) because it could not see the field value. | The ledger shows a value it verified from the tool report again, for the same field, URL and page text, until a click is verified (0.91–0.94 afterwards). |
| `needs_host` from the model dropped the reason detail. | Sanitized `detail` and `diagnostics` (`head`, `choice`, `confidence`, `margin`) are returned, with target choices mapped back to observed refs. |

A four-round multi-agent review then checked the new code against the source of the installed extension (Claude in Chrome 1.0.94: `assets/accessibility-tree.js` for `read_page`, `assets/mcpPermissions-*.js` for `form_input` and batching), reproduced each reported defect with scripts, and re-verified every fix. The final live runs used the reviewed code. The most important changes:

| Review finding | Change |
| --- | --- |
| `read_page` prints `role`, `href`, `type` and `placeholder` unescaped, so a page-controlled newline can forge a well-formed element line that borrows another element's ref. | Authorize (and verify after `form_input`) requires `read_page` with `ref_id` for the target; its first line must match the target exactly (`TARGET_BINDING_MISMATCH` otherwise). |
| The parser assumed JSON escaping; the serializer escapes only `"` in names, prints select options as `option "…" (selected) value="…"`, and allows multi-token ARIA roles. | The grammar follows the serializer; anything else still stops. |
| Raw observations were stamped with the CLI clock, so a reused directory looked fresh and an old `tool-result.txt` could certify an input that never ran. | The CLI uses the files' write time; a report written before the authorization is ignored. |
| Value-named fields could show an OTP or a card number, and the parser and bridge disagreed on protected fields. | One shared predicate, including Korean credential words, 6–8 digit and card-like values, and all editable fields on a page with a show/hide password control; such fields are omitted and counted. A revealed password, CVV or short code without these signals still cannot be recognized from the tool text. |
| The session lock was released before the final save, so two processes could authorize the same proposal. | The lock is held until every write settles, is created together with its owner record, and can be released only for a process that no longer exists (`unlock`). |
| Rotating content (counters, carousels, cache-busting links) could make a dropped click look like progress. | Elements that changed on their own between the decide and authorize reads, and identical re-mounted copies of them, are left out of the click progress comparison. An element re-created with new content on every read can still look like progress. |
| A remembered input value was indistinguishable from an observed one. | It is sent as `valueSource: "tool_report"` and never used as page evidence. |

Goal wording also mattered: an abstract goal kept the operation confidence at 0.39–0.70 after the first step (some calls chose BLOCKED), while naming the visible buttons and the completion text gave 0.83–0.84 (4/4). This is host plan guidance, not a code change.

## Setup

Run `claude --chrome` and use `/chrome` to check the extension connection and choose the intended browser. A Claude account signed in with `/login` and the Claude in Chrome extension are required. Keep the browser's existing site permissions. Do not enable permission bypass mode for this bridge.

Anthropic's official [Chrome integration documentation](https://code.claude.com/docs/en/chrome) describes setup and `/chrome`; `/mcp` → `claude-in-chrome` → View tools shows the schemas in the current session. Tools used:

| Official tool | Used input | Purpose |
| --- | --- | --- |
| `tabs_context_mcp` | `{}` | Native tab ID, URL and title. |
| `read_page` | `tabId`, `filter: "interactive"` | Current element refs. In the live probe, `interactive` excluded `display:none`, `visibility:hidden`, `aria-hidden`, `opacity:0`, off-screen and below-the-fold elements; `all` included them. |
| `get_page_text` | `tabId` | Page text for completion checks. It favours `<main>`/`<article>`. |
| `computer` | `action: "screenshot"`, `scale: 0.1` | Needed before a `ref` click after navigation (see above). |
| `computer` | `action: "left_click"`, `ref`, `tabId` | Click a current observed reference. |
| `form_input` | `ref`, `value`, `tabId` | Set the complete host-provided field value. |

Tool names may have an MCP prefix in Claude Code. Use the tool exposed in that session.

## Raw observations

Take one `browser_batch` per observation in this order: `computer wait 1 s` (only after a click), `computer screenshot scale 0.1` (only before a click authorization), `tabs_context_mcp`, `read_page` with `filter: "interactive"`, `get_page_text`, and `read_page` with `ref_id` set to the proposal's target ref (for authorize, and for verify after `form_input`). Then copy each tool's own output, verbatim, into a **new directory for every command**:

| File | Content |
| --- | --- |
| `tabs-context.txt` | the JSON line from `tabs_context_mcp` |
| `read-page.txt` | the `read_page` output through its `Viewport: WxH` line |
| `page-text.txt` | the `get_page_text` output from `Title:` to the end of the page text; the batch's `Tab Context:` footer must not be copied (`PAGE_TEXT_INVALID`) |
| `ref-check.txt` | authorize, and verify after `form_input`: the `read_page` output for `ref_id` = target ref |
| `tool-result.txt` | verify after `form_input`: its one-line result, written after the action. The extension reports the value read back after its events: `Set <kind> value to "…" (previous: "…")`, `Set <type> to "…" (previous: …)` (date and time inputs) or `Set number input to … (previous: …)`. Its select report (`Selected option "…" in dropdown …`) only echoes the request and is not evidence; a select is verified from its new name. Protected fields print `[redacted]` and never verify |

A leading `[tool_name]` batch label may be kept. The observation time is the oldest write time of the first three files and `ref-check.txt` when present, so authorize and verify need a new directory (a reused one fails with `FRESH_OBSERVATION_REQUIRED`), decide may reuse the verify directory while it is under 60 s old, and a `tool-result.txt` written before the authorization is ignored. One file per tool keeps page-controlled text (page body, a field's previous value in the `form_input` report) from forging another tool's section, and avoids JSON escaping or shell heredocs. Use the Write tool; never pass page text through shell arguments.

Parsed facts (from the Claude in Chrome 1.0.94 serializer and the live runs; not a published contract):

- An element line is `<indent><role>[ "<name>"] [ref_N][ href="…"][ type="…"][ placeholder="…"]`. Every element has a ref. Names have whitespace collapsed, are cut at 100 characters and escape only `"`. Role and attribute values are printed raw. Select options are printed as `option ["name"][ (selected)][ value="…"]` without a ref; they are skipped. `(empty page)` and an empty listing are valid. Exactly one `Viewport:` line is required. Anything else — truncation notes, an `href` containing a quote, a name that could end at two places — stops with `READ_PAGE_UNPARSED`.
- Because raw attribute values can contain newlines, a page can forge a well-formed line. The listing is therefore only used for decisions; the ref check binds the target before any action.
- Attributes become the element `description` (`type=search; placeholder=…`, `href=/articles/…`), so link destinations are part of target identity. Values are clipped at 300 characters.
- `textbox`/`searchbox` elements are `editable`. `read_page` does not print `disabled`, checkbox state or field values. A field without aria-label, placeholder, title or `<label for=…>` — including one wrapped inside a `<label>` — is named by its value (under 50 characters). A select is named by its selected option text.
- Protected fields are omitted before anything reaches JEV and counted in `omitted.protected`: `type` password or hidden, `[value redacted]`, credential words in the name or attributes (English and Korean), text and combobox fields whose name or observed value shows 6–8 digits (optionally space-grouped) or a Luhn-valid card number, and every editable field when an element or the page text offers a show/hide password control. Dates and postal codes with dashes are not treated as codes. Do not run this bridge on login or payment pages: a revealed password or a short code in a field named by its value cannot be recognized.
- `get_page_text`'s `Title:`/`URL:` header must match the tab metadata (an empty document title is not compared); the body after `---` is the page text. Its `No text content found…` error stops with `PAGE_TEXT_UNAVAILABLE`.

`node -- ./src/claude-chrome-cli.mjs observe --raw <dir> --tab-id <N>` prints the normalized envelope without any API call. The documented JSON envelope (`source: "claude-in-chrome"`, `observedAtEpochMs`, `tab`, `text`, `elements` with `visible: true`) is still accepted through `--input` for hosts that normalize themselves.

## Session workflow

```powershell
node -- ./src/claude-chrome-cli.mjs start --session <private-dir> --input ./plan.json
node --use-system-ca -- ./src/claude-chrome-cli.mjs decide --session <private-dir> --raw ./obs-01 --tab-id <N> --env-file ./.env
node -- ./src/claude-chrome-cli.mjs authorize --session <private-dir> --raw ./obs-02 --tab-id <N>
# invoke toolCall.tool once with exactly toolCall.arguments
node -- ./src/claude-chrome-cli.mjs verify --session <private-dir> --raw ./obs-03 --tab-id <N>
node -- ./src/claude-chrome-cli.mjs status --session <private-dir>
```

`plan.json` is `{ "plan": …, "maxCalls"?: N, "api"?: {…} }`. The plan uses the goal schema with explicit `allowedOrigins`, `click`/`typeText` actions, exact host input text, completion text/URL, `maxSteps` and `maxDurationMs`. `start` creates a new directory exclusively; an existing directory is never reused. `maxCalls` defaults to `min(50, maxSteps + 3)`.

1. **decide** makes at most one TypeSafe request. The ledger counts and saves each actual POST before it is sent, so an interrupted process still used its budget, and its cost is reported as unknown (`null`) until usage is recorded. `proposed` stores the proposal.
2. **authorize** needs a new observation, taken after the decision and within 60 s of it, plus the ref check. `authorized` returns one `toolCall` and stores it as the pending action; the proposal is consumed. After a `done` proposal, `completed` is returned only when a fresh observation satisfies all completion predicates.
3. Claude invokes that tool once through Claude in Chrome with exactly those arguments.
4. **verify** needs a new observation within 60 s of the authorization. For input, the observed value, a nameless field renamed to exactly the text, or the exact `form_input` report written after the authorization (with the field unchanged, or renamed from the reported previous value to the new value) is required, together with the ref check; partial input stops with `INPUT_NOT_VERIFIED`. For a click, progress requires a changed native URL, a changed title (ignoring a leading unread counter and a title that was already changing before the click), changed candidate content/state (ignoring elements that already changed between the decide and authorize reads), or completion becoming newly true; ref renumbering and page-text-only changes do not count. Content that starts changing only after the authorize read can still look like progress, so this is a heuristic, not proof; the screenshot rule remains the main protection against dropped clicks. `observed_after_action` appends the step to the ledger history.
5. Decide again, with the verify directory while it is under 60 s old.

After a verified `form_input` whose evidence was the tool report, the ledger shows that value to JEV again, marked `valueSource: "tool_report"`, for the same field, URL and page text until a click is verified, because `read_page` hides it. It is never used as page evidence. A page that silently clears the field without changing its listing or page text would still show the remembered value.

Stop semantics:

- Observation-input errors (`READ_PAGE_UNPARSED`, `READ_PAGE_DUPLICATE_REF`, `OBSERVATION_INCONSISTENT`, `TAB_NOT_FOUND`, `TAB_CONTEXT_INVALID`, `PAGE_TEXT_INVALID`, `INVALID_OBSERVATION`, `FRESH_OBSERVATION_REQUIRED`, `TOO_MANY_CANDIDATES`, `REF_CHECK_REQUIRED`) and problems before any request (`MISSING_API_KEY`, `INVALID_CONFIGURATION`, `JEV_CONFIG_READ_ERROR`, `JEV_CONFIG_INVALID`, `INPUT_TOO_LARGE`, `TOO_MANY_OPTIONS`, `INVALID_INPUT`) change nothing. Fix the input and rerun the same command; for `INPUT_TOO_LARGE`, a new session with a larger `api.maxInputBytes` is needed.
- `SESSION_IO_ERROR` means the ledger could not be read or written during a command; the lock is still released. Check `status`; a request that was already counted keeps an unknown cost.
- `PROPOSAL_EXPIRED` discards the proposal but keeps the session; observe and decide again.
- `PAGE_TEXT_UNAVAILABLE` leaves the session unchanged, but the page cannot be observed by this bridge.
- Any other `needs_host` ends the session (`status: "needs_host"` with its `reason`); later commands return `SESSION_STOPPED`. After a failed verify, the pending authorization is kept with `outcome: "unverified"` because the action may already have happened. Nothing is replayed automatically.
- `LEDGER_WRITE_FAILED` means the ledger could not record a request before sending it; nothing was sent and nothing changed.
- `ACTION_UNVERIFIED` (decide or authorize while an action awaits verification), `NO_PENDING_PROPOSAL`, `NO_PENDING_ACTION`, `CALL_BUDGET_EXHAUSTED`, `TIMEOUT` and `SESSION_BUSY` enforce the ledger. The lock is created together with its owner record (`{pid, command, sinceEpochMs}`, shown by `status` as `locked`). It is never removed automatically; `unlock --session DIR --pid N` removes it only when it names that pid, the process no longer exists, and the lock is still the one inspected. `--pid 0` removes an ownerless lock (from an older release) only when it is more than 10 minutes old.
- A retry is a new session that the host reports as a separate attempt.

The ledger holds the plan, history, proposals and authorizations. Keep it private and outside version control, like task files and `.env`. The digest and ledger detect accidental edits and cross-process mistakes; the local host and files remain trusted.

## Example host plan

Adapt labels only from current observed elements. This example is illustrative, not a preset for an uninspected site:

```json
{
  "plan": {
    "goal": "Type \"guide\" into the Search box, click Search, then open the Guide link until the page shows Guide contents.",
    "allowedOrigins": ["https://example.com"],
    "maxSteps": 4,
    "maxDurationMs": 480000,
    "actions": [
      { "id": "query", "action": "typeText", "description": "Type the query into the empty Search box", "text": "guide", "target": { "roles": ["textbox"], "nameEquals": "Search" } },
      { "id": "search", "action": "click", "description": "Click Search after the complete query is in the box", "target": { "roles": ["button"], "nameEquals": "Search" } },
      { "id": "open", "action": "click", "description": "Open the Guide result", "target": { "roles": ["link"], "nameEquals": "Guide" } }
    ],
    "completion": { "textIncludes": "Guide contents", "urlIncludes": "/guide" }
  }
}
```

`api` may contain only `timeoutMs` (1–60000), `maxInputBytes` (1–1000000), `minConfidence` (0.75–1), and `minMargin` (0.10–1). Defaults are 5000 ms, 100000 bytes, 0.75 and 0.10. Endpoints, keys, arbitrary code and tool names cannot be supplied by the model or input plan.

## Stateless commands

`decide`, `authorize` and `verify` without `--session` keep the earlier contract: the input JSON carries `plan`, `observation` (or `raw`), `history`, `proposal` or `authorization`, and `toolResult` for verify. With `raw`, include `raw.refCheck` for authorize and typeText verify, and `raw.observedAtEpochMs` (capture time) — without it the call time is used and the host attests freshness itself. A new CLI process then has a one-request budget, and the host must enforce the total budget, one deadline and the single-pending-action rule itself. Prefer the session commands.

## Known Claude in Chrome issues (2026-09-24, Windows)

- Screenshots occasionally timed out after 30 s; afterwards the tab's viewport stayed shrunk (157×77, then 16×8), so `read_page` listed nothing. A new tab (`tabs_create_mcp`) restored 1920×889.
- On 2026-09-25 the timeouts followed the Chrome window being minimized or the group's tab not being the active tab; the collapsed viewport equalled the scaled screenshot size (157×73 at scale 0.1, 314×155 at 0.2). Keep the window visible and the Claude tab active while a session runs.
- `tabs_create_mcp` can create a tab outside the MCP tab group; closing the group's last tab then removes the group, and later calls report that no group exists. Use `tabs_context_mcp {createIfEmpty:true}` instead.
- `get_page_text` takes the largest element of the first matching selector (`article`, `main`, `.content`, …) and does not fall back to `body`; a page with an empty matching container returns "No text content found" although text is visible.
- `read_page` does not show `disabled`; clicking a disabled control usually ends with `NO_OBSERVABLE_PROGRESS`, but a page whose content keeps changing can make it look like progress.
- The built-in browser pane of the Claude desktop app prints the same `read_page` grammar but uses string tab IDs and origin-only tab metadata; it is not supported by this bridge.

## Known limitations

These were reproduced during the review and are accepted, documented residual risks rather than fixed behaviour:

- **Secrets without a recognizable shape.** A password revealed as plain text, a CVV, a split or alphanumeric one-time code in a field that the page names by its value cannot be recognized from `read_page` text. Do not run this bridge on login or payment pages.
- **Identity, not visibility.** The ref check proves that a target ref belongs to an element with the same role, name and attributes. A page that forges a listing line pointing at a hidden element with the same identity can still make a ref click land elsewhere on the same page. Allowed origins bound where that can lead.
- **Click progress is a heuristic.** Content or titles that start changing only after the authorize read can make a dropped click look like progress; the screenshot rule is the main protection. Conversely, a click whose only effect is on elements that were already changing ends with `NO_OBSERVABLE_PROGRESS`.
- **Remembered input values.** A page that silently clears a field without changing its listing or page text keeps the remembered `tool_report` value visible to JEV.
- **Envelope input.** `--input` envelopes (including `observe` output fed back) skip the ref binding check; use `--raw`.
- **Unobservable pages.** A page whose main text is under 10 characters (`PAGE_TEXT_UNAVAILABLE`), and a value-named field whose value ends in a backslash or repeats the `" [ref_` boundary (`READ_PAGE_UNPARSED`), cannot be used.
- **Serializer drift.** The grammar and report formats come from extension 1.0.94. A different extension version may print something else; the bridge then stops instead of guessing.

## Real-site limitations (2026-09-25)

Found in the [real-site A/B](../benchmarks/results/claude-ab-20260925/RESULTS.md); none is fixed yet:

- **Transcription time.** Claude writes each observation by re-typing the tool output. On a GitHub repository page (about 21 k characters) that took 72–76 s per observation, longer than the 60 s decide→authorize and authorize→verify windows, and it is billed as host output tokens. Small pages took 12–15 s.
- **Hover and mega menus.** A menu opened by an authorized click can close before the next observation (about 30 s later), so the proposed link is gone and the proposal expires.
- **Confidence gate.** JEV picked the correct next action at 0.73 on a real Korean menu, below the 0.75 gate, identically in two attempts.
- **Viewport-only targets.** The `interactive` filter lists visible elements only and the bridge has no scroll action, so footer links and long lists are out of reach.

## Usage and verification

Each decide output includes `usage`, sanitized per-request `requests`, and `cost`; session results also include cumulative `session.usage`. At the verified published TypeSafe price, input costs $0.042 per million tokens and output is free. [TypeSafe model pricing](https://docs.typesafe.ai/models)

`cost.estimatedJevUsd` is a list-price estimate from actual provider usage, not cash withdrawn or a remaining balance. If any attempted call has no usage response, it is `null`; `knownUsageUsd` shows the known subtotal separately. Credits, taxes and Claude's own inference costs are not included, and `hostCostUsd`/`cashChargeUsd` remain `null`. `observe`, `start`, `status`, `authorize` and `verify` make no API requests.

Offline verification:

```powershell
node --test ./test/claude-chrome.test.mjs ./test/claude-chrome-cli.test.mjs ./test/claude-observation.test.mjs ./test/claude-chrome-evidence.test.mjs ./test/claude-chrome-session.test.mjs
```

The tests use live-captured tool text, simulated host observations and injected API responses. The live results are recorded separately and do not establish general reliability.
