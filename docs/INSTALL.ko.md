# 설치와 로컬 사용 안내

[README](../README.md) · [English](INSTALL.en.md)

이 실행 엔진은 호스트가 허용한 후보 중 다음 경로를 권고합니다. 선택된 작업자를 직접 실행하거나 외부 작업을 승인하지는 않습니다. 이 문서의 모든 명령은 저장소 루트 기준입니다. 바로 아래에 `src/`, `examples/`, `benchmarks/`가 있어야 합니다.

## 1. 실행 환경 준비

**Node.js 24 이상**과 npm이 필요합니다. Git으로 복제하거나 저장소 ZIP을 받아도 됩니다. 자동 검사는 Windows에서 실행했습니다. CLI는 Node API를 사용하지만, 모든 운영체제의 실제 브라우저 연동까지 검증했다는 의미는 아닙니다.

```sh
git clone https://github.com/gdrpaul3-byte/jev-agent-router.git
cd jev-agent-router
node --version
npm --version
npm ci
```

스킬을 설치한 뒤에는 저장소 경로를 유지하는 편이 좋습니다. `npm ci`는 포함된 lockfile대로 의존성을 설치합니다. 선택 의존성 `playwright-core`는 브라우저를 내려받지 않습니다. 업무 라우팅과 복잡한 임무 평가에는 브라우저가 필요하지 않습니다.

키 없이 먼저 검사합니다.

```sh
npm run test:all
npm run doctor
npm run demo
node -- src/adaptive-router-cli.mjs --preflight --input examples/adaptive-router-task.json --config examples/adaptive-router-config.json
node --use-system-ca -- benchmarks/complex-mission-eval.mjs --preflight
```

`demo`는 가짜 관측과 가짜 모델 응답을 사용합니다. Preflight는 키·네트워크·실행 상태 없이 요청과 설정을 검사합니다. 계정의 실제 호출 가능 여부나 공급자 캐시 적중을 보장하지 않습니다. `doctor`도 설치 상태를 보는 로컬 진단이며 실제 모델 호출 검사가 아닙니다.

현재 공개 준비 버전의 자동 검사는 734개 통과, 실패 0입니다. 보존된 실측 후 검증 기록은 당시 버전의 722개 검사 결과입니다. 현재 설치한 버전은 직접 실행한 `npm run test:all` 결과로 확인하세요.

## 2. API 키를 비공개로 설정

