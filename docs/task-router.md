# JEV 업무 라우터

호스트가 업무, 현재 증거, 실행 가능한 담당·도구 목록을 전달하면 JEV가 다음 경로의 ID를 선택합니다. Codex·Claude 등 셸을 사용할 수 있는 호스트에서 같은 JSON 명령을 호출할 수 있습니다. Grok Bot에도 런타임과 키를 배치한 뒤 이 인터페이스를 연결할 수 있지만, 실제 Claude·Grok 연동 검증을 대신하는 것은 아닙니다.

이 명령은 **선택 결과와 로컬 인계 파일만 생성**합니다. 봇에 메시지를 보내거나, 브라우저를 조작하거나, 선택된 업무를 자동 실행하지 않습니다. 사용 가능한 도구와 실행 권한은 호스트가 결정합니다.

## 빠른 시작

Node.js 24 이상을 사용하고 `computer-use` 디렉터리에서 실행합니다. 명령에는 운영체제별 절대 경로나 특정 계정 경로가 들어가지 않습니다.

먼저 키와 네트워크 없이 입력을 검사합니다.

```sh
node -- src/router-cli.mjs route --input examples/router-task.json --config examples/router-config.json --mode dry-run
```

유효한 입력이면 `status:"dry_run"`, 후보 ID와 요청 크기를 반환합니다. 이 모드는 상태 파일도 생성하지 않습니다.

실제 JEV 선택을 기존 호스트 판단과 비교하려면 `TYPESAFE_API_KEY` 환경변수를 설정하거나, 직접 지정한 비공개 환경 파일을 사용합니다. 키를 명령줄 인수나 업무 JSON에 넣지 마세요. 환경 파일의 자동 검색은 하지 않습니다.

```sh
node -- src/router-cli.mjs route --input examples/router-task.json --config examples/router-config.json --state-dir .jev-router --env-file .env
```

예제 설정은 `shadow`입니다. **Shadow도 실제 TypeSafe API를 호출하므로 비용이 발생**합니다. `recommendationId`는 JEV의 추천이고 `effectiveRouteId`는 기존 `baselineRouteId`입니다. 인계 파일은 만들지 않습니다.

실제 추천을 로컬 인계 파일로 만들려면 명시적으로 모드를 바꿉니다.

```sh
node -- src/router-cli.mjs route --input examples/router-task.json --config examples/router-config.json --mode active --state-dir .jev-router --env-file .env
```

`--mode`는 설정 파일의 모드보다 우선합니다. 같은 업무·revision이라도 shadow와 active는 별개의 결정이므로 각각 호출과 비용이 생깁니다. `--config`와 `--env-file`은 선택 사항입니다. `--input`을 생략하거나 `--input -`를 사용하면 JSON을 표준 입력에서 읽습니다.

```sh
node -- src/router-cli.mjs --help
```

모든 출력은 표준 출력의 JSON 한 줄입니다. 성공 상태 `ready`, `shadow`, `dry_run`, `bypassed`는 종료 코드 0이고, `needs_host`, `review_required`는 2입니다. 알 수 없는 명령·옵션, 중복 옵션, 값이 빠진 옵션을 거부합니다. 업무·설정 파일과 표준 입력은 각각 UTF-8 기준 1,000,000바이트 이하로 제한합니다. 별도로 실제 API 요청에는 `maxInputBytes` 제한이 적용됩니다. 오류 출력에 원문, 키, 내부 예외 메시지를 넣지 않습니다.

## 업무와 경로 정의

[예제 업무](../examples/router-task.json)는 공개 자료 조사 → 내부 초안 → 검토 흐름입니다. 실제 호스트에서 사용할 수 있는 도구만 `available:true`로 전달하세요. 예제의 외부 게시 경로는 사용할 수 없는 상태입니다.

| 필드 | 의미 |
| --- | --- |
| `task.id` | 업무의 고정 ID |
| `task.revision` | 증거·진행 상태·후보가 바뀔 때 올리는 0 이상의 정수 |
| `task.request` | 달성할 업무 |
| `task.progress` | 현재 진행 상태; 생략 시 빈 문자열 |
| `task.evidence` | ID와 텍스트로 구성한 증거 목록; 최대 64개 |
| `routes` | 실제 이용 가능한 담당·도구의 설명; 1–32개 |
| `baselineRouteId` | JEV 없이 호스트가 택할 이용 가능한 경로 |

업무·증거·경로 ID는 영문자로 시작하는 영문·숫자·밑줄·하이픈 1–64자입니다. `NONE`, `__proto__`, `prototype`, `constructor`는 예약값입니다. 경로 `kind`는 `read`, `draft`, `write` 중 하나이며, 실제 권한을 정확히 반영해야 합니다. `available`은 기본 true, `requiresApproval`은 기본 false입니다. **`write`는 설정과 관계없이 호스트 승인이 필요**합니다. 이용 불가능한 경로는 모델 후보에서 제외됩니다. 알 수 없는 입력·설정 필드도 거부합니다.

