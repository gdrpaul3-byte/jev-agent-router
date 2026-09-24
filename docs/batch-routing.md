# 독립 업무의 배치 분류

`decideRouteBatch`는 서로 독립적인 업무 1–16개의 다음 경로를 하나의 TypeSafe 요청에서 고르는 Node API다. 뉴스·브랜드 관련성을 먼저 분류하고, 적합한 항목만 조사·작성 담당에게 넘기는 용도로 쓸 수 있다. 호스트가 실제 이용 가능한 경로와 자료를 입력한다.

이번 추가는 `shadow` 미리보기와 입력 검사용 `dry-run`이다. 항목별 실행 인계나 worker 호출은 하지 않는다. 기존 `runRoutingTask`의 영속 예산·재호출 방지와 별도인 순수 API이므로, 같은 배치를 다시 보내면 새 유료 요청이다. 요청 수명·중복 방지는 호출 호스트가 관리해야 한다. `active`는 거부한다.

## 호출

`computer-use`를 작업 디렉터리로 둔 Node.js 24 이상의 ESM 코드다. `inputs`의 각 항목은 기존 [업무 입력 계약](task-router.md)과 같고, task ID가 고유해야 한다.

```javascript
import { decideRouteBatch, loadApiKey } from './src/index.mjs';

const checked = await decideRouteBatch(inputs, {
  config: { mode: 'dry-run', maxInputBytes: 60000 },
});
if (checked.status !== 'dry_run') throw new Error(checked.reason);

const apiKey = await loadApiKey({ envFile: '.env' });
const result = await decideRouteBatch(inputs, {
  apiKey,
  config: { mode: 'shadow', maxInputBytes: 60000, timeoutMs: 10000 },
});
// Inspect result.status, result.decisions, result.cost and result.requests.
```

요청 크기 제한은 **배치 전체의 UTF-8 바이트**에 적용한다. 기본값은 24,000바이트다. 위처럼 명시적으로 60,000바이트를 사용할 수 있으며 상한은 기존 계약의 100,000바이트다. 고정 모델은 `jev-1.13.0`이다. `maxCalls:0`이면 호출하지 않지만 양수 값이 지속적인 호출 한도를 만드는 것은 아니다. 한 번의 함수 호출은 최대 한 번의 POST만 수행한다.

`status:'decided'`면 각 `decisions` 항목이 `selected` 또는 `needs_host`다. 모델이 한 항목을 잘못 반환하면 그 항목을 보류한다. 공유 응답의 model/usage가 잘못됐거나 요청하지 않은 질문 ID가 있으면 배치 전체를 거부한다. Timeout·HTTP 오류를 자동 재시도하지 않는다.

## 동일 관측에서만 묶기

각 질문은 자신의 task/progress/evidence와 실제 경로만 판단하도록 구성된다. 예를 들어 독립된 기사 12개의 다음 담당을 분류할 수 있다. 한 기사에서 조사 결과를 기다린 다음 초안을 작성해야 한다면 조사와 작성 판단을 같은 배치에 미리 넣으면 안 된다. 새 결과를 관측한 다음 다시 판단한다.

한 배치의 상태는 한 API 요청에 함께 전달된다. 질문별 지시는 데이터 접근의 격리 장치가 아니므로 서로 공개하면 안 되는 사용자·조직의 자료를 한 배치에 섞지 않는다. 호스트가 동일한 전송 범위 안에서 묶을 자료만 선택한다.

`selected`는 추천이다. 실제 도구 실행은 호스트가 현재 가용성과 기존 사용자 권한을 확인하고 수행한다. 쓰기 경로가 선택되면 `requiresHostApproval:true`가 유지된다. 요약이나 홍보 문구 생성은 분류 이후 별도 담당에게 맡긴다.

## 비용·품질 평가

공급자가 보고한 사용량과 비용 추정은 `cost`·`requests`에 **배치 전체로 한 번만** 기록한다. 항목별 토큰이나 비용은 제공자가 주지 않으므로 만들지 않는다. 비용이 없는 항목 필드를 0원으로 해석하지 않는다. usage 미확정은 `null`로 남긴다.

`latencyMs`는 입력 검사, 응답 JSON, 제한된 계측 정리를 포함한 배치 전체 시간이다. 기사 수집·본문 검증·초안 생성·게시까지의 업무 완료 시간이 아니다. 단건 순차 방식과 같은 입력·모델·임계값으로 비교하고, 오분류·보류·누락·실패 및 후속 조사/작성 비용을 함께 봐야 한다.

공개 NewsJack 데모는 typed 질문과 후속 필터의 유용한 예시다. 검토 기록 (historical local reference; not included in this release)에 모의/실제 실행 모드 및 품질 한계를 구분했다. 배치가 더 빠르거나 저렴하더라도 후보를 잘못 버리거나 불필요한 후속 작업을 늘릴 수 있으므로 홍보 배수를 그대로 사용하지 않는다.

## 후속 실전 목표

실제 TypeSafe 호출의 JEV 단건 순차 vs JEV 배치: 12건 × 2회 결과 (historical local reference; not included in this release)에 속도·비용·오류를 함께 기록했다. 두 방식 모두 JEV이며 LLM만 사용하는 대조군은 없다. 재현 실행기는 `benchmarks/news-triage-eval.mjs`이며 `--live`와 새 `--output` 경로를 명시해야 한다. 기존 보고서를 덮어쓰지 않고, 하나의 실험 전체에서 최대 26회 POST만 허용한다. LLM 대조군과의 별도 비교 (historical local reference; not included in this release)는 같은 입력의 배치 단위를 맞춰 새로 실행한다.

1. **실행·검증 기록:** 호스트의 실제 실행 시도와 산출물 버전에 검증 조건을 연결한다. `selected`·`handoff_ready`를 업무 완료로 표시하지 않는다. Canny 등 조사 (historical local reference; not included in this release)의 적용 지점이다.
2. **영속 배치 큐:** 요청 단위 비용과 항목 단위 진행 상태를 분리하고, 짧은 예약·커밋 잠금, 공유 호출 상한, 제한된 동시성, 미확정 호출 복구를 검증한다. 새 디렉터리마다 예산을 초기화해 병렬화하지 않는다.
3. **공통 호스트 도구:** 위 상태 계층을 호출하는 `route_task`/`read_handoff` MCP 어댑터를 Codex·Claude에 연결한다. Claude 실기 검증은 사용자가 재개할 때 수행하고 Grok은 연결이 복구된 뒤 적용한다.
4. **실제 업무 비교:** 공개 자료를 읽는 업무에서 사람 검토 기준의 후보 누락률과 전체 완료율, 후속 모델 사용량을 비교한다. 현재 합성 분류 실험만으로 전체 운영 비용 절감을 주장하지 않는다.