| 환경변수 | 용도 | 발급·관리 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | TypeSafe 직접 API를 통한 JEV | [TypeSafe 콘솔](https://console.typesafe.ai/keys) |
| `OPENROUTER_API_KEY` | OpenRouter를 통한 Luna/Astra | [OpenRouter 키](https://openrouter.ai/keys) |
| `OPENAI_API_KEY` | 별도의 OpenAI 직접 호출 대조 실험 | 이 안내의 실행에는 불필요 |

서로 다른 공급자의 키를 바꿔 쓸 수 없습니다. Codex·Claude 로그인이나 구독 결제가 이 키들을 대신 설정해 주지는 않습니다. 유료 실행 전에 각 공급자 콘솔의 잔액과 결제 조건을 확인하세요. 조직 키는 개인 계정보다 넓은 범위를 가질 수 있으므로 발급 콘솔에서 권한과 폐기를 관리합니다.

기존 `.env`가 없을 때만 예제 파일을 복사합니다.

PowerShell:

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
notepad .env
```

macOS/Linux 셸:

```sh
if [ ! -e .env ]; then cp .env.example .env; fi
# 원하는 로컬 편집기로 .env를 엽니다.
```

편집기에서 다음 두 항목에 각각 자신의 키를 넣고 저장합니다. 아래에는 실제 키 값을 넣지 않았습니다.

```dotenv
TYPESAFE_API_KEY=
OPENROUTER_API_KEY=
```

파일 내용을 채팅·이슈·녹화 화면·명령줄에 붙여 넣지 마세요. `.env`와 `.jev-router*/`는 Git에서 제외됩니다. 다른 이름으로 키 파일이나 상태 폴더를 만들면 그 경로도 별도로 제외해야 합니다. 아래 명령은 명시한 `--env-file`만 읽고 상위 폴더를 자동 검색하지 않습니다. 프로세스 환경변수가 파일보다 우선하므로 잘못 설정한 기존 환경변수가 올바른 파일 값을 가리지 않는지도 확인하세요.

## 3. 업무와 제한 확인

[예제 업무](../examples/adaptive-router-task.json)는 `research`, `draft`, 사용 불가 상태의 `publish` 중에서 고르는 요청입니다. 실제 호출 전에 파일을 읽고 어떤 근거가 공급자에게 전송되는지 확인합니다.

[예제 설정](../examples/adaptive-router-config.json)은 다음과 같습니다.

| 설정 | 예제 값 | 의미 |
| --- | --- | --- |
| `strategy` | `adaptive` | 난도와 유효한 예상값·관측으로 모델 선택. `jev`, `luna`, `astra` 고정도 가능 |
| `difficulty` | `routine` | 신뢰할 수 있는 호스트가 지정. 적응형에서 `complex`이면 Astra 선택 |
| `namespace`, `scope` | `local-assistant`, `internal-drafts` | 업무·캐시 범위 구분 |
| `ttlSeconds` | `300` | 정확히 일치하는 저장 권고의 유효 시간 |
| `maxCalls` | `2` | 허용된 상위 모델 위임을 포함해 판단 하나당 실제 POST 최대 2회 |
| `budgetUsd` | `0.2` | 예상 비용에 따른 호출 허용 기준. 공급자의 강제 결제 상한은 아님 |
| `timeoutMs` | `60000` | 요청 제한 시간 |
| `maxOutputTokens` | `1024` | LLM 출력 한도 |
| `cacheMode` | `prefix` | 어댑터의 고정 접두부 캐시 경계 사용 |

기본 비용 예상값은 실측 청구액이 아닌 초기 가정입니다. 같은 범위의 관측값이 선택을 보완하며, 호스트가 명시한 예상값이 있으면 우선합니다. 결과의 `selection`에서 예상값의 근거를 확인할 수 있습니다. 가져온 문서 안의 지시가 신뢰할 설정·가용 도구·실행 권한을 바꾸도록 허용하지 마세요.

## 4. 실제 권고 한 번 실행

이 단계는 공급자 비용이 발생할 수 있습니다. 비공개 상태를 저장하지만 선택된 경로 자체는 실행하지 않습니다.

```sh
node --use-system-ca -- src/adaptive-router-cli.mjs --live --input examples/adaptive-router-task.json --config examples/adaptive-router-config.json --state-dir .jev-router-adaptive --env-file .env
```

`--use-system-ca`는 운영체제의 신뢰 인증서를 사용하며 TLS 검증을 끄지 않습니다. CLI는 JSON 한 개를 출력합니다. 경로 선택은 종료 코드 `0`, `needs_host`는 `2`입니다.

결과를 사용하기 전에 다음 항목을 확인합니다.

- `status`, `reason`, `routeId`: 선택된 경로나 호스트가 다시 판단해야 하는 이유.
- `requiresHostApproval`: 쓰기 경로는 항상 승인이 필요합니다. false도 원래 없던 권한을 만들어 주지는 않습니다.
- `selection`, `attempts`: 선택 모델·예상값 출처와 실제 호출 관측.
- `requests`, `cost`: 이번 실행에서 새로 발생한 요청과 비용.
- `cacheHit`, `replayed`, `decisionRequests`, `decisionCost`: 정확 재생 여부와 원래 결과를 만들 때의 요청·비용.

TTL 안에 **동일한 파일과 동일한 명령**으로 다시 실행하면 정확 재생을 확인할 수 있습니다. 유효한 재생은 `cacheHit:true`, 신규 요청 0, 추가 공급자 비용 0입니다. 근거·도구·권한·설정이 바뀌거나 유효 시간이 지나면 새 판단이 필요할 수 있습니다. 과거 입력을 다시 전달했다고 외부 상황도 그대로라는 뜻은 아니므로 최신 근거는 호스트가 갱신해야 합니다.

적응형 캐시는 최신 revision만 허용하는 원장이 아닙니다. 과거 revision의 인계를 거부해야 한다면 아래의 별도 업무 라우터 흐름을 사용합니다.

## 5. Codex·Claude 스킬 설치

현재 저장소의 실행 엔진을 사용하는 절차를 설치합니다.

```sh
node -- scripts/install-skill.mjs --help
node -- scripts/install-skill.mjs --agent both --skill adaptive
```

하나만 사용할 때는 `--agent codex` 또는 `--agent claude`를 씁니다. 각 사용자 폴더의 `~/.codex/skills`, `~/.claude/skills`에 설치되며 적응형 스킬 이름은 `jev-adaptive-router`입니다. 설치기는 현재 저장소의 실행 엔진·문서·`.env` 절대 경로가 들어간 `SKILL.md`를 복사합니다. 키 내용이나 별도의 실행 엔진은 복사하지 않습니다. 설치 후 해당 저장소 경로를 유지하세요.

`--skill task-router`, `--skill browser`, `--skill claude-chrome`, `--skill all`도 사용할 수 있습니다. `claude-chrome`(`jev-claude-chrome`)은 Claude in Chrome 확장 도구를 쓰므로 Claude에만 설치됩니다. 따라서 `--skill all --agent both`는 Codex에 3개, Claude에 4개를 설치합니다. `--skill`을 생략하면 기존 브라우저 스킬만 설치합니다. 기존 스킬을 조용히 덮어쓰지 않으며, 같은 저장소에서 설치한 호환 스킬은 다음처럼 갱신합니다.

```sh
node -- scripts/install-skill.mjs --agent both --skill adaptive --update
```

업데이트 전에 선택한 대상들을 확인하고 백업합니다. 다른 실행 엔진 경로, 있어야 할 대상의 누락, 이미 존재하는 백업 때문에 멈출 수 있습니다. 다른 설치를 지우기 전에 원인을 확인하세요. 저장소를 옮겼다면 스킬도 새 위치에 맞게 재설치해야 하며, 과거 경로를 자동으로 바꾸지는 않습니다.

필요하면 호스트 세션을 다시 열어 스킬을 인식시킨 뒤 다음처럼 요청할 수 있습니다.

> jev-adaptive-router를 사용해서 이 업무의 다음 단계를 research 또는 draft 중에서 골라 줘. 먼저 오프라인 사전 검사를 하고 최신 근거를 사용해. 반환된 비용과 승인 조건을 확인한 뒤 내가 요청한 범위에서 기존 도구를 사용해.

호스트는 로컬 Node 명령을 실행하고 입력·설정 파일을 읽을 수 있어야 합니다. 스킬이 원격 봇 연결을 만들어 주지는 않습니다. Claude 로그인은 라우터 API 키와 별개입니다.

### Claude in Chrome

```sh
node -- scripts/install-skill.mjs --agent claude --skill claude-chrome
```

Claude Code를 `claude --chrome`으로 시작하고 `/chrome`으로 연결을 확인한 뒤 다음처럼 요청합니다.

> jev-claude-chrome으로 http://127.0.0.1:8776/ 데모 탭에서 Open library를 누르고 Read guide를 눌러 Workflow verified가 보이게 해 줘. 모든 시도와 JEV 비용을 보고해.

스킬은 비공개 세션 원장을 만들고, 공식 확장 도구로 탭을 관측하고, JEV에게 호스트가 허용한 동작 하나를 받아 한 번 실행한 뒤 새 관측으로 검증합니다. 2026-09-24에 로컬 예제 두 개로 실제 검증했습니다. [실측 결과](../benchmarks/results/claude-chrome-live-20260924/RESULTS.md)와 [브리지 계약](claude-chrome.md)을 참고하세요. 이 경로에는 `TYPESAFE_API_KEY`만 필요합니다. 동작 하나에 Claude 도구 호출이 여러 번 필요해 약 30–60초가 걸리며, 속도 이점은 주장하지 않습니다.

## 6. 선택 사항: 영속 인계

완료된 원장과 일치하는 로컬 인계 파일, 최신 revision 검사가 필요하면 업무 라우터를 사용합니다. `shadow`와 `active`는 별도 판단이므로 각각 JEV 호출·비용이 생길 수 있습니다. **Shadow는 오프라인 모드가 아닙니다.**

```sh
# 오프라인 입력 검사.
node -- src/router-cli.mjs route --input examples/router-task.json --config examples/router-config.json --mode dry-run

# 유료 판단. 허용된 경로에 한해 로컬 인계 파일 생성.
node --use-system-ca -- src/router-cli.mjs route --input examples/router-task.json --config examples/router-config.json --mode active --state-dir .jev-router --env-file .env

# 위 인계를 동일 입력·설정으로 오프라인 검증해 읽기.
node -- src/router-cli.mjs handoff --input examples/router-task.json --config examples/router-config.json --mode active --state-dir .jev-router
```

`handoff_ready`는 완료된 원장·현재 입력/설정·기록된 상위 revision과 파일을 대조한 결과입니다. 작업을 선점하거나 정확히 한 번 실행을 보장하지 않습니다. 호스트는 현재 권한을 다시 확인하고 실행 기록을 따로 남겨야 합니다. [업무 라우터 상세](task-router.md)를 참고하세요.

## 7. 복잡한 임무 실측 재현

공개된 [결과](../benchmarks/results/complex-missions-v1/RESULTS.md)와 [원자료](../benchmarks/results/complex-missions-v1/report.json)는 키 없이 읽을 수 있습니다. 입력은 합성 자료이며 정답은 유료 호출 전에 고정했습니다.

```sh
# 오프라인 검사.
node --use-system-ca -- benchmarks/complex-mission-eval.mjs --preflight

# 유료 재현. 실행마다 새로운 출력 경로를 사용합니다.
node --use-system-ca -- benchmarks/complex-mission-eval.mjs --live --env-file .env --output benchmarks/results/my-complex-run/report.json --budget-usd 5 --max-requests 80
```

Astra+Astra, Luna+Astra, 적응형+Astra를 기본형·근거 변경형·정확 반복 조건으로 실행해 총 18개 업무 기록을 만듭니다. 로컬 근거와 분석 산출물만 사용하며 로그인·브라우저 조작·외부 신청·게시는 하지 않습니다. 진행 상황 대시보드와 녹화 방법은 [데모 안내](DEMO.ko.md)를 참고하세요.

공개 실행은 실제 POST 36회, 명시된 비용 범위에서 $0.69347572를 사용했습니다. 재실행의 시간·출력·캐시 적중·비용은 달라질 수 있습니다. `$5` 설정은 발송 전 보수적인 예상 비용을 예약하는 한도이며 공급자에서 강제하는 선불 한도는 아닙니다. 비용이 불명확하면 다음 발송을 중단합니다. 기존 출력 파일을 덮어쓰지 않으며 보고서와 manifest를 실패 기록까지 함께 보관합니다. 실제 결과를 본 뒤 고정 정답을 바꾸지 마세요.

정확 재생 행의 `synthesis.usage`는 원래 결과의 사용량을 보존한 메타데이터입니다. 새 소비량은 최상위 실행 요청·비용으로 확인합니다. 평가기의 전체 업무 결과 캐시는 프로세스 안의 메모리이고, 제품의 개별 권고 캐시는 비공개 상태 파일에 저장됩니다.

## 문제 해결

| 결과·증상 | 확인할 내용 |
| --- | --- |
| `MISSING_API_KEY` | 키 이름과 명시한 `.env` 경로를 로컬에서 확인합니다. 기존 환경변수도 확인하되 키를 출력하지 않습니다. |
| HTTP 인증·결제 오류 | 해당 공급자의 키·잔액·모델 접근을 콘솔에서 확인합니다. OpenRouter 키를 OpenAI 직접 주소에 보내면 안 됩니다. |
| `INVALID_INPUT`, `INVALID_CONFIG`, preflight 실패 | 포함된 예제와 JSON을 비교합니다. 알 수 없는 필드와 범위를 벗어난 제한은 거부됩니다. |
| `STATE_BUSY` | 다른 프로세스가 상태 잠금을 잡았을 수 있습니다. 기다리거나 소유자를 확인하고 실행 중 잠금은 지우지 않습니다. |
| `TASK_OUTCOME_UNKNOWN` 또는 과거 시도 검토 요청 | 이전 요청이 이미 과금됐을 수 있습니다. 상태와 공급자 기록을 확인한 뒤 추가 시도를 결정합니다. |
| `STATE_INVALID` | 상태를 보존하고 원인을 조사합니다. 캐시를 강제로 쓰려고 파일을 고치지 않습니다. |
| `NO_ELIGIBLE_PROVIDER` | 호스트의 모델 허용 조건과 캐시 관측을 확인합니다. 사전 검사에서 없는 캐시 적중 관측을 만들어 내지는 않습니다. |
| `OUTPUT_EXISTS` | 새 평가 출력 폴더를 지정합니다. 기존 보고서는 의도적으로 덮어쓰지 않습니다. |
| 스킬 업데이트 거부 | 실행 엔진 경로와 백업 상태를 확인합니다. 다른 저장소에서 설치한 스킬은 자동 교체하지 않습니다. |
| TLS·인증서 오류 | 지원되는 Node 버전과 올바른 신뢰 인증서를 사용합니다. 인증서 검증을 끄지 않습니다. |

`needs_host` 바깥에 자동 재시도 루프를 붙이지 마세요. 타임아웃은 공급자가 아무 일도 하지 않았다는 증거가 아닙니다. 키 파일·업무 근거·비공개 상태·자체 실행 보고서는 내용을 검토하기 전까지 공개 커밋에서 제외하세요.
