# Task-start-aligned browser comparison / 실제 업무 시작 정렬 비교

Recorded on 2026-09-24. The video shows Astra attempt 1 and JEV attempt 2, the two completed runs. **Astra completed 1/1 attempts; JEV completed 1/2.** The first JEV attempt stopped at LOW_CONFIDENCE after three clicks; its four requests and cost are retained below. No confidence threshold was lowered. This is a small sequential development pilot with a selected completed pair, not a reliability or general speed benchmark.

2026-09-24 재촬영입니다. 영상에는 완주한 Astra 1차와 JEV 2차를 사용했습니다. **완주 횟수는 Astra 1/1, JEV 1/2**입니다. JEV 1차는 세 번 클릭 후 LOW_CONFIDENCE로 멈췄고, 호출 4회와 비용도 아래에 포함합니다. 확신도 기준은 낮추지 않았습니다. 완주한 두 실행을 고른 소규모 순차 개발 실험이므로 일반적인 속도나 신뢰성 우위를 입증하지 않습니다.

[![Actual task start aligned / 실제 업무 시작 정렬](comparison/poster.png)](comparison/comparison.mp4)

[▶ Play / 재생](comparison/comparison.mp4) · [Composition metadata / 편집 기록](comparison/comparison.json) · [Frame review / 프레임 검토](comparison/review.png)

## All paid attempts / 모든 유료 시도

| Attempt / 시도 | JEV | Outcome / 결과 | Task / 업무 | Full run / 전체 | API cost / 비용 | POST |
|---|---|---|---:|---:|---:|---:|
| [Astra attempt 1 / 1차](astra/report.json) | No / 미사용 | Pass / 통과 | 45.93 s | 85.52 s | $0.142300000 | 7 |
| [JEV attempt 1 / 1차](diagnostics/jev-1/report.json) | Yes / 사용 | LOW_CONFIDENCE / 중단 | 8.61 s | 28.55 s | $0.000766374 | 4 |
| [JEV attempt 2 / 2차](jev/report.json) | Yes / 사용 | Pass / 통과 | 16.90 s | 52.00 s | $0.018018600 | 7 |

Total new requests: **18**. Total accounted provider cost including the failed attempt: **$0.161084974**. Astra uses OpenRouter-reported credit cost; JEV uses the previously documented input list-price estimate plus the Astra extraction cost. Host inference, fees and tax are excluded. Costs from the [earlier pilot](../browser-playwright-20260924/RESULTS.md) are separate.

이번 재촬영은 실패분을 포함해 총 **18회**, 공급자 비용 합계 **$0.161084974**입니다. OpenRouter의 보고 비용과 JEV 입력 토큰 정가 추정치를 합산했으며 호스트 추론·수수료·세금은 제외합니다. 이전 파일럿 비용과 별도입니다.

## How zero is established / 0초를 맞춘 근거

The task starts after initial navigation, popup preparation and a coherent initial observation, **before the first model inference**. It ends after the goal loop and final fact extraction/validation. Each completed run still makes five model-selected clicks, visits three university pages in order, and verifies the bus 5101, phone 031-369-9100~1 and free shuttle fare. Neither image-based greeting nor profile content is claimed as read.

처음 페이지 로딩·팝업 정리·관측 준비가 끝나고 **첫 모델 판단 직전**을 0초로 기록했습니다. 마지막 사실 추출·검증까지 업무 시간에 포함합니다. 양쪽 모두 다섯 클릭·세 페이지 방문과 세 가지 사실을 검증했습니다. 이미지 본문을 읽었다고 주장하지 않습니다.

The supported [Playwright screencast callback](https://playwright.dev/docs/api/class-screencast#screencast-start-option-on-frame) supplies actual browser JPEGs and presentation timestamps in Unix milliseconds. A host monotonic clock measures duration; wall-clock anchors map these frames to task time. Observed task-anchor drift was 0.247 ms for Astra and 0.057 ms for JEV. The renderer verifies hashes and clock bounds, then shows the latest frame presented at or before taskStart + n×40 ms. It keeps all inference and waiting time at 1×. Browser frames can be sparse; 25 fps output is sample-and-hold, not 25 new captured images per second or subframe precision.

브라우저가 실제로 표시한 JPEG 프레임의 시각과 업무 타이머를 연결했습니다. 25fps 영상의 표시 단위는 0.04초이며, 해당 업무 시각 이전에 표시된 최신 프레임을 사용합니다. 프레임 전달 순서가 뒤바뀐 경우 표시 시각으로 정렬하되 원본을 버리지 않았습니다. 판단·대기를 생략하거나 배속하지 않았고, 업무 완료 후 시계가 멈춥니다. 짧은 쪽은 마지막 화면을 유지하며 긴 쪽 종료 후에도 2초 표시합니다.

The preparation and cleanup portions are omitted only from the task-aligned presentation. Full originals remain available: [Astra](astra/original.webm), [completed JEV](jev/original.webm), [stopped JEV](diagnostics/jev-1/original.webm). Frame manifests and hashes are published for [Astra](astra/task-clock/manifest.json) and [JEV](jev/task-clock/manifest.json). Raw JPEG source files remain local; reproducing the renderer requires your own timestamped recording. Old replay-only clips and their original measurements remain unchanged.

업무 정렬 영상에서만 준비·정리 구간을 제외했습니다. 전체 원본·실패 영상·프레임 시각 및 해시를 공개하며, 원본 JPEG 파일은 로컬에 보존합니다. 렌더러 재현에는 직접 촬영한 타임스탬프 자료가 필요합니다. 이전 영상과 측정값도 그대로 보존했습니다.

## Preflights and reproduction / 사전 검사와 재현

[Preflight 1](preflight-1/report.json) rejected unordered frame delivery; [preflight 2](preflight-2/report.json) also captured an incoherent initial page observation. Both had zero API requests. The bounded capture now retains arrival indices and sorts by presentation time; initial observation retries are read-only and limited to five seconds before task timing. [Preflight 3](preflight-3/report.json) completed the route with valid timing and zero API requests. All successful task-video frames were decoded and contact sheets visually inspected before publication.

사전 검사 1·2는 프레임 전달 순서와 초기 화면 관측 문제로 멈췄으며 API 호출은 없었습니다. 프레임 시각 정렬과 준비 단계의 제한된 읽기 전용 재관측을 적용한 뒤 사전 검사 3이 통과했습니다. 영상 전체를 디코딩하고 표본 화면을 시각 검토했습니다.

[English instructions](../../../docs/BROWSER-DEMO.en.md) · [한국어 재현 안내](../../../docs/BROWSER-DEMO.ko.md)
