# JEV decisions in Claude Code + Claude in Chrome

This bridge keeps the TypeSafe direct API. Claude Code reads and operates the existing Claude in Chrome session using its own official tools; the local Node helper only proposes and validates the next host-approved action. It does not connect to Chrome's private native messaging protocol, attach a personal profile through CDP, or bypass extension permissions.

The implementation and offline tests are complete. **An actual Claude Code → Chrome execution test is deferred at the user's request (2026-09-19).** The installed CLI was version `2.1.187`; its read-only connection probe returned an expired OAuth token. This is not evidence of a successful browser test. After signing in again, test the small public-page workflow below before using it for other tasks.

## Setup

Run `claude --chrome` from this project and use `/chrome` to check the extension connection and choose the intended browser. A Claude account signed in with `/login` and the Claude in Chrome extension are required. Keep the browser's existing site permissions. Do not enable permission bypass mode for this bridge.

Anthropic's official [Chrome integration documentation](https://code.claude.com/docs/en/chrome) describes setup and `/chrome`; `/mcp` → `claude-in-chrome` → View tools shows the actual schemas in the current session. The following public input descriptors were also verified in the locally installed Claude Code executable on 2026-09-19, without invoking its private transport:

| Official tool | Used input | Purpose |
| --- | --- | --- |
| `tabs_context_mcp` | `createIfEmpty: false` | Read the authentic tab ID and URL; avoid opening a tab just for inventory. |
| `read_page` | `tabId`, optionally `filter`, `depth`, `ref_id`, `max_chars` | Read current element refs. Both `all` and `interactive` can include invisible elements. |
| `find` | `tabId`, `query` | Narrow candidates when the tree is large or ambiguous. |
| `computer` | `action: "left_click"`, `ref`, `tabId` | Click a current observed reference. The tool's public schema explicitly permits `ref` instead of coordinates for clicks. |
| `form_input` | `ref`, `value`, `tabId` | Set the complete host-provided field value. |

Tool names may have an MCP prefix in Claude Code. Use the tool exposed in that session, not a guessed prefix. `read_page` does not have a publicly documented stable raw serialization contract. This bridge therefore does **not** parse an invented tree format. The host normalizes its actual tool result into the local JSON contract below.

## Observation contract

Copy refs, labels, roles and values from the latest actual tool output. Get `tab.id` and `tab.url` from native tab metadata, not page text that happens to look like a URL. Include optional `tab.title` when native metadata provides it. Use fresh native tab metadata before and after the read if navigation might be in progress; discard the read if the URL or tab changed. Set `observedAtEpochMs` to the time the read completed.

Include only observed visible, enabled, non-protected candidates. `visible: true` is required for every included candidate: establish this from the current tool output or screenshot; never assume that an `interactive` filter guarantees visibility. Do not send passwords, authentication codes, payment inputs, or unrelated private content to TypeSafe. If a value or identity is not available, omit the candidate and let Claude use its normal browser tools to resolve it.

This is **our normalized envelope**, not a sample of raw `read_page` output:

```json
{
  "source": "claude-in-chrome",
  "observedAtEpochMs": 1790000000000,
  "tab": { "id": 123, "url": "https://example.com/" },
  "text": "Search the public guides",
  "elements": [
    { "ref": "ref_1", "role": "searchbox", "name": "Search", "value": "", "editable": true, "visible": true },
    { "ref": "ref_2", "role": "button", "name": "Search", "visible": true }
  ]
}
```

Use actual IDs and current timestamps, not these illustrative values. Preserve all relevant completion text in `text`. Up to 200 candidates are accepted. Repeated refs, duplicate indistinguishable candidate identities, unsupported origins, unobserved visibility, stale timestamps and protected fields stop the bridge.

## Three-step host workflow

1. Write `decision-input.json` with `{ "plan": ..., "observation": ..., "history": [] }`. The plan uses the existing goal schema with explicit `allowedOrigins`, exact host inputs, completion text/URL, `maxSteps` and `maxDurationMs`. This bridge supports `click` and `typeText`; `typeText` maps to exact `form_input`, not character-by-character typing. Run:

   ```powershell
   node -- ./src/claude-chrome-cli.mjs decide --input ./decision-input.json --env-file ./.env
   ```

   This makes at most **one** TypeSafe request. Save the returned `proposal` without editing it. `status: "proposed"` is not permission to click. A `needs_host` result stops the attempt.

