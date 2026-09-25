# Claude Code + Claude in Chrome: live host test (2026-09-24 UTC)

**Claude Code (desktop app, Windows 11) acted as the host and drove the real Claude in Chrome extension (1.0.94). JEV (`jev-1.13.0`, TypeSafe direct API) chose each next action through the session CLI. Both local fixtures completed on the first attempt with the final, reviewed build; earlier development attempts are listed with their stop reasons.**

**Claude Code가 호스트가 되어 실제 Claude in Chrome 확장으로 두 로컬 예제를 실행했습니다. 검토를 마친 최종 빌드에서는 두 예제 모두 첫 시도에 완료했고, 개발 중 시도와 중단 사유도 모두 공개합니다.**

Raw per-attempt data: [report.json](report.json). Contract and limitations: [docs/claude-chrome.md](../../../docs/claude-chrome.md). Skill: [skills/jev-claude-chrome](../../../skills/jev-claude-chrome/SKILL.md).

## Fixtures

| ID | Task | Actions |
| --- | --- | --- |
| T1 | Two-click demo (`examples/demo.html`, `http://127.0.0.1:8776`) | click Open library → click Read guide → "Workflow verified" |
| T2 | Korean notice search (`benchmarks/goal-fixture.mjs`, `http://127.0.0.1:8781`) | type "야간 개방" → click 검색 → click 도서관 → open "2026 도서관 야간 개방 안내" (not the pinned or 2025 notices) → article text and URL |

T2 uses the repository's existing plan (`benchmarks/goal-plan.mjs`) with Claude's role names (`textbox`, `button`, `link`) and a 600 s budget. Every step ran decide → authorize (fresh read, ref check) → one official tool call → verify (fresh read). Completion needed JEV's DONE plus an independent check of all completion predicates.

## Attempts

| Task | Attempt | Build | Result | Steps done | JEV requests | Input tokens | JEV cost (list price) | Wall clock |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| T1 | dev-1 | development | stopped: `LOW_CONFIDENCE` (0.70) at step 2 | 1/2 | 2 | 2,938 | $0.000123 | 62.5 s |
| T1 | dev-2 | development | stopped: `LOW_CONFIDENCE` (0.65) at step 2 | 1/2 | 2 | 2,938 | $0.000123 | 74.2 s |
| T1 | dev-3 | development, goal reworded | **completed** | 2/2 | 3 | 4,395 | $0.000185 | 124.9 s |
| T2 | dev-1 | development | stopped: `PROPOSAL_EXPIRED` after input (outcome kept as unverified) | 0/4 | 1 | 2,595 | $0.000109 | 144.4 s |
| T2 | dev-2 | development | stopped: `LOW_CONFIDENCE` (0.56) after input | 1/4 | 2 | 5,203 | $0.000219 | 66.1 s |
| T2 | dev-3 | development | **completed** | 4/4 | 5 | 13,696 | $0.000575 | 228.6 s |
| **T1** | **final-1** | **release** | **completed** | 2/2 | 3 | 4,395 | $0.000185 | 163.3 s |
| **T2** | **final-1** | **release** | **completed** | 4/4 | 5 | 13,716 | $0.000576 | 248.7 s |

Session totals: 8 attempts, 4 completed, 23 JEV requests, 49,876 input tokens, **$0.002095** at the TypeSafe list price ($0.042 per million input tokens, output free). Wall clock runs from `start` to the last ledger write and is dominated by Claude's own tool round trips (about 30–60 s per action, including one 30 s screenshot timeout in T1 final-1). **No speed advantage is claimed.**

Decision confidences (JEV operation/target minimum) for the release runs:

- T1 final-1: open-library 0.89, read-guide 0.83, DONE 0.93.
- T2 final-1: enter-query 0.95, submit-search 0.89 (field value shown as `valueSource: "tool_report"`), filter-library 0.94, open-notice 0.95 (chosen over the pinned and 2025 notices), DONE 0.84.

## What the development attempts showed

1. **Dropped clicks.** Before the session CLI existed, a stateless probe (3 more JEV requests, 4,195 tokens, $0.000176) authorized a ref click that Claude in Chrome reported as "Clicked on element" but that never reached the page. It failed 6/6 times without a screenshot since the last navigation and succeeded 4/4 times after a 0.1-scale screenshot. The old verify step correctly stopped with `NO_OBSERVABLE_PROGRESS`; the skill now takes that screenshot before every click authorization.
2. **Goal wording.** With the abstract goal "Open the library, then read the guide", JEV stayed below the 0.75 gate at step 2 (0.39–0.70 when it chose the right action; some probe calls chose BLOCKED). Naming the visible buttons and the completion text gave 0.83–0.84 (4/4 probe calls) and completed. This is host plan guidance in the skill.
3. **Timing window.** T2 dev-1 lost 30 s to a screenshot timeout and verified more than 60 s after the decision. The input had happened, so the ledger kept it as unverified and stopped. Verification is now bounded from the authorization instead.
4. **Hidden field values.** `read_page` never shows the value of a labelled field. After a verified input, JEV hesitated (0.55–0.56) until the ledger showed the verified value again (0.91–0.94 in probes and dev-3; 0.89 in the release run with the value marked as a tool report).

Another 25 direct decider calls compared goal wording, title/history variants and a shown field value. Their token usage was not recorded; at 1,400–2,900 input tokens per call they cost roughly $0.0015–0.003.

## Review between the development and release runs

Four multi-agent review rounds (26, 10, 6 and 4 agents, all with mocked JEV) compared the bridge with the installed extension's source, reproduced each reported defect with a script, and re-verified the fixes. The largest changes: a strict parser for the real `read_page` grammar with a `read_page ref_id` binding check against forged lines, file-time freshness, one shared protected-field predicate, a lock held until every ledger write settles, identity-based click-progress filtering, support for all `form_input` report shapes, and provenance-marked remembered inputs. The remaining limitations are listed in [docs/claude-chrome.md](../../../docs/claude-chrome.md#known-limitations). A final simulation that followed only the skill text passed on both fixtures before the release runs.

## Other skills from Claude

The same Claude session also ran the two routing skills through their CLIs:

| Skill | Run | Result | Requests | Cost |
| --- | --- | --- | ---: | ---: |
| jev-adaptive-router | live (`examples/adaptive-router-*.json`) | `selected`, route `draft`, JEV | 2 | $0.004351 (JEV estimate + OpenRouter credits) |
| jev-adaptive-router | identical rerun | exact replay, `cacheHit: true` | 0 | $0 |
| jev-task-router | dry-run | `dry_run` | 0 | $0 |
| jev-task-router | shadow (live) | recommendation `research`, baseline kept | 1 | $0.000034 |
| jev-task-router | identical rerun | replay | 0 | $0 |

## Scope

These are two small synthetic local pages on one Windows machine with one extension version. They show that the documented Claude procedure works end to end; they do not establish general reliability or speed. Costs exclude Claude's own inference, the review workflows, credits and taxes.

## Reproduce

```sh
node examples/demo-server.mjs                      # T1 on 127.0.0.1:8776
node benchmarks/goal-fixture.mjs --port 8781       # T2
node -- scripts/install-skill.mjs --agent claude --skill claude-chrome
```

Then, in `claude --chrome`, ask Claude to use `jev-claude-chrome` on the fixture tab with a plan like the ones in this report, and to report every attempt.