업무와 증거는 신뢰할 수 없는 자료로 취급합니다. 그 안의 지시문이 새 도구를 추가하거나 실행 권한을 확대할 수 없습니다. 모델에 전달해도 되는 범위의 자료만 호스트가 선택해 제공해야 합니다.

## 모드와 실행 경계

| 모드 / 결과 | API 호출 | 다음 단계 |
| --- | --- | --- |
| `dry-run` / `dry_run` | 없음 | 요청 형식·후보·크기 확인 |
| `enabled:false` / `bypassed` | 없음 | 기존 baseline 유지, 인계 파일 없음 |
| `shadow` / `shadow` | 최대 1회 | 추천과 baseline 비교, 인계 파일 없음 |
| `active` / `ready` | 최대 1회 | 승인 불필요 read/draft의 로컬 인계 파일 검토 |
| `active` / `review_required` | 최대 1회 | write 또는 승인 필요 경로를 호스트가 검토; ready 인계 없음 |
| `needs_host` | 상황에 따라 0–1회 | 불확실성·실패·예산·상태 문제를 호스트가 처리 |

`ready`는 **업무 실행 완료나 권한 부여를 뜻하지 않습니다**. 인계 파일은 `executionStatus:"not_started"`, `requiresFreshHostValidation:true`와 상태 레코드 키·fingerprint를 담습니다. 호스트는 파일만 발견했다고 실행하면 안 됩니다. 해당 파일과 **일치하는 완료된 상태 원장 레코드**를 확인하고, 최신 도구 가용성과 사용자 권한을 다시 검증한 뒤 기존 실행 도구로 작업합니다. 실행 결과는 별도로 기록해야 합니다. 이 버전은 작업자의 인계 선점이나 정확히 한 번 실행을 보장하지 않습니다.

`requiresHostApproval`은 `effectiveRouteId`에, `recommendationRequiresHostApproval`은 JEV 추천에 대응합니다. Shadow/bypassed에서 baseline이 외부 쓰기라면 그 승인 조건도 유지됩니다. 이 플래그와 무관하게 모델 추천이 새 실행 권한을 부여하지는 않습니다.

## 비공개 상태, 재호출과 예산

`--state-dir`은 dry-run/disabled를 제외하고 필수입니다. 이 디렉터리는 같은 라우팅 작업의 재호출과 호출 수 제한을 유지하는 영속 상태입니다. 일회성 임시 디렉터리를 매번 만들면 같은 업무의 중복 과금 방지를 공유할 수 없습니다. 작업 내용이 담긴 인계 파일이 있으므로 접근 권한을 제한하고 Git·공개 결과물에서 제외하세요.

- 같은 업무 ID·revision·mode와 동일한 검증 입력·설정으로 재호출하면 저장한 결과를 반환합니다. `replayed:true`이며 새 API 호출은 없습니다.
- 같은 ID·revision·mode에서 입력 또는 설정을 바꾸면 `TASK_REVISION_CONFLICT`입니다. 증거·가용성·설정을 의도적으로 바꿨다면 revision을 올리세요.
- 키 검증 후, 네트워크 호출 전에 pending 예약과 시도 횟수를 저장합니다. 호출 도중 프로세스가 종료되면 `TASK_OUTCOME_UNKNOWN`으로 호스트에게 넘깁니다. 유료 요청을 자동 반복하지 않습니다.
- 결정과 인계 내용을 상태 원장에 먼저 커밋한 다음 인계 파일을 생성합니다. 파일 생성 전에 중단되었다면 동일 요청의 replay로 누락된 파일을 복구할 수 있으며 JEV를 다시 호출하지 않습니다.
- 동일 상태 디렉터리를 동시에 사용하면 한 프로세스만 잠금을 획득합니다. 나머지는 `STATE_BUSY`입니다. **오래된 잠금도 자동으로 탈취·삭제하지 않습니다.** 실제 소유 프로세스와 pending 기록을 확인하는 운영자 복구가 필요합니다. 새 상태 디렉터리로 우회하면 기존 예산·미확정 호출 기록을 잃습니다.
- `maxCalls`는 디렉터리에 영속하는 API **시도 횟수 제한**입니다. 실패와 결과 미확정 호출도 포함하며, 달러 기준 지출 한도가 아닙니다. 타임아웃도 자동 재시도하지 않습니다.

기본값은 shadow, 고정 모델 `jev-1.13.0`, 타임아웃 5초, 최대 시도 100회, 요청 크기 24,000바이트, 최소 신뢰도 0.75, 최소 1·2위 차이 0.10입니다. [예제 설정](../examples/router-config.json)은 호출 상한을 20회로 줄였습니다. `jev-latest`를 명시적으로 선택할 수 있지만 비교 실험에서는 모델 버전을 고정하는 편이 해석하기 쉽습니다.

잠금 복구 시에는 먼저 해당 상태 디렉터리를 쓰는 프로세스가 모두 종료됐는지 확인하고 `.lock`만 제거합니다. `state.json`, pending 레코드와 인계 파일은 유지하세요. `TASK_OUTCOME_UNKNOWN`은 자동 재호출하지 말고 기존 시도의 결과를 확인한 뒤 호스트가 새 revision 여부를 결정합니다. `maxCalls`를 명시적으로 높이면 그 디렉터리의 허용 상한도 높아집니다.

