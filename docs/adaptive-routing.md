# 캐시를 고려하는 JEV·Luna·Astra 라우터

`runAdaptiveRoute`는 현재 업무와 근거를 보고 다음 담당·도구를 **권고**합니다. Codex나 Claude처럼 로컬 명령을 실행할 수 있는 호스트에서 같은 JSON CLI를 사용할 수 있습니다. 실제 도구 실행이나 승인 처리는 호스트의 역할입니다. Claude 실기와 Grok 연결 검증은 이 기능의 검증 범위에 포함하지 않습니다.

## 실행

`jev` 폴더 기준, Node.js 24 이상:

```powershell
# 키·파일 상태·네트워크 없이 입력과 기본 선택 확인
node -- ./src/adaptive-router-cli.mjs --preflight --input ./examples/adaptive-router-task.json --config ./examples/adaptive-router-config.json

# 실제 권고: .env의 TYPESAFE_API_KEY / OPENROUTER_API_KEY 사용
node --use-system-ca -- ./src/adaptive-router-cli.mjs --live --input ./examples/adaptive-router-task.json --config ./examples/adaptive-router-config.json --state-dir ./.jev-router-adaptive --env-file ./.env
```

`--live`의 새 판단은 API 비용이 발생합니다. 시스템 CA 옵션은 Windows의 신뢰 인증서를 추가하며 TLS 검증을 끄지 않습니다. 키나 개인정보를 공개 저장소에 넣지 않습니다.

## 처리 흐름

1. 입력·정책·가용 도구·승인 조건·모델 설정이 일치하고 TTL 안에 있는 저장된 권고를 재사용합니다. 이 호출의 요청 수·비용은 0이며 원래 결정의 비용은 별도 필드에 남습니다.
2. `strategy: "adaptive"`에서 `difficulty: "complex"`이면 Astra를 선택합니다. 고정 strategy는 지정한 모델을 사용합니다. 난도는 신뢰할 수 있는 호스트가 지정하는 값이며, 입력 문서 속 지시로 변경하지 않습니다.
3. 일반 업무에서는 JEV를 기본으로 사용합니다. 같은 범위·정책의 Luna 캐시 관측 또는 호스트가 제공한 유효한 추정치가 있으면 예상 비용과 시간의 가중 합으로 비교합니다.
4. 적응형 경로에서 JEV 또는 Luna가 의미상 판단을 보류하면 설정된 호출·예상 비용 한도 안에서 Astra에 한 번 위임할 수 있습니다. 네트워크 실패·결과 미상은 자동 재시도하지 않습니다.

`strategy`는 `adaptive`, `jev`, `luna`, `astra` 중 하나입니다. `latencyWeightUsdPerSecond`는 시간을 얼마나 중요하게 보는지 정합니다. 기본 예상 단가는 선택을 시작하기 위한 보수적인 설정값이며 실측 가격이 아닙니다. 실제 비용은 응답의 사용량·크레딧 차감에서 별도로 기록합니다.

JEV를 제외하고 Luna의 로컬 관측이 필요한 설정에서는 오프라인 결과가 `selection:null`, `requiresObservation:true`일 수 있습니다. 실제 실행 단계가 상태를 읽어 유효한 관측이 있는지 확인하며, 없으면 API 호출 없이 `NO_ELIGIBLE_PROVIDER`로 반환합니다. 오프라인 사전 검사는 모델 호출 가능성이나 캐시 적중을 보장하지 않습니다.

## 캐시와 관측

결과 캐시는 동일 입력 재생이며 의미가 비슷한 다른 질문의 답을 가져오지 않습니다. namespace와 scope로 작업 범위를 구분하고, 근거·도구 가용성·정책 변화나 TTL 만료 시 다시 판단합니다. 외부 사이트나 문서가 바뀌었다는 사실은 호스트가 최신 근거로 전달해야 합니다.

