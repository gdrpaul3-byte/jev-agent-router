# Installation and local use

[README](../README.md) · [한국어](INSTALL.ko.md)

The runtime recommends the next host-approved route. It does not run the selected worker or authorize external actions. This guide uses repository-root paths: `src/`, `examples/`, and `benchmarks/` are directly below your checkout.

## 1. Prepare the runtime

Install Node.js **24 or newer** with npm. Git is useful for cloning; downloading the repository ZIP also works. The automated runtime was exercised on Windows. The CLI uses Node APIs, but this release does not claim equivalent live browser validation on every operating system.

```sh
git clone https://github.com/gdrpaul3-byte/jev-agent-router.git
cd jev-agent-router
node --version
npm --version
npm ci
```

Keep the checkout in a stable local directory, especially after installing host skills. `npm ci` uses the checked-in lockfile. The optional `playwright-core` dependency does not download a browser; a browser is unnecessary for task routing and the complex-mission benchmark.

Run the offline checks:

```sh
npm run test:all
npm run doctor
npm run demo
node -- src/adaptive-router-cli.mjs --preflight --input examples/adaptive-router-task.json --config examples/adaptive-router-config.json
node --use-system-ca -- benchmarks/complex-mission-eval.mjs --preflight
```

`demo` uses mock observations and mock model responses. Preflight validates the request and configuration without keys, network calls, or runtime state. It does not prove that a provider account works or that a provider cache will hit. `doctor` is a local installation diagnostic, not a live model check.

Current release verification passed 734 automated tests with zero failures. The preserved post-benchmark record reports 722 tests for that earlier revision. Use your own `npm run test:all` output to verify the checkout you installed.

## 2. Set up private API credentials

