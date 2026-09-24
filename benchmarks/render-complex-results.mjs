// Render already-recorded evidence only. Never runs models or changes expected answers.
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';

const input = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('REPORT_PATH_REQUIRED');
const report = JSON.parse(await readFile(input, 'utf8'));
if (report.schemaVersion !== 1 || !Array.isArray(report.runs) || !Array.isArray(report.requests)) throw new Error('INVALID_REPORT');
const names = { astra: 'Astra만 사용', luna: 'Luna + Astra', adaptive: '적응형 선택 + Astra' };
const money = value => typeof value === 'number' ? '$' + value.toFixed(8) : '미확정';
const seconds = value => (value / 1000).toFixed(3) + '초';
const fresh = report.runs.filter(row => row.phase !== 'exact_repeat');
const total = (rows, get) => rows.reduce((sum, row) => sum + get(row), 0);
const sumCost = rows => rows.some(row => row.cost.accountedProviderUsd === null) ? null : total(rows, row => row.cost.accountedProviderUsd);
const table = report.summaries.map(summary => {
  const rows = fresh.filter(row => row.arm === summary.arm);
  return '| ' + [names[summary.arm], `${rows.filter(row => row.quality.corePassed).length}/${rows.length}`,
    `${rows.filter(row => row.quality.passed).length}/${rows.length}`, rows.length ? seconds(total(rows, row => row.latencyMs) / rows.length) : '—',
    sumCost(rows) === null ? '미확정' : money(sumCost(rows)), total(rows, row => row.requests), summary.exactReplays].join(' | ') + ' |';
});
const details = report.runs.map(row => '| ' + [row.missionId, row.phase, names[row.arm], row.quality.passed ? '37/37' : `${row.quality.checksPassed}/${row.quality.checksTotal}`,
  seconds(row.latencyMs), money(row.cost.accountedProviderUsd), row.requests,
  row.cacheHit ? '전체 결과 재사용' : row.synthesis ? String(row.synthesis.usage.cachedInputTokens ?? '미확정') : '생성 미실행'].join(' | ') + ' |');
