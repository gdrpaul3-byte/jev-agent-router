import test from 'node:test';
import assert from 'node:assert/strict';
import { startGoalFixture } from './goal-fixture.mjs';
import { makeGoalPlan, createLocalRuleDecider } from './goal-plan.mjs';

const articleText = '2026년 10월 5일부터 중앙도서관 2층 열람실을 평일 오후 10시까지 개방합니다.';

async function withFixture(run) {
  const fixture = await startGoalFixture();
  try { await run(fixture); } finally { await fixture.close(); }
}

test('serves a loopback-only synthetic Korean search page with GET navigation', async () => {
  await withFixture(async ({ origin, server }) => {
    assert.equal(server.address().address, '127.0.0.1');
    const response = await fetch(origin);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html; charset=utf-8/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.match(html, /공개 합성 데이터/);
    assert.match(html, /<label[^>]*for="query"[^>]*>공지 검색어<\/label>/);
    assert.match(html, /<form[^>]*method="get"[^>]*action="\/search"/);
    assert.match(html, /<button[^>]*>검색<\/button>/);
    assert.ok(!html.includes(articleText));
  });
});

test('search results require a category and never expose the completion proof early', async () => {
  await withFixture(async ({ origin }) => {
    const html = await (await fetch(`${origin}/search?q=${encodeURIComponent('야간 개방')}`)).text();
    assert.match(html, /검색 분류를 선택하세요/);
    assert.match(html, /야간 개방/);
    assert.match(html, />도서관<\/a>/);
    assert.match(html, /category=library/);
    assert.ok(!html.includes('href="/articles/library-night-2026"'));
    assert.ok(!html.includes(articleText));
  });
});

test('library filter yields a pinned distractor and the exact target article', async () => {
  await withFixture(async ({ origin }) => {
    const html = await (await fetch(`${origin}/search?q=${encodeURIComponent('야간 개방')}&category=library`)).text();
    assert.match(html, /도서관 검색 결과/);
    assert.match(html, /고정 공지/);
    assert.match(html, /도서관 이용 수칙/);
    assert.match(html, /2025 도서관 야간 개방 종료 안내/);
    assert.match(html, /href="\/articles\/library-night-2026"[^>]*>2026 도서관 야간 개방 안내<\/a>/);
    assert.ok(!html.includes(articleText));
  });
});

test('only the correct final article contains unique content proof', async () => {
  await withFixture(async ({ origin }) => {
    const good = await fetch(`${origin}/articles/library-night-2026`);
    assert.equal(good.status, 200);
    assert.ok((await good.text()).includes(articleText));
    for (const slug of ['library-rules', 'library-night-2025']) {
      const wrong = await fetch(`${origin}/articles/${slug}`);
      assert.equal(wrong.status, 200);
      assert.ok(!(await wrong.text()).includes(articleText));
    }
  });
});

test('unknown routes and non-GET methods cannot mutate fixture state', async () => {
  await withFixture(async ({ origin }) => {
    assert.equal((await fetch(`${origin}/missing`)).status, 404);
    assert.equal((await fetch(`${origin}/search`, { method: 'POST', body: 'q=anything' })).status, 405);
    const html = await (await fetch(origin)).text();
    assert.match(html, /id="query"[^>]*value=""/);
  });
});

test('untrusted query text is escaped and unmatched queries cannot reach the target', async () => {
  await withFixture(async ({ origin }) => {
    const query = '<img src=x onerror=alert(1)>"&';
    const html = await (await fetch(`${origin}/search?q=${encodeURIComponent(query)}&category=library`)).text();
    assert.ok(!html.includes('<img src=x'));
    assert.match(html, /&lt;img/);
    assert.ok(!html.includes('href="/articles/library-night-2026"'));
    assert.match(html, /검색 결과가 없습니다/);
  });
});

test('plan fixes four permitted host actions and both completion predicates', () => {
  const plan = makeGoalPlan('http://127.0.0.1:8123');
  assert.equal(plan.url, 'http://127.0.0.1:8123/');
  assert.deepEqual(plan.actions.map(action => action.action), ['typeText', 'click', 'click', 'click']);
  assert.equal(plan.actions[0].text, '야간 개방');
  assert.equal(plan.actions.at(-1).target.nameEquals, '2026 도서관 야간 개방 안내');
  assert.equal(plan.completion.textIncludes, articleText);
  assert.equal(plan.completion.urlIncludes, '/articles/library-night-2026');
  assert.throws(() => makeGoalPlan('https://example.com'), /INVALID_FIXTURE_ORIGIN/);
  assert.throws(() => makeGoalPlan('http://user:secret@127.0.0.1:8123'), /INVALID_FIXTURE_ORIGIN/);
});

test('local-rules baseline chooses current observed refs through all four actions', async () => {
  const decider = createLocalRuleDecider();
  const plan = makeGoalPlan('http://127.0.0.1:8123');
  const decide = observation => decider.decide({ ...plan, observation, history: [] });
  const empty = { text: '공지 검색', elements: [
    { ref: 1, role: 'text field', name: '공지 검색어', value: '' },
    { ref: 4, role: 'button', name: '검색' },
  ] };
  const first = await decide(empty);
  assert.equal(first.actionId, 'enter-query'); assert.equal(first.ref, 1);
  const second = await decide({ ...empty, elements: [{ ...empty.elements[0], value: '야간 개방' }, empty.elements[1]] });
  assert.equal(second.actionId, 'submit-search'); assert.equal(second.ref, 4);
  const third = await decide({ text: '검색 분류를 선택하세요', elements: [{ ref: 10, role: 'link', name: '도서관' }] });
  assert.equal(third.actionId, 'filter-library'); assert.equal(third.ref, 10);
  const fourth = await decide({ text: '도서관 검색 결과', elements: [
    { ref: 2, role: 'link', name: '도서관 이용 수칙 (상시 안내)' },
    { ref: 7, role: 'link', name: '2025 도서관 야간 개방 종료 안내' },
    { ref: 12, role: 'link', name: '2026 도서관 야간 개방 안내' },
  ] });
  assert.equal(fourth.actionId, 'open-notice'); assert.equal(fourth.ref, 12);
  assert.equal((await decide({ text: articleText, url: 'http://127.0.0.1:8123/articles/library-night-2026', elements: [] })).status, 'done');
  assert.equal(decider.stats().kind, 'local_rules');
  assert.equal(decider.stats().apiCalls, 0);
});

test('local-rules baseline stops on ambiguous, disabled or unapproved choices', async () => {
  const plan = makeGoalPlan('http://127.0.0.1:8123');
  for (const elements of [
    [{ ref: 3, role: 'link', name: '도서관' }, { ref: 4, role: 'link', name: '도서관' }],
    [{ ref: 3, role: 'link', name: '도서관', disabled: true }],
  ]) {
    const result = await createLocalRuleDecider().decide({ ...plan, observation: { text: '검색 분류를 선택하세요', elements } });
    assert.equal(result.status, 'needs_host');
  }
  const result = await createLocalRuleDecider().decide({ ...plan, actions: [], observation: { text: '검색 분류를 선택하세요', elements: [{ ref: 3, role: 'link', name: '도서관' }] } });
  assert.equal(result.status, 'needs_host');
  assert.equal((await createLocalRuleDecider().decide(null)).status, 'needs_host');
  assert.equal((await createLocalRuleDecider().decide({ ...plan, observation: { text: articleText, elements: [] } })).status, 'needs_host');
});
