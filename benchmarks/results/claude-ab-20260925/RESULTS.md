# Opus 5.5 only vs Opus 5.5 + JEV on real sites / 실사이트 비교

Recorded on 2026-09-25 (KST) with Claude Code, the Claude in Chrome extension 1.0.94 and the `jev-claude-chrome` bridge at commit `068300d`. **Opus 5.5 alone completed 6 of 6 attempts. Opus 5.5 + JEV completed 0 of 7.** This is a small, sequential, pre-registered pilot on one Windows PC, not a general reliability or speed claim.

2026-09-25 실측입니다. **Opus 5.5 단독 6/6 완료, Opus 5.5 + JEV 0/7 완료.** 한 PC에서 순차 실행한 소규모 사전 등록 실험이며, 일반적인 성능 주장을 하지 않습니다.

## Result / 결과

| Task / 과제 | Arm / 조건 | Completed / 완료 | Agent time / 시간 | Opus cost (API list price) | JEV requests / cost |
| --- | --- | ---: | --- | ---: | ---: |
| GitHub: 4 folder clicks, 2 facts (en) | Opus 5.5 only | **2/2** | 50.6 s, 120.7 s | $0.68 | 0 |
| | Opus 5.5 + JEV | **0/3** | 270–462 s | $4.81 (≈$5.28) | 2 / $0.00092 |
| HSMU scholarship notice: 3 clicks, 3 facts (ko) | Opus 5.5 only | **2/2** | 58.3 s, 66.4 s | $0.91 | 0 |
| | Opus 5.5 + JEV | **0/2** | 103 s, 117 s | $1.53 | 4 / $0.00058 |
| HSMU directions, ordered visits (the [earlier Astra vs JEV task](../browser-task-aligned-20260924/RESULTS.md)) (ko) | Opus 5.5 only | **2/2** | 81.1 s, 103.5 s | $1.05 | 0 |
| | Opus 5.5 + JEV | **0/2** | 197 s, 336 s | $2.59 | 6 / $0.00105 |