2. Read the same tab again with current native URL metadata. Write `authorize-input.json` containing the unchanged `plan`, `proposal` and fresh `observation`. Run:

   ```powershell
   node -- ./src/claude-chrome-cli.mjs authorize --input ./authorize-input.json
   ```

   `status: "authorized"` returns one `toolCall`. Immediately invoke that tool **once** through Claude in Chrome, with exactly the returned arguments. It still uses the extension's normal permissions. A stale ref, changed URL/tab, altered host plan, ambiguous identity or an expired proposal stops authorization. Unrelated banner text changes do not invalidate an unchanged target. Proposals and observations expire after 60 seconds. Do not reuse an authorization after any intervening browser action. The digest detects accidental edits, not malicious host forgery; local files and the host remain trusted.

3. After the official browser tool settles, read the page and native URL again. Write `verify-input.json` with `plan`, the whole authorization result as `authorization`, and the fresh `observation`. Run:

   ```powershell
   node -- ./src/claude-chrome-cli.mjs verify --input ./verify-input.json
   ```

   For input, the full observed field value must equal the exact host text. Partial input stops with `INPUT_NOT_VERIFIED`. For a click, progress requires a changed native URL/title or changed candidate content/state; candidate ref renumbering and reordering do not count. A body-text-only change counts only when the host completion conditions become newly true. Rotating banners therefore cannot advance the action history on their own. `observed_after_action` is a progress record, not proof that the entire task succeeded. Add its `historyEntry` to the next request's `history`. A JEV `DONE` proposal still needs step 2 with a new observation satisfying **all** host completion predicates before the bridge returns `completed`.

If an action errors or times out, it may already have occurred. Stop, re-observe, and let the host determine what happened before authorizing anything else. Never repeat an uncertain form input or click automatically.

All paths above are relative to this project root; when a Claude task starts elsewhere, use the installed skill's absolute module and `.env` paths. The `--` after `node` prevents Node from interpreting the application's `--env-file`. A key can alternatively come from the host's `TYPESAFE_API_KEY` environment variable. Never place the key in JSON input, command arguments, or chat. The helper prints sanitized errors, usage and approved host action data, not the API key.

## Example host plan

Adapt labels only from current observed elements. This example is illustrative, not a preset for an uninspected site:

```json
{
  "goal": "Search the public guide and open its contents.",
  "allowedOrigins": ["https://example.com"],
  "maxSteps": 3,
  "maxDurationMs": 60000,
  "actions": [
    { "id": "query", "action": "typeText", "description": "Fill the query before searching", "text": "guide", "target": { "roles": ["searchbox"], "nameEquals": "Search" } },
    { "id": "search", "action": "click", "description": "Search only after the full query is present", "target": { "roles": ["button"], "nameEquals": "Search" } },
    { "id": "open", "action": "click", "description": "Open the guide result", "target": { "roles": ["link"], "nameEquals": "Guide" } }
  ],
  "completion": { "textIncludes": "Guide contents", "urlIncludes": "/guide" }
}
```

The host must carry the complete action history, retain a single workflow deadline across CLI calls, and enforce the total TypeSafe call budget itself. A new CLI process has a one-request budget, so starting more processes does not constitute a globally enforced request limit. This bridge has host round trips between decisions; it is **not** the single-invocation continuous CUA loop and no speed advantage is claimed.

`api` in a decide input may contain only `timeoutMs` (1–60000), `maxInputBytes` (1–1000000), `minConfidence` (0.75–1), and `minMargin` (0.10–1). Defaults are 5000 ms, 100000 bytes, 0.75 and 0.10. Endpoints, keys, arbitrary code and tool names cannot be supplied by the model or input plan.

## Usage and verification

Each decide output includes `usage`, sanitized per-request `requests`, and `cost`. At the verified published TypeSafe price, input costs $0.042 per million tokens and output is free. [TypeSafe model pricing](https://docs.typesafe.ai/models)

`cost.estimatedJevUsd` is a list-price estimate from actual provider usage, not cash withdrawn or a remaining balance. If any attempted call has no usage response, it is `null`; `knownUsageUsd` shows the known subtotal separately. Credits, taxes and Claude's own inference costs are not included, and `hostCostUsd`/`cashChargeUsd` remain `null`. `authorize` and `verify` make no API requests. Sum distinct decide request records once across the workflow.

Offline verification:

```powershell
node --test ./test/claude-chrome.test.mjs ./test/claude-chrome-cli.test.mjs
```

The tests cover observed ref mapping, allowed origins, exact native tool arguments, freshness and target reuse, protected/hidden candidates, duplicate targets, completion proof, partial-input detection, secret-free output and unknown billing. They use simulated host observations and injected API responses; they do not replace the deferred live Claude Chrome test.
