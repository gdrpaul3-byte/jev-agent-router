# Where JEV Agent Router fits / 다른 JEV 저장소와의 차이

**JEV Agent Router packages decision reuse, JEV/LLM selection, validated task handoffs and inspectable workflow experiments for an existing agent.** Its useful distinction is this combined scope. Individual ideas such as typed choices, model routing, caching and evidence logs also exist elsewhere.

**이 저장소는 기존 에이전트가 사용할 판단 재사용, JEV·LLM 선택, 검증 가능한 업무 인계, 실제 업무 실험을 함께 제공합니다.** 이 조합이 주된 차별점입니다. 구조화된 선택·모델 라우팅·캐시·실행 기록 각각을 독점적인 기능으로 주장하지 않습니다.

The following is a comparison of project purposes, based on their linked README revisions reviewed on **2026-09-24**. It is not an exhaustive feature audit or a head-to-head performance test. The final column describes this project's scope, not a claim that another project cannot implement it.

아래는 **2026-09-24에 확인한 README 버전**을 기준으로 한 용도 비교입니다. 전체 기능을 감사하거나 저장소끼리 성능을 대결한 결과는 아닙니다. 마지막 열은 우리의 구현 범위이며 다른 프로젝트의 구현 가능성을 부정하지 않습니다.

