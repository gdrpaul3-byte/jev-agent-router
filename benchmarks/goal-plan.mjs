const QUERY = '야간 개방';
const TITLE = '2026 도서관 야간 개방 안내';
const ARTICLE_TEXT = '2026년 10월 5일부터 중앙도서관 2층 열람실을 평일 오후 10시까지 개방합니다.';
const ARTICLE_PATH = '/articles/library-night-2026';
const now = () => globalThis.performance?.now() ?? Date.now();

/** Fixed public synthetic task; input values and executable operations belong to the host. */
export function makeGoalPlan(origin) {
  let url;
  try { url = new URL(origin); } catch { throw new Error('INVALID_FIXTURE_ORIGIN'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('INVALID_FIXTURE_ORIGIN');
  return {
    url: url.href,
    goal: '공지 검색어에 "야간 개방"을 입력해 검색하고, 도서관 분류를 선택한 다음 "2026 도서관 야간 개방 안내"의 본문을 열어 2026년 운영 시작일과 열람실 운영 시간을 확인하세요. 고정 공지나 2025년 종료 공지는 목표가 아닙니다.',
    actions: [
      { id: 'enter-query', action: 'typeText', description: '아직 비어 있는 공지 검색어 입력란에 지정된 검색어를 입력합니다.', text: QUERY, target: { roles: ['text field', 'search field'], nameEquals: '공지 검색어' } },
      { id: 'submit-search', action: 'click', description: '공지 검색어에 야간 개방이 입력되었으면 검색 버튼을 누릅니다.', target: { roles: ['button'], nameEquals: '검색' } },
      { id: 'filter-library', action: 'click', description: '검색 결과의 분류에서 도서관을 선택해 도서관 공지 목록을 표시합니다.', target: { roles: ['link'], nameEquals: '도서관' } },
      { id: 'open-notice', action: 'click', description: '도서관 검색 결과에서 정확히 2026 도서관 야간 개방 안내라는 제목의 공지 본문을 엽니다.', target: { roles: ['link'], nameEquals: TITLE } },
    ],
    completion: { textIncludes: ARTICLE_TEXT, urlIncludes: ARTICLE_PATH },
    maxSteps: 6,
    maxDurationMs: 60000,
    verificationTimeoutMs: 5000,
  };
}

/** A deterministic baseline for this fixture, not a model or general browser agent. */
export function createLocalRuleDecider() {
  let calls = 0;
  let lastLatencyMs = 0;
  return {
    stats: () => ({ kind: 'local_rules', calls, apiCalls: 0, inputTokens: 0, lastLatencyMs }),
    async decide(input) {
      const started = now();
      calls++;
      const finish = value => { lastLatencyMs = Math.max(0, now() - started); return { ...value, latencyMs: lastLatencyMs }; };
      const stop = () => finish({ status: 'needs_host', reason: 'LOCAL_RULE_NO_UNIQUE_APPROVED_ACTION' });
      try {
        const { observation, actions } = input ?? {};
        if (!observation || typeof observation.text !== 'string' || !Array.isArray(observation.elements) || !Array.isArray(actions)) return stop();
        const refs = new Set();
        for (const element of observation.elements) {
          if (!element || !Number.isSafeInteger(element.ref) || element.ref < 0 || refs.has(element.ref)
            || typeof element.role !== 'string' || typeof element.name !== 'string') return stop();
          refs.add(element.ref);
        }
        const text = observation.text;
        const url = typeof observation.url === 'string' ? observation.url : text.match(/(?:Page )?URL:\s*"([^"\n]+)"/)?.[1] ?? '';
        if (text.includes(ARTICLE_TEXT) && url.includes(ARTICLE_PATH)) return finish({ status: 'done', confidence: 1 });
        const fields = observation.elements.filter(element => ['text field', 'search field'].includes(element.role) && element.name === '공지 검색어' && !element.disabled);
        let id;
        if (fields.length > 1) return stop();
        if (fields.length === 1) id = fields[0].value === QUERY ? 'submit-search' : 'enter-query';
        else if (text.includes('검색 분류를 선택하세요')) id = 'filter-library';
        else if (text.includes('도서관 검색 결과')) id = 'open-notice';
        else return stop();
        const approved = actions.filter(action => action?.id === id);
        if (approved.length !== 1) return stop();
        const action = approved[0];
        const expected = id === 'enter-query' ? { kind: 'typeText', name: '공지 검색어', roles: ['text field', 'search field'] }
          : id === 'submit-search' ? { kind: 'click', name: '검색', roles: ['button'] }
          : id === 'filter-library' ? { kind: 'click', name: '도서관', roles: ['link'] }
          : { kind: 'click', name: TITLE, roles: ['link'] };
        if (action.action !== expected.kind || (id === 'enter-query' && (action.text !== QUERY || fields[0].value))) return stop();
        const candidates = observation.elements.filter(element => !element.disabled && expected.roles.includes(element.role) && element.name === expected.name
          && (!action.target?.roles || action.target.roles.includes(element.role))
          && (!action.target?.nameEquals || element.name === action.target.nameEquals)
          && (!action.target?.nameIncludes || element.name.includes(action.target.nameIncludes)));
        if (candidates.length !== 1) return stop();
        return finish({ status: 'decided', actionId: id, ref: candidates[0].ref, confidence: 1 });
      } catch { return stop(); }
    },
  };
}