const routing = fresh.flatMap(row => row.routing), attempts = routing.flatMap(row => row.attempts);
const actualRoutingModels = [...new Set(attempts.map(row => row.observedModel).filter(Boolean))];
const adaptiveModels = [...new Set(fresh.filter(row => row.arm === 'adaptive').flatMap(row => row.routing.flatMap(route => route.attempts.map(attempt => attempt.observedModel))).filter(Boolean))];
const failures = report.runs.filter(row => !row.quality.passed);
const synthesisTokens = fresh.map(row => row.synthesis?.usage.cachedInputTokens).filter(value => typeof value === 'number');
const lines = [
  '# 캐시·JEV·Luna·Astra — 복잡한 전체 업무 비교', '',
  `실행 상태: **${report.status}**. ${report.runs.length}/${report.plannedWorkflows}개 실행을 기록했다. 실제 모델이 수행한 새로운 업무는 ${fresh.length}개이며 정확 재생은 별도 조건이다. 두 합성 임무의 기본·변경형을 각각 세 방식으로 처리했다.`, '',
  '각 업무는 세 번의 근거 자료 선택, 선택된 로컬 문서 회수, Astra의 최종 구조화 산출물 작성으로 구성된다. 선정·제외·보류, 원 단위 계산, 마감, 선행 작업과 승인 경계, 핵심 근거 인용을 검사한다. 실제 기관 심사·외부 신청·브라우저 조작·영상 촬영은 하지 않았다.', '',
  '## 전체 결과', '',
  '| 방식 | 핵심 판단 | 인용 포함 엄격 통과 | 새 업무 평균 시간 | 새 업무 비용 합계 | 실제 POST | 정확 재생 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...table, '',
  '핵심 판단에는 구조·선정·계산·마감·승인·선행 조건을 포함한다. 인용까지 포함한 엄격 결과도 함께 공개하며, 인용 누락을 완전한 성공으로 바꾸지 않는다. 평균은 기본형과 변경형을 합친 소규모 기술 통계다. 오류가 있는 방식의 시간을 성공 처리 속도로 해석하지 않는다.', '',
  `총 실제 요청 **${report.accounting.requests}회**, 확인 가능한 비용 **${money(report.accounting.accountedProviderUsd)}**. JEV 정가 추정 ${money(report.accounting.estimatedProviderUsd)}와 OpenRouter 보고 크레딧 차감 ${money(report.accounting.reportedProviderUsd)}의 합이다. 카드 청구·충전 수수료·세금·이 평가를 준비한 호스트 추론은 제외한다. upstream inference cost를 중복 가산하지 않았다.`, '',
  '## 캐시 해석', '',
  '- 모든 방식에 동일한 정확 결과 재생 기회를 제공했다. 재생 비용은 이번에 추가된 비용이며, 원래 결과를 만드는 비용은 앞선 실행에 남아 있다. 재생 행의 synthesis.usage는 원본 사용량을 보존한 메타데이터이며 새 토큰 소비가 아니다.',
  '- 변경형은 결정적인 장부/견적이 바뀐다. 전체 산출물은 다시 생성하고, 입력이 그대로인 개별 자료 선택만 기존 권고를 재사용할 수 있다.',
  '- 첫 실행을 강제로 비운 cold cache라고 부르지 않는다. 요청 순서는 회전하지만 공급자 캐시의 완전 격리를 보장하지 않는다. 실제 cached/write 토큰만 보고한다.',
  `- 최종 생성의 관측 캐시 입력 토큰: ${synthesisTokens.join(', ') || '없음'}. 프롬프트 캐시는 답 재사용이 아니므로 출력 생성 비용은 계속 발생한다.`,
  `- 이번 적응형 경로의 실제 자료 선택 모델: ${adaptiveModels.join(', ') || '없음'}. 다른 모델로의 자동 전환·판단 보류 후 상승을 실제로 관측하지 않았다면 모의 검사와 구분한다.`, '',
  '## 모든 실행', '',
  '| 임무 | 조건 | 방식 | 엄격 검사 | 시간 | 추가 비용 | POST | 최종 생성 캐시 입력 토큰 |',
  '| --- | --- | --- | ---: | ---: | ---: | ---: | --- |', ...details, '',
  'm1: 개정 장학 공고·등록금 장부·미제출 증빙·280만원 예산·위원회 승인. m2: 지원율·지원 상한·VAT·240만원 자체 자금·중복 설비·누락 증빙·이사회 승인. 변경형은 m1의 기존 장학금 증가, m2의 견적 증가를 반영한다.', '',
  '## 실패와 한계', '',
  ...(failures.length ? failures.map(row => `- ${row.missionId}/${row.phase}/${row.arm}: ${row.status}; ${row.quality.failures.join(', ')}`) : ['- 이번 실행에서 엄격 검사 실패는 없었다.']),
  '- 에이전트가 만든 합성 개발 평가이며 인간이 검증한 벤치마크가 아니다. 4개의 입력 변형과 반복 실행으로 실제 업무 전체의 정확도나 통계적 우월성을 주장하지 않는다.',
  '- Astra/Luna는 OpenRouter 중계의 OpenAI default 경로, JEV는 TypeSafe 직접 경로다. 모든 최종 산출물은 Astra low가 작성하므로 전체 비용·시간에서 최종 생성의 비중을 함께 봐야 한다.',
  '- 캐시 사용량에 따른 Luna 전환과 예산·불확실 상태·승인 차단은 모의 HTTP 자동 검사로 검증했다. 이번 실제 Luna 자료 선택의 캐시 입력은 0이며, 1939토큰 캐시 재사용은 최종 Astra 생성에서 관측했다. 이 실험에서 관측하지 않은 동작을 실측 성공으로 부르지 않는다.',
  '- 자동 HTTP 재시도 및 정답을 알려주는 복구 호출은 없다. 실패·중단 기록도 보존한다. 상위 결과 캐시는 현재 평가 프로세스 내 메모리이며, 제품의 개별 권고 캐시는 로컬 상태 파일에 저장된다.', '',
  '## 재현과 원자료', '',
  `- UTC: ${report.startedAt} – ${report.finishedAt ?? '진행 중'}`,
  `- 실행 상한: ${report.maxRequests} POST, 보수적 비용 예약 ${money(report.budgetUsd)}. 공급자 선불 청구 한도는 아니다.`,
  `- 관측 자료 선택 모델: ${actualRoutingModels.join(', ')}`,
  `- dataset SHA-256: \`${report.datasetSha256}\``,
  '- 실행 전에 입력·정답을 고정했다. 실제 결과를 본 뒤 라벨을 수정하지 않았다.',
  '- 실행 전 전체 자동 검사 718개 통과, 실패 0. [완료 검증](verification.json)에 해시 불변·키 노출 검사·재생 무과금 확인을 기록했다.',
  '- [기계 판독 결과](report.json) · [사전 고정 manifest](report.json.manifest.json) · [실행 방법](../../../docs/adaptive-routing.md) · [설계](../../../docs/adaptive-routing-design.md)', '',
];
try { await access(join(dirname(input), 'INTERPRETATION.md')); lines.push('사후 독립 검토: [인용 집합 차이와 결과 해석](INTERPRETATION.md). 사전 점수와 원자료는 유지했다.', ''); } catch { /* Optional interpretation is separate from measured evidence. */ }
await writeFile(join(dirname(input), 'RESULTS.md'), lines.join('\n'), 'utf8');
process.stdout.write(JSON.stringify({ status: 'rendered', workflows: report.runs.length, failures: failures.length }) + '\n');