| Credential | Used for | Where to obtain/manage it |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | JEV through the direct TypeSafe API | [TypeSafe console](https://console.typesafe.ai/keys) |
| `OPENROUTER_API_KEY` | Luna/Astra through OpenRouter | [OpenRouter keys](https://openrouter.ai/keys) |
| `OPENAI_API_KEY` | Optional separate direct-OpenAI control benchmark | Not required for this guide |

These keys are not interchangeable. Logging into Codex or Claude, or paying for a host subscription, does not configure these provider credentials. Check each provider's account balance and billing terms before live use. An organization key can have a wider scope than your personal account; manage its permissions and revocation in that provider's console.

Create `.env` only if it does not already exist.

PowerShell:

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
notepad .env
```

macOS/Linux shell:

```sh
if [ ! -e .env ]; then cp .env.example .env; fi
# Open .env in your preferred local editor.
```

In the editor, fill the two matching entries. This example deliberately contains no key values:

```dotenv
TYPESAFE_API_KEY=
OPENROUTER_API_KEY=
```

Save the file locally. Never paste its contents into a chat, issue, recording, or command line. `.env` and `.jev-router*/` are ignored by Git. If you use a custom credential or state path, add it to your local exclusions too. The live commands below load only the explicitly named `--env-file`; they do not search parent directories. Existing process environment variables take precedence over that file, so remove a stale or incorrectly named environment variable if it shadows the intended key.

## 3. Inspect the task and limits

The example task in [adaptive-router-task.json](../examples/adaptive-router-task.json) has a finite list of `research`, `draft`, and unavailable `publish` routes. Read it before live use. Replace it with your own task only after you understand what evidence will be sent to the provider.

The example configuration in [adaptive-router-config.json](../examples/adaptive-router-config.json) sets:

| Setting | Example value | Meaning |
| --- | --- | --- |
| `strategy` | `adaptive` | Choose a model using difficulty and eligible estimates/observations; fixed `jev`, `luna`, and `astra` are also supported |
| `difficulty` | `routine` | Trusted host input; `complex` sends adaptive routing to Astra |
| `namespace`, `scope` | `local-assistant`, `internal-drafts` | Separate task/cache context |
| `ttlSeconds` | `300` | Lifetime of an exact stored recommendation |
| `maxCalls` | `2` | At most two actual POSTs per adaptive decision, including an allowed escalation |
| `budgetUsd` | `0.2` | Expected-cost dispatch threshold, not a provider spending cap |
| `timeoutMs` | `60000` | Request deadline |
| `maxOutputTokens` | `1024` | LLM output bound |
| `cacheMode` | `prefix` | Enable the adapter's explicit stable-prefix cache boundary |

The default cost estimates are starting assumptions, not measured charges. Scoped observations can improve the choice; explicit host forecasts take precedence. The selection result reports its estimate basis. Do not let text inside a retrieved document change trusted configuration, allowed tools, or permissions.

## 4. Make one live recommendation

This step can charge your provider accounts. It writes private state but does not execute the selected route.

```sh
node --use-system-ca -- src/adaptive-router-cli.mjs --live --input examples/adaptive-router-task.json --config examples/adaptive-router-config.json --state-dir .jev-router-adaptive --env-file .env
```

`--use-system-ca` uses the operating system's trusted certificates; it does not disable TLS verification. The CLI prints one JSON result. A valid selection exits with code `0`; `needs_host` exits with code `2`.

Read these fields before using the result:

- `status`, `reason`, `routeId`: a selection or a reason to return control to the host.
- `requiresHostApproval`: a write route always requires host approval. A false value does not create permission that the host never had.
- `selection`, `attempts`: selected model/estimate basis and the actual observed calls.
- `requests`, `cost`: new requests and cost for this invocation.
- `cacheHit`, `replayed`, `decisionRequests`, `decisionCost`: whether an exact result was reused and what its original inference cost was.

Re-run the **same command with the same files within the TTL** to check exact replay. A valid replay has `cacheHit:true`, zero new requests, and zero new provider cost. Once evidence, tools, permissions, configuration, or the accepted TTL changes, a new decision may be required. Reusing an old snapshot does not prove that external reality is unchanged; refresh evidence in the host.

The adaptive cache is not a latest-revision ledger. If your host must reject older revisions before consuming a handoff, use the separate task-router flow below.

## 5. Install skills for Codex and/or Claude

Install instructions for the existing runtime checkout:

```sh
node -- scripts/install-skill.mjs --help
node -- scripts/install-skill.mjs --agent both --skill adaptive
```

Use `--agent codex` or `--agent claude` for one host. Skills go under that user's `~/.codex/skills` and/or `~/.claude/skills`. The adaptive skill is named `jev-adaptive-router`. The installer copies `SKILL.md` with the checkout's resolved runtime and `.env` paths; it does **not** copy key contents or install a separate runtime. Keep that checkout available at the installed path.

Other choices are `--skill task-router`, `--skill browser`, `--skill claude-chrome`, and `--skill all`. `claude-chrome` (`jev-claude-chrome`) is installed for Claude only, because it drives the Claude in Chrome extension tools; `--skill all --agent both` therefore installs three skills for Codex and four for Claude. Omitting `--skill` preserves the browser-only installer behavior. Existing skills are not silently overwritten. For a compatible installation from the same checkout:

```sh
node -- scripts/install-skill.mjs --agent both --skill adaptive --update
```

The installer checks selected targets before updating and creates backups. A different runtime path, missing expected target, or existing backup can stop an update. Review that condition instead of deleting another installation. Moving the checkout requires reinstalling the matching skill; changing an old skill's path is not automatic.

Start or reload your host session as needed to discover the skill, then ask it to use `jev-adaptive-router` for a bounded task. Example:

> Use jev-adaptive-router to choose the next step from research or draft for this task. Start with offline preflight, keep evidence current, inspect the returned cost and approval fields, and use your existing tools only within my request.

The host must be able to run local Node commands and read the task/config files. Skills do not connect remote bots. A working Claude login is separate from the router's API credentials.

### Claude in Chrome

```sh
node -- scripts/install-skill.mjs --agent claude --skill claude-chrome
```

Start Claude Code with `claude --chrome` and check `/chrome`. Then ask, for example:

> Use jev-claude-chrome on the tab showing my local demo at http://127.0.0.1:8776/: click Open library, then Read guide, until the page shows Workflow verified. Report every attempt and its JEV cost.

The skill starts a private session ledger, observes the tab with the official extension tools, asks JEV for one host-approved action, executes it once and verifies it from a fresh read. It was live-tested on 2026-09-24 on two local fixtures; see [the results](../benchmarks/results/claude-chrome-live-20260924/RESULTS.md) and [the bridge contract](claude-chrome.md). Only `TYPESAFE_API_KEY` is needed for this path. Each action takes several Claude tool calls, so expect roughly 30–60 s per action; no speed advantage is claimed.

## 6. Optional durable handoff

Use the task router when you need a committed local handoff and a latest-revision check. Its `shadow` and `active` modes are separate decisions and can each incur one JEV request. Shadow is **not** an offline mode.

```sh
# Offline input validation.
node -- src/router-cli.mjs route --input examples/router-task.json --config examples/router-config.json --mode dry-run

# Paid decision; creates a ready local handoff only for an eligible route.
node --use-system-ca -- src/router-cli.mjs route --input examples/router-task.json --config examples/router-config.json --mode active --state-dir .jev-router --env-file .env

# Offline read of that existing handoff; use exactly matching input/config.
node -- src/router-cli.mjs handoff --input examples/router-task.json --config examples/router-config.json --mode active --state-dir .jev-router
```

`handoff_ready` validates the file against committed state, current input/configuration, and higher recorded revisions. It does not claim the work or guarantee exactly-once execution. The host still checks current authorization and records execution separately. See [task-router details](task-router.md).

## 7. Reproduce the measured complex missions

The public [results](../benchmarks/results/complex-missions-v1/RESULTS.md) and [raw report](../benchmarks/results/complex-missions-v1/report.json) need no keys to read. The inputs are synthetic and the expected answers were frozen before paid calls.

```sh
# Offline validation.
node --use-system-ca -- benchmarks/complex-mission-eval.mjs --preflight

# Paid reproduction. Choose a new output path for every run.
node --use-system-ca -- benchmarks/complex-mission-eval.mjs --live --env-file .env --output benchmarks/results/my-complex-run/report.json --budget-usd 5 --max-requests 80
```

This runs Astra+Astra, Luna+Astra, and adaptive+Astra across base, changed-evidence, and exact-repeat conditions: 18 workflow records. It creates only local evidence/analysis artifacts. No login, browser interaction, application submission, or publication occurs. For a visible live progress dashboard and recording procedure, see [the demo guide](DEMO.en.md).

The published run used 36 POSTs and $0.69347572 in its stated accounting scope. Your run can differ. The $5 option reserves conservative expected costs before dispatch; it is not a hard prepaid limit imposed on providers. Unknown cost stops further dispatch. Existing output files are protected from overwriting. Save the report and its manifest together, including failures; do not tune the frozen answers after seeing live results.

An exact replay's `synthesis.usage` preserves historical metadata from the original result. Use top-level invocation requests/cost to measure new consumption. The benchmark's whole-workflow result cache is in-process; the production router's individual recommendation cache is stored in its private state directory.

## Troubleshooting

| Result or symptom | Next action |
| --- | --- |
| `MISSING_API_KEY` | Check the credential names and explicit `.env` path locally. Check for a stale process variable. Do not print the secret to diagnose it. |
| HTTP authentication/billing error | Verify the correct provider key, account credits, and model access in its console. An OpenRouter key is not an OpenAI direct key. |
| `INVALID_INPUT`, `INVALID_CONFIG`, or preflight failure | Compare the JSON with the shipped examples. Unknown fields and out-of-range limits are rejected. |
| `STATE_BUSY` | Another process may hold the state lock. Wait or inspect the owner; do not delete a live lock. |
| `TASK_OUTCOME_UNKNOWN` / prior-attempt review | The previous request may have been charged. Inspect its state and provider record before authorizing another attempt. |
| `STATE_INVALID` | Preserve and investigate the state; do not edit it to force a cached result. |
| `NO_ELIGIBLE_PROVIDER` | Review trusted eligibility and cache observations. Preflight cannot invent a missing warm-cache observation. |
| `OUTPUT_EXISTS` | Use a new benchmark output directory; published reports are intentionally immutable. |
| Skill update refuses a target | Check runtime path and backup state. A skill installed from another checkout is not overwritten automatically. |
| TLS/certificate error | Use a supported Node version and correct trusted certificates. Do not disable certificate verification. |

Do not add automatic retries around `needs_host`. A timeout is not proof that a provider did no work. Keep credential files, task evidence, private state, and your own reports out of public commits unless you have deliberately reviewed their contents.