| Project and source / 저장소·출처 | Its focus / 주된 목적 | Our focus in relation / 우리의 적용 범위 |
|---|---|---|
| [TypeSafe Mario](https://github.com/fhshaik/typesafe-mario/blob/ca22449ed187118d19326d1f54b01b6636578aa4/README.md) | Convert emulator state into compact structured input and let JEV choose legal controller actions, with recorded telemetry. / 에뮬레이터 상태를 구조화하고 JEV가 허용된 게임 조작을 선택합니다. | Apply bounded decisions to host-defined workers, tools and browser goals; add reuse, model choice and handoff validation. / 담당·도구·브라우저 업무 선택에 재사용·모델 선택·인계 검증을 결합합니다. |
| [Jev Codex Router](https://github.com/0xNatoshi/jev-codex-router/blob/8701ef788aa8cb0948f299538747fb01029d32b8/README.md) | Route Codex model calls and reasoning effort through a native relay; also track usage and cache evidence. / Codex의 모델 호출·추론 강도를 라우팅하고 사용량·캐시 근거를 기록합니다. | Expose an explicit JSON/Node decision interface for the host's next worker or tool. Our adaptive policy selects the judge used for that decision; the host remains the executor. / 명시적 JSON·Node 호출로 다음 담당·도구를 고르고, 그 판단에 쓸 모델도 선택합니다. 실행은 호스트가 맡습니다. |
| [Typesafe MCP](https://github.com/itsmostafa/typesafe-mcp/blob/4f29b32b2e3eb6e2eb20673b31d3745ea5c5ead4/README.md) | Give agent clients direct access to typed TypeSafe judgments through a shared connector. / 여러 에이전트에서 TypeSafe의 구조화된 판단을 호출하는 연결 도구입니다. | Package local decision policy, exact replay and stateful handoff checks. Our current integration surface is a CLI/Node API with optional skills. / 로컬 판단 정책·정확 재생·상태를 보존하는 인계 검증을 제공합니다. 현재 연결 방식은 CLI·Node API와 선택적 스킬입니다. |
| [Newsjack](https://github.com/elvisun/newsjack/blob/092d882fc69912622f620c50eb493afe625f99dc/README.md) | Provide PR/news workflows including relevance filtering and triage for existing agents. / 기존 에이전트에 뉴스 선별·분류 등 PR 업무 절차를 제공합니다. | Accept host-defined route candidates across bounded tasks, with reusable decisions and a shared measurement harness. / 업무별로 호스트가 정의한 후보를 받고, 판단 재사용과 같은 측정 절차를 적용합니다. |
| [Canny](https://github.com/qkal/Canny/blob/f2c5e53779445d60dc4a09d2dbced2308fccb820/README.md) | Use deterministic hooks and recorded evidence to govern coding-agent completion claims, with JEV advising. / 결정론적 후크와 근거 기록으로 코딩 에이전트의 완료 주장을 검증하며 JEV는 보조 판단을 제공합니다. | Validate a routing decision and its handoff before execution, and publish separate completion checks for benchmark tasks. / 실행 전 라우팅 결정과 인계를 검증하고, 실험 업무의 완료 검사도 별도로 공개합니다. |

The closest overlaps deserve credit: Jev Codex Router also considers cache evidence and records usage; Canny also separates JEV advice from deterministic evidence. Our positioning rests on the particular combination and integration contract above, not on inventing those principles.

유사한 기능도 인정합니다. Jev Codex Router는 캐시 관측·사용량을 다루고, Canny는 JEV의 판단과 결정론적 근거를 구분합니다. 우리의 소개는 이런 원칙의 최초 발명보다 위 기능 조합과 연결 방식에 초점을 둡니다.

## What you can verify here / 직접 확인할 근거

| Claim / 설명 | Evidence / 근거 | Current boundary / 현재 범위 |
|---|---|---|
| Reuse before new inference; choose JEV/Luna/Astra for a fresh decision. / 먼저 결과를 재사용하고 새 판단의 모델을 선택합니다. | [Adaptive policy](adaptive-routing.md), [implementation](../src/adaptive-router.mjs), [tests](../test/adaptive-router.test.mjs), [live synthetic results](../benchmarks/results/complex-missions-v1/RESULTS.md) | Six live exact replays added no calls. Fresh adaptive routes all used JEV; warm-Luna selection and Astra escalation were tested with mocks. / 실측 정확 재생 6회는 추가 호출이 없었습니다. Luna 선택·Astra 위임은 모의 검증입니다. |
| Check task state before handing work to the host. / 인계 전 업무 상태를 확인합니다. | [Durable task contract](task-router.md), [handoff tests](../test/router-handoff.test.mjs) | Latest-known-revision checks belong to the durable handoff API. Adaptive cache alone does not enforce them. Neither API guarantees exactly-once worker execution. / 최신 revision 검사는 별도 업무 인계 API의 기능입니다. 작업자의 정확히 한 번 실행을 보장하지 않습니다. |
| Compare completed work and account for failures. / 완료와 실패 비용을 함께 비교합니다. | [Task-aligned video and attempt ledger](../benchmarks/results/browser-task-aligned-20260924/RESULTS.md), [synthetic comparison](../benchmarks/results/complex-missions-v1/RESULTS.md) | Astra completed 1/1 browser attempts; JEV completed 1/2. The video uses the completed pair. These small cases do not establish general superiority. / 브라우저 완주는 Astra 1/1, JEV 1/2이며 영상은 완주한 실행을 비교합니다. |
| Inspect cost provenance and unknown outcomes. / 비용 근거와 결과 미상을 구분합니다. | [Budget tests](../test/inference-budget.test.mjs), [task state tests](../test/router-task.test.mjs), [accounting ledger](../benchmarks/results/browser-task-aligned-20260924/accounting.json) | JEV uses token-price estimates; OpenRouter reports credit costs. Host inference, fees and tax are excluded. Unknown cost is not zero, and an estimated budget is not a prepaid cap. / 추정 비용·보고 비용·미확정 비용을 구분하며 카드 청구액을 보장하지 않습니다. |

## When to choose this / 선택 기준

Choose this repo when you already have an agent and a finite set of available workers or tools, and need to evaluate reuse, model choice, handoff state and observed workflow cost together. For durable task routing, start in shadow mode, inspect the recommendation against your existing route, then connect an allowed execution path through the host. Shadow mode calls the API and can cost money; the dry-run checks need no API key.

이미 사용하는 에이전트와 정해진 담당·도구 후보가 있고, 재사용·모델 선택·인계 상태·업무 비용을 함께 검토하려는 경우에 적합합니다. 업무 인계 API의 Shadow 모드로 기존 판단과 추천을 비교한 뒤 허용된 실행 경로를 호스트에 연결합니다. Shadow는 유료 호출을 하며, dry-run 형식 검사는 키 없이 가능합니다.

For a game controller, a direct typed-judgment connector, a native Codex model relay, PR workflows or coding completion hooks, the corresponding projects above have a more specialized scope. This repository includes Codex/Claude skill installation and browser adapters, but actual Claude browser integration and Grok integration have not been validated. See [English setup](INSTALL.en.md) / [한국어 설치](INSTALL.ko.md).

게임 제어·구조화된 판단 연결·Codex 모델 릴레이·PR 업무·코딩 완료 후크 자체가 목적이면 위의 해당 프로젝트가 그 용도에 더 특화돼 있습니다. 이 저장소에는 Codex·Claude용 스킬 설치와 브라우저 어댑터가 있지만, Claude 브라우저·Grok 실기 검증은 아직 남아 있습니다.
