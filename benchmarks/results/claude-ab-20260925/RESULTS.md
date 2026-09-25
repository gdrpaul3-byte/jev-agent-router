# Opus 5.5 only vs Opus 5.5 + JEV on real sites / 실사이트 비교

Recorded on 2026-09-25 (KST) with Claude Code and Claude Opus 5.5 on three public-site tasks: a GitHub repository (English) and two pages of a Korean university site. Three arms, each pre-registered before its paid attempts:

| Arm / 조건 | Completed / 완료 | Mean agent time / 평균 시간 | Comparable time / 비교 시간 | Mean Opus cost / 평균 Opus 비용 | JEV |
| --- | ---: | ---: | ---: | ---: | ---: |
| **Opus 5.5 only**, Claude in Chrome tools in the user's Chrome | **6/6** | 80.1 s | 80.1 s | $0.44 | — |
| **Opus 5.5 + JEV, Claude in Chrome bridge** (`jev-claude-chrome`), 6 registered + 1 extra | **0/7** | 277.4 s | 277.4 s | $1.28 logged (≈$1.34) | 12 req, $0.0026 |
| **Opus 5.5 + JEV, isolated Playwright loop**, registered P1–P6 | **5/6** | 65.1 s (≈30 s of it an exit-delay bug) | 54.4 s | $0.23 | 28 req, $0.0067 |
| Same loop after fixing that bug, extra X1–X3 | 2/3 | **29.4 s** | **20.9 s** | $0.20 | 13 req, $0.0031 |

"Comparable time" is the Playwright protocol's registered primary time: agent time minus browser launch and pop-up preparation, which the parent session did untimed for the Chrome arms. The Chrome bridge's registered attempts alone were 0/6, 246.7 s and $1.18. The Chrome arms ran 03:49–04:50 KST; the Playwright arm was registered afterwards, after the Chrome results were known, and ran 10:20–10:34 KST without re-running the other arms.

In the Playwright loop, Node drives an isolated headless Chrome and JEV chooses every click, so Opus only starts one command and reads the result. That arm finished 5 of 6 registered attempts and 2 of 3 extra attempts. After the fix its comparable time was about a quarter of Opus-only's (20.9 s vs 80.1 s) and its Opus cost about half ($0.20 vs $0.44); before the fix, the registered scholarship attempts were slower than Opus alone in raw agent time. Both of its failures came from JEV's confidence gate on the same step. Opus alone never failed. This is a small, sequential pilot on one Windows PC with a plan the experimenter wrote for the JEV arms, not a general reliability or speed claim.

Playwright 루프에서는 Node가 격리된 헤드리스 Chrome을 조작하고 JEV가 매 클릭을 고르며, Opus는 명령 한 번과 결과 읽기만 합니다. 이 조건은 9회 중 7회(사전 등록 6회 중 5회) 완료했습니다. 버그 수정 후 시간은 Opus 단독의 약 1/3, Opus 비용은 약 절반이었습니다. 실패 2회는 모두 같은 단계의 JEV 확신도 기준 미달이었고, Opus 단독은 실패가 없었습니다. 실험자가 JEV용 계획을 써 준 소규모 순차 실험입니다.