revision도 입력 일치 여부에 포함되지만 이 API는 최신 revision만 허용하는 원장이 아닙니다. 오래된 스냅샷을 다시 전달하면 TTL 안에 있는 그 스냅샷의 권고가 재생될 수 있습니다. 최신 작업 revision의 강제 검증이 필요한 실행 인계에는 기존 `runRoutingTask`/`readReadyHandoff`를 유지하고, 현재 상태·권한을 실행 전에 재확인합니다.

프롬프트 캐시는 답 재사용과 다릅니다. 고정 정책·기준 뒤에 명시적 캐시 경계를 두고 동적 업무 입력을 이어 붙입니다. 모델·공급자·스키마·접두부가 달라지면 캐시 사용도 달라질 수 있습니다. `providerCacheHitConfirmed:false`는 호출 전 적중을 보장하지 않는다는 의미입니다.

같은 namespace/scope에서 확보한 JEV의 실제 입력 사용량에 따른 비용 추정과 Luna의 캐시 사용량·보고 크레딧 비용을 함께 비교합니다. 초기 JEV 예상 단가가 실제보다 높다는 이유만으로 더 비싼 Luna를 선택하지 않도록 양쪽 관측을 사용합니다. `selection.estimateBasis`로 기본 예상값·호스트 추정·JEV 정가 추정·OpenRouter 보고 비용을 구분합니다.

관측은 상태 파일에 저장되고, 오래됐거나 미래 시각이거나 정책·모델 설정이 맞지 않으면 사용하지 않습니다. 특정 공급자의 명시적인 호스트 추정값이 있으면 그 공급자의 관측보다 우선합니다. 관측 수집을 위한 별도 유료 호출은 자동으로 만들지 않습니다. 실제 정확도 보정이나 자동 난도 학습을 완료한 시스템은 아닙니다.

`maxCalls`는 한 판단의 실제 POST 수를 제한합니다. `budgetUsd`는 예상 비용에 따른 발송 제한이며 공급자의 선불 결제 한도가 아닙니다. 전체 실험에는 별도 `createInferenceBudget`가 요청별 보수적 예약·모든 호출의 비용 기록·미확정 비용 후 중단을 적용합니다. JEV 정가 추정, OpenRouter 계정 크레딧 차감, 카드 청구액은 서로 구분합니다.

## 복잡한 전체 업무 평가

```powershell
node --use-system-ca -- ./benchmarks/complex-mission-eval.mjs --preflight
node --use-system-ca -- ./benchmarks/complex-mission-eval.mjs --live --env-file ./.env --output ./benchmarks/results/new-complex-run/report.json --budget-usd 5 --max-requests 80
```

기존 출력 파일은 덮어쓰지 않습니다. 합성 장학·공공 지원사업 업무에서 세 번의 근거 자료 선택 뒤 Astra가 최종 산출물을 작성합니다. 대조군은 Astra만 사용, Luna+Astra, 적응형 선택+Astra입니다. 모든 방식에 같은 프롬프트 캐시와 정확 결과 재사용 기회를 줍니다. 첫 실행, 결정적 근거 변경, 원본의 정확 재생을 나누며 모든 선택·상승·최종 생성 비용과 시간을 합산합니다.

선정·계산·마감·승인·선행 조건과 근거 인용을 결정론적으로 채점합니다. 정답은 모델에 보내지 않고, 모델 출력으로 정답을 수정하거나 답안 힌트를 주는 재시도를 하지 않습니다. 작은 합성 개발 평가이며 실제 업무 정확도나 일반적인 속도 우월성을 입증하지 않습니다. [설계와 검증 범위](adaptive-routing-design.md)를 참고하세요.

[실제 비교 결과](../benchmarks/results/complex-missions-v1/RESULTS.md)와 [인용 평가의 해석](../benchmarks/results/complex-missions-v1/INTERPRETATION.md)을 보존했습니다. 실측 후에는 양쪽 모델 비용 관측 비교와 모델 제외 설정을 보강했고, 전체 자동 검사 **722개 통과, 실패 0** 및 기존 실측 캐시의 무호출 호환성을 확인했습니다. 이 보강은 추가 유료 호출 없이 모의 HTTP와 로컬 상태로 검증했습니다.