Mean per attempt: Opus only 80 s and $0.44; Opus + JEV 277 s and $1.28 (≈$1.34 with estimated missing output). Costs are Claude Opus 5.5 API list-price equivalents ($4 input, $5 5-minute cache write, $0.20 cache read, $20 output per million tokens, [read 2026-09-25](https://platform.claude.com/docs/en/about-claude/pricing)) from each subagent's logged usage; a Claude subscription is billed differently. "≈" adds output tokens estimated at 2 characters per token for messages whose final usage was not logged (A2, A5x). JEV cost is the TypeSafe list-price estimate from the ledger.

시도당 평균은 Opus 단독 80초·$0.44, Opus + JEV 277초·$1.28입니다. 비용은 Opus 5.5 API 정가로 환산한 값이며, 구독 요금제의 실제 청구와 다릅니다. JEV 자체 비용은 12회 호출에 $0.00255였습니다.

## All attempts / 모든 시도

| # | Task | Arm | Graded result | Time | Opus | JEV |
| --- | --- | --- | --- | ---: | ---: | ---: |
| A1 | github | Opus | pass | 50.6 s | $0.33 | — |
| A2 | github | + JEV | stop: authorize screenshot timed out (30 s), viewport collapsed, no click | 456.5 s | $1.88 (≈$2.11) | 1 req |
| A3 | github | + JEV | stop: screenshots timed out before the first decision | 270.3 s | $1.11 | 0 |
| A4 | github | Opus | **void**: setup error by the operator (tab outside the tab group), 0 browser actions | 10.6 s | $0.22 | — |
| A4r | github | Opus | pass (rerun of A4; tolerated two screenshot timeouts) | 120.7 s | $0.36 | — |
| A5x | github | + JEV | *extra after an environment fix*; stop: screenshot timeout, and writing the 21 KB observation took 73–76 s, longer than the 60 s authorize window | 462.1 s | $1.82 (≈$2.06) | 1 req |
| B1 | scholarship | + JEV | stop: `LOW_CONFIDENCE` 0.73 < 0.75 on the correct 2nd step (장학) | 116.8 s | $0.84 | 2 req |
| B2 | scholarship | Opus | pass (one coordinate misclick opened the S page first) | 66.4 s | $0.45 | — |
| B3 | scholarship | Opus | pass (one coordinate misclick opened the S menu first) | 58.3 s | $0.46 | — |
| B4 | scholarship | + JEV | stop: `LOW_CONFIDENCE` 0.73, identical input and result to B1 | 103.3 s | $0.69 | 2 req |
| C1 | directions | Opus | pass, visits in order | 103.5 s | $0.63 | — |
| C2 | directions | + JEV | stop: the H mega-menu closed before the authorize observation, the proposal expired, next decision BLOCKED 0.46 | 196.8 s | $1.09 | 3 req |
| C3 | directions | + JEV | stop: same as C2 (BLOCKED 0.34); the host also hovered once outside the ledger | 336.3 s | $1.50 | 3 req |
| C4 | directions | Opus | pass, visits in order (first menu click missed) | 81.1 s | $0.42 | — |

Grading used each subagent transcript and ledger, not the agent's own claim: all facts equal the pre-registered truth, the last observed URL is the target, no forbidden tool (navigate, typing, form input, new/closed tabs, JavaScript), visit order for the directions task, and ledger status `completed` for the JEV arm. No attempt used a forbidden tool. [Machine-readable report](report.json) · [protocol](protocol.json) · plans: [GitHub](plans/github-results.json), [scholarship](plans/hsmu-scholarship.json), [directions](plans/hsmu-directions.json).

## Why the JEV attempts stopped / JEV 조건이 멈춘 이유

1. **Observation transcription is too slow for text-heavy pages.** Claude cannot pipe a tool result into a file, so the host re-types `read_page` and `get_page_text` into the observation files. On the GitHub repository page (12.9 k characters of page text + 8 k characters of elements) the time from the browser read to the last written file was 72–76 s in all four measured observations — longer than the 60 s window between a decision and its authorization — and it is paid as Opus output tokens. On the smaller HSMU pages it was 12–15 s. 텍스트가 많은 GitHub 페이지는 관측 파일을 옮겨 쓰는 데만 72~76초가 걸려 60초 승인 기한을 넘깁니다(화성의과학대 페이지는 12~15초).
2. **The Chrome window must stay visible with the Claude tab active.** When the window was minimized or the group's tab was in the background, `screenshot` timed out after 30 s and the viewport collapsed to the scaled screenshot size (157×73, 314×155). The bridge needs a screenshot before each click authorization, so it cannot proceed; Opus alone also hit timeouts but kept going. The window was found minimized after A3 and again after A5x; with the user's consent it was restored and checked before every HSMU attempt. 창이 최소화되거나 Claude 탭이 뒤에 있으면 스크린샷이 30초 뒤 실패합니다.
3. **Hover menus close between decision and authorization.** The HSMU H menu closed within about 30 s, before the next observation, so the proposed link disappeared. 드롭다운 메뉴가 판단과 승인 사이에 닫혔습니다.
4. **Confidence gate.** On the scholarship task JEV chose the correct next action at 0.73, below the unchanged 0.75 gate, identically in both attempts. The plan wording was not tuned after seeing results. 올바른 동작을 골랐지만 확신도 0.73으로 기준 미달이었습니다.

Pre-identified before running: on the 총장 인사말 page `get_page_text` returns "No text content found" because the extension picks an empty content container, which the bridge stops as `PAGE_TEXT_UNAVAILABLE`; and the 오시는 길 link is outside the first viewport, while the bridge has no scroll action. The JEV attempts on that task stopped earlier, so neither was reached.

## What JEV did and did not change / JEV가 바꾼 것과 바꾸지 못한 것

- Every click in the JEV arm was a ledger-authorized ref click; there were no misclicks and every stop was fail-closed. Opus alone made four harmless wrong clicks (B2, B3, C1, C4) and recovered. JEV 조건은 승인된 클릭만 실행했고 오클릭이 없었습니다.
- In this setup JEV does not replace Opus inference: Opus still reads every page, then also writes observation files and runs the ledger commands. JEV's own cost was negligible ($0.00255 for 12 requests), but Opus cost per attempt was about 3× higher and no attempt finished. Savings would need a host that does not read pages itself (such as the earlier Playwright host) or a cheaper host model; neither was tested here. 이 구성에서는 Opus가 여전히 모든 페이지를 읽으므로 JEV가 비용을 줄이지 못했습니다.

## Deviations and limits / 편차와 한계

- A2, A3 and A5x hit screenshot timeouts; the Chrome window was found minimized (and, after A3, the group tab in the background) only after those attempts. They are kept as failures. A5x is an extra attempt run after the first restore, which did not hold; a second extra attempt was not run because A2 and A5x showed that writing one observation alone exceeds the window.
- A4 was voided for an operator setup error before any browser action and rerun as A4r.
- Two attempts per cell, one PC, live public sites that can change; Opus tokens include the fixed subagent overhead (~60 k tokens of system prompt and tools, cached). The operator session that prepared tabs and graded results is not included.
- Subagent transcripts stay local because they contain local paths.

2회씩의 소규모 실험이며, 실사이트는 바뀔 수 있습니다. 준비·채점을 한 상위 세션의 비용은 포함하지 않았습니다.