Costs are Claude Opus 5.5 API list-price equivalents ($4 input, $5 5-minute cache write, $0.20 cache read, $20 output per million tokens, [read 2026-09-25](https://platform.claude.com/docs/en/about-claude/pricing)) from each subagent's logged usage; a Claude subscription is billed differently. About $0.18–0.22 of an attempt is the fixed cost of starting a fresh Opus subagent when its ~57 k-token system prompt and tools come from the prompt cache (the voided A4, three tool calls, cost $0.22), and up to about $0.37 on a cache miss (P1's $0.39, B1); that fixed cost is nearly all of the Playwright arm's Opus cost. JEV cost is the TypeSafe list-price estimate from known usage.

## Where the time goes / 시간 구성

| Arm | Opus's own turns per attempt | Browser and JEV |
| --- | ---: | --- |
| Opus only | 23–62 s | Claude in Chrome tool calls 20–96 s |
| + JEV, Chrome bridge | 85–391 s (70–91% of the attempt) | JEV decision 2.6–8.8 s per call including the CLI |
| + JEV, Playwright loop | 8.7–12.7 s | browser launch and pop-up preparation 6–16 s; the whole JEV loop 6.6–16.5 s; JEV requests mostly 0.2–0.3 s, the first 0.5–1.1 s |

The Chrome bridge could not speed anything up because the extension's tools can only be called by the model: Opus had to read every page, re-type it into observation files and run the ledger commands, so JEV replaced only the one judgement Opus makes almost for free while reading. The Playwright loop takes Opus out of the per-step loop, which is where the repository's earlier Codex/Playwright comparison also found its speed-up. Chrome 브리지는 확장 도구를 모델만 호출할 수 있어 Opus가 모든 단계에 끼어야 했고, Playwright 루프는 Opus를 단계 반복에서 빼서 빨라졌습니다.

## Part 2 — Opus 5.5 + JEV through an isolated Playwright loop

Harness: [`benchmarks/claude-playwright-goal.mjs`](../../claude-playwright-goal.mjs) ([tests](../../claude-playwright-goal.test.mjs)). The host ran one command; the harness launched a fresh headless Chrome context, prepared the start page (HSMU pop-ups closed by the repository's existing routine, no model request), ran the repository goal loop with JEV (same request limits and 0.75/0.10 gates as the Chrome bridge; served model jev-1.13.0 in every request), and wrote `result.json` plus the final page text. The host then read the final text and reported the facts. Plans, truth, cards and grader rules are the same as in Part 1. [Protocol](protocol-playwright.json) · [report](report-playwright.json)

| # | Task | Graded result | Agent | Harness command | JEV loop | Opus | JEV |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| P1 | github | pass | 66.5 s | 53.9 s (idle tail 32.6 s) | 9.6 s | $0.39 | 5 req |
| P2 | scholarship | pass | 69.1 s | 56.2 s (tail 33.0 s) | 10.5 s | $0.20 | 4 req |
| P3 | directions | pass, visits in order | 77.1 s | 66.3 s (tail 32.9 s) | 16.5 s | $0.21 | 6 req |
| P4 | github | pass | 57.3 s | 46.5 s (tail 31.7 s) | 8.0 s | $0.22 | 5 req |
| P5 | scholarship | pass | 64.4 s | 53.0 s (tail 31.9 s) | 9.3 s | $0.20 | 4 req |
| P6 | directions | stop: `LOW_CONFIDENCE` 0.73 on the 4th of 5 steps (총장 프로필) | 55.9 s | 47.1 s (tail 31.4 s) | 6.9 s | $0.18 | 4 req |
| X1 | github | *extra, after the fix*; pass | 28.6 s | 17.2 s (tail 2.2 s) | 7.9 s | $0.22 | 5 req |
| X2 | scholarship | *extra*; pass | 31.8 s | 20.4 s (tail 2.1 s) | 8.3 s | $0.20 | 4 req |
| X3 | directions | *extra*; stop: `LOW_CONFIDENCE` 0.69 on the same step | 27.6 s | 18.5 s (tail 2.2 s) | 6.6 s | $0.18 | 4 req |

"Tail" is the harness command's duration minus the harness's own total: the time the Node process stayed alive after writing its result. Every host ran exactly one harness command and no browser or file-editing tool. Where the Chrome arm stopped at 0.73 on the scholarship board, this loop passed; the directions failures stopped on the same step with the same JEV input size (P6 0.73, X3 0.69), so JEV's answer varies near the 0.75 gate, as in the repository's earlier HSMU JEV run.

**Exit-delay bug (found after P1–P6).** A guard added during the pre-run review raced the final read against a 30 s timer that was never cleared, so each registered attempt's process stayed alive about 30 s after writing its result. Outcomes, facts, visits and costs are unaffected; only the wall clock is inflated. The fix and one extra attempt per task were registered before running X1–X3; P1–P6 remain the registered result. 등록 시도의 시간에는 결과 기록 후 약 30초 남는 버그가 포함돼 있어, 수정 후 추가 시도로 시간을 따로 쟀습니다.

**Before the paid attempts.** A zero-cost dry run confirmed every page on all three paths could be observed with one matching target per step; the GitHub home request (36.6 KB) needed the Chrome bridge's 100 KB limit instead of the goal CLI's 24 KB. A smoke run with a scripted decider then showed the loop stopping with `OBSERVATION_FAILED` on HSMU page loads and deciding on a half-rendered GitHub page, so the harness waits after each click for `DOMContentLoaded`, then 1 s (the Chrome bridge's wait), then until two consecutive reads agree (0.3 s in practice). A 22-agent adversarial review confirmed 13 of 20 findings; the fixes and disclosures are in the protocol.

**Disclosures.** (1) Both JEV arms follow a plan the experimenter wrote, with an exact-name target per step and the click order in the goal, and the directions plan names two controls the Opus-only card did not; read this as "Opus alone" versus "Opus + JEV following a written plan", not as navigation ability. (2) Playwright lists off-screen elements and reads `document.body.innerText`, so the Chrome bridge's scroll and `get_page_text` limits do not apply, and without host transcription the hover-menu expiry cannot occur. (3) The Playwright browser is isolated and signed out; it cannot use the user's logged-in sessions. (4) The Chrome arms ran 03:49–04:50 KST, this arm 10:20–10:34 KST and was registered after the Chrome results were known; GitHub main was the same commit. (5) The product's `goal` command has neither the post-click waits nor the final page text; the same loop without the waits stopped on these sites in the first smoke run. The harness is a benchmark script.

## Part 1 — Claude in Chrome arms

Recorded with the Claude in Chrome extension 1.0.94 and the `jev-claude-chrome` bridge at commit `068300d`.

| Task / 과제 | Arm / 조건 | Completed / 완료 | Agent time / 시간 | Opus cost (API list price) | JEV requests / cost |
| --- | --- | ---: | --- | ---: | ---: |
| GitHub: 4 folder clicks, 2 facts (en) | Opus 5.5 only | **2/2** | 50.6 s, 120.7 s | $0.68 | 0 |
| | Opus 5.5 + JEV | **0/3** | 270–462 s | $4.81 (≈$5.28) | 2 / $0.00092 |
| HSMU scholarship notice: 3 clicks, 3 facts (ko) | Opus 5.5 only | **2/2** | 58.3 s, 66.4 s | $0.91 | 0 |
| | Opus 5.5 + JEV | **0/2** | 103 s, 117 s | $1.53 | 4 / $0.00058 |
| HSMU directions, ordered visits (the [earlier Astra vs JEV task](../browser-task-aligned-20260924/RESULTS.md)) (ko) | Opus 5.5 only | **2/2** | 81.1 s, 103.5 s | $1.05 | 0 |
| | Opus 5.5 + JEV | **0/2** | 197 s, 336 s | $2.59 | 6 / $0.00105 |

Opus-only times include its tool loading but not the tab preparation, which the parent session did untimed. "≈" adds output tokens estimated at 2 characters per token for messages whose final usage was not logged (A2, A5x). JEV cost is the ledger's list-price estimate.

| # | Task | Arm | Graded result | Time | Opus | JEV |
| --- | --- | --- | --- | ---: | ---: | ---: |
| A1 | github | Opus | pass | 50.6 s | $0.33 | — |
| A2 | github | + JEV | stop: authorize screenshot timed out (30 s), viewport collapsed, no click | 456.5 s | $1.88 (≈$2.11) | 1 req |
| A3 | github | + JEV | stop: screenshots timed out before the first decision | 270.3 s | $1.11 | 0 |
| A4 | github | Opus | **void**: setup error by the operator (tab outside the tab group), 0 browser actions | 10.6 s | $0.22 | — |
| A4r | github | Opus | pass (rerun of A4; tolerated two screenshot timeouts) | 120.7 s | $0.36 | — |
| A5x | github | + JEV | *extra after an environment fix*; stop: screenshot timeout; each ~21 k-character (≈24 KB) observation took 73–76 s from the browser read to the last written file, longer than the 60 s authorize window allows | 462.1 s | $1.82 (≈$2.06) | 1 req |
| B1 | scholarship | + JEV | stop: `LOW_CONFIDENCE` 0.73 < 0.75 on the correct 2nd step (장학) | 116.8 s | $0.84 | 2 req |
| B2 | scholarship | Opus | pass (one coordinate misclick landed on S; the page did not change) | 66.4 s | $0.45 | — |
| B3 | scholarship | Opus | pass (one coordinate misclick opened the S menu first) | 58.3 s | $0.46 | — |
| B4 | scholarship | + JEV | stop: `LOW_CONFIDENCE` 0.73, identical input and result to B1 | 103.3 s | $0.69 | 2 req |
| C1 | directions | Opus | pass, visits in order (a coordinate click did nothing; a hidden-link click only added #content) | 103.5 s | $0.63 | — |
| C2 | directions | + JEV | stop: the H mega-menu closed before the authorize observation, the proposal expired, next decision BLOCKED 0.46 | 196.8 s | $1.09 | 3 req |
| C3 | directions | + JEV | stop: same as C2 (BLOCKED 0.34); the host also hovered once outside the ledger | 336.3 s | $1.50 | 3 req |
| C4 | directions | Opus | pass, visits in order (first menu click missed) | 81.1 s | $0.42 | — |

Grading used each subagent transcript and ledger, not the agent's own claim: all facts equal the pre-registered truth, the last observed URL is the target, no forbidden tool (navigate, typing, form input, new/closed tabs, JavaScript), visit order for the directions task, and ledger status `completed` for the JEV arm. No attempt used a forbidden tool. [Machine-readable report](report.json) · [protocol](protocol.json) · plans: [GitHub](plans/github-results.json), [scholarship](plans/hsmu-scholarship.json), [directions](plans/hsmu-directions.json).

### Why the Chrome bridge attempts stopped / Chrome 브리지가 멈춘 이유

1. **Observation transcription is too slow for text-heavy pages.** Claude cannot pipe a tool result into a file, so the host re-types `read_page` and `get_page_text` into the observation files. On the GitHub repository page (12.9 k characters of page text + 8 k characters of elements) the time from the browser read to the last written file was 72–76 s in all four measured observations — longer than the 60 s window between a decision and its authorization — and it is paid as Opus output tokens. On the smaller HSMU pages it was 12–16 s. 텍스트가 많은 GitHub 페이지는 관측 파일을 옮겨 쓰는 데만 72~76초가 걸려 60초 승인 기한을 넘깁니다(화성의과학대 페이지는 12~16초).
2. **The Chrome window must stay visible with the Claude tab active.** When the window was minimized or the group's tab was in the background, `screenshot` timed out after 30 s and the viewport collapsed to the scaled screenshot size (157×73, 314×155). The bridge needs a screenshot before each click authorization, so it cannot proceed; Opus alone also hit timeouts but kept going. The window was found minimized after A3 and again after A5x; with the user's consent it was restored and checked before every HSMU attempt. Windows entered network-connected Modern Standby at 04:27:58 KST, probably when the laptop lid was closed; from B1 (already running) through C4, the eight HSMU attempts had no screenshot timeout. 창이 최소화되거나 Claude 탭이 뒤에 있으면 스크린샷이 30초 뒤 실패합니다. 모던 스탠바이 진입(덮개를 닫은 것으로 보임) 뒤의 시도에서는 시간 초과가 없었습니다.
3. **Hover menus close between decision and authorization.** The HSMU H menu closed within about 30 s, before the next observation, so the proposed link disappeared. 드롭다운 메뉴가 판단과 승인 사이에 닫혔습니다.
4. **Confidence gate.** On the scholarship task JEV chose the correct next action at 0.73, below the unchanged 0.75 gate, identically in both attempts. The plan wording was not tuned after seeing results. 올바른 동작을 골랐지만 확신도 0.73으로 기준 미달이었습니다.

Registered before running: on the 총장 인사말 page `get_page_text` returns "No text content found" because the extension picks an empty content container, which the bridge stops as `PAGE_TEXT_UNAVAILABLE`. Identified afterwards: the 오시는 길 link is outside the first viewport, while the bridge has no scroll action. The JEV attempts on that task stopped earlier, so neither was reached.

## What JEV did and did not change / JEV가 바꾼 것과 바꾸지 못한 것

- Every click in both JEV arms was a JEV-chosen, host-approved target; there were no misclicks and every stop was fail-closed. Opus alone made five harmless wrong clicks (B2, B3, C1 twice, C4) and recovered. JEV 조건은 승인된 클릭만 실행했고 오클릭이 없었습니다.
- With Claude in Chrome, JEV does not replace Opus inference and costs about 3× more Opus. Through an isolated Playwright loop it does: Opus spent 9–13 s and roughly the fixed start-up cost per attempt, JEV $0.0007–0.0016. The price is a written plan, an isolated signed-out browser, and stops at the confidence gate that Opus alone did not have. Claude in Chrome에서는 JEV가 Opus 비용을 줄이지 못했지만, Playwright 루프에서는 Opus를 단계 반복에서 빼서 시간과 비용이 줄었습니다.

## Deviations and limits / 편차와 한계

- A2, A3 and A5x hit screenshot timeouts; the Chrome window was found minimized (and the group tab in the background) after A3 and again after A5x, and was not checked after A2. The Opus-only A4r also hit two timeouts after the first restore. They are kept as failures. A5x is an extra attempt run after the first restore, which did not hold; a second extra attempt was not run because A2 and A5x showed that writing one observation alone exceeds the window.
- A4 was voided for an operator setup error before any browser action and rerun as A4r.
- P1–P6 carry the exit-delay bug described above; X1–X3 are extra attempts after its fix.
- Two or three attempts per cell, one PC, live public sites that can change; Opus tokens include the fixed subagent overhead (~60 k tokens of system prompt and tools, cached). The operator session that prepared tabs, wrote plans and graded results is not included.
- Subagent transcripts and harness output directories stay local because they contain local paths.

2~3회씩의 소규모 실험이며, 실사이트는 바뀔 수 있습니다. 준비·계획 작성·채점을 한 상위 세션의 비용은 포함하지 않았습니다.