원장은 `state.json`이며 16 MiB까지 지원합니다. 프로세스 중단 시 복구를 위한 저장 방식이고 전원 장애까지의 내구성을 보장하지 않습니다. 인계 파일은 동기화한 임시 파일을 하드 링크로 원자적으로 게시하므로 이를 지원하는 로컬 파일시스템이 필요합니다. 지원하지 않으면 `HANDOFF_WRITE_FAILED`로 중단하고 이미 받은 결정은 원장에 보존합니다. 원장에도 업무와 증거가 포함되므로 상태 디렉터리 전체를 비공개로 관리하세요.

## 비용과 검증

`cost`와 `requests`는 **이번 호출**의 비용 추정·요청 기록입니다. Replay는 이번 호출 비용과 새 요청 수가 0입니다. 원래 유료 결정의 비용·요청 정보는 `decisionCost`, `decisionRequests`에 남습니다. 제공자의 usage를 받지 못하면 비용은 **`null`(알 수 없음)**입니다. 실패했으니 무료였다고 간주하지 않습니다. 알려진 부분 합계와 전체 추정은 구분해서 읽어야 합니다.

입력 토큰 기반 추정은 실제 청구서와 구분해야 합니다. 호스트 Codex·Claude·Grok의 추론 비용이나 후속 도구 비용까지 측정한 값은 아닙니다. Shadow에서 같은 업무의 baseline, 추천, 이후 성공 여부, 전체 소요 시간과 호스트 비용을 함께 모은 뒤 active 적용 범위를 넓히세요. 기권을 정답 처리하거나 JEV 호출 시간만으로 전체 업무 속도 향상을 주장하지 마세요.

한국어 합성 업무의 실제 API 결과와 재현 명령은 평가 보고서 (historical local reference; not included in this release)에 있습니다. 키 없이 전체 검사는 `npm run test:all`로 실행합니다. 별도 opt-in 평가기는 `benchmarks/task-router-eval.mjs`이며, 기본 shadow로 모든 선택·보류·오류를 기록하고 기존 보고서 덮어쓰기를 거부합니다.

이 기능의 실전 범위는 **호스트가 허용한 유한 후보에서 다음 담당·도구를 고르는 로컬 라우터**입니다. 연결되지 않은 봇을 제어하거나 범용 자율 업무 수행을 검증한 상태가 아닙니다.

## 키 없이 인계 내용 검증하기

Active에서 결정과 인계 파일을 이미 생성했다면 `handoff` 명령으로 **현재 업무 입력·설정, 완료된 원장 레코드, 인계 파일이 모두 일치하는지** 확인하고 검증된 내용을 읽습니다.

```sh
node -- src/router-cli.mjs handoff --input examples/router-task.json --config examples/router-config.json --mode active --state-dir .jev-router
```

처음 `route --mode active`에 사용한 동일 업무·revision·설정을 전달해야 합니다. 설정 파일이 이미 `mode:"active"`이면 `--mode`는 생략할 수 있습니다. `enabled`는 true여야 하고 명시적 `--state-dir`은 항상 필요합니다. 업무나 도구 가용성을 바꾸면 이전 인계를 그대로 사용할 수 없습니다.

같은 업무 ID에 더 높은 revision이 원장에 예약되거나 완료되어 있으면, 과거 입력을 그대로 다시 전달해도 `STALE_TASK_REVISION`으로 중단합니다. 새 증거가 반영된 업무가 있는데 오래된 인계를 실행하는 일을 막기 위한 검사입니다.

이 명령은 **API·키·환경 파일을 사용하지 않습니다**. `--env-file`을 거부하며 상태 디렉터리 생성, 유료 호출 예약, 누락 파일 복구도 하지 않습니다. 파일이 없으면 호스트에게 제어를 돌려줍니다. 복구가 필요할 때만 호스트가 동일 입력으로 `route`의 replay를 명시적으로 실행할지 결정합니다. `handoff`가 자동으로 `route`를 호출하지 않습니다.

성공하면 `status:"handoff_ready"`와 검증된 `handoff`를 반환하며 종료 코드는 0입니다. 업무는 `result.handoff.task`, 선택 경로는 `result.handoff.route`에서 읽습니다. 업무와 증거가 포함되므로 이 명령의 표준 출력도 비공개로 관리하세요. 실패는 `needs_host`, 종료 코드 2이고 업무 내용을 반환하지 않습니다. `cost`는 새 호출 비용 0, `requests`는 빈 배열이며 원래 결정의 비용·요청은 `decisionCost`, `decisionRequests`로 보존합니다.

`replayed:true`, `requiresFreshHostValidation:true`, `executionClaimed:false`는 저장된 결정을 읽었다는 뜻입니다. 이 명령은 작업을 선점하거나 실행하지 않습니다. 성공 후에도 호스트는 최신 권한과 도구 가용성을 확인하고, 중복 실행 방지와 실행 기록을 별도로 관리해야 합니다.
