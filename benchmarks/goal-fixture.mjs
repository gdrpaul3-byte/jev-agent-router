import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const QUERY = '야간 개방';
const ARTICLE_TEXT = '2026년 10월 5일부터 중앙도서관 2층 열람실을 평일 오후 10시까지 개방합니다.';
const ARTICLES = {
  'library-night-2026': { title: '2026 도서관 야간 개방 안내', date: '2026-09-18', category: '도서관', body: ARTICLE_TEXT },
  'library-rules': { title: '도서관 이용 수칙 (상시 안내)', date: '2026-01-02', category: '도서관', body: '고정 공지입니다. 도서관에서는 휴대전화를 무음으로 설정하고 지정 좌석을 이용해 주세요. 야간 운영 시간은 해당 연도의 별도 공지를 확인하세요.' },
  'library-night-2025': { title: '2025 도서관 야간 개방 종료 안내', date: '2025-12-19', category: '도서관', body: '2025년 시험 기간 야간 운영은 종료되었습니다. 이 공지의 운영 일정은 현재 적용되지 않습니다.' },
  'night-shuttle': { title: '야간 셔틀 운행 안내', date: '2026-09-17', category: '학생지원', body: '합성 캠퍼스의 야간 셔틀은 평일 오후 9시에 정문에서 출발합니다. 도서관 열람실 개방 시간과는 별개의 안내입니다.' },
};
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function layout(title, body) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} | 한빛 캠퍼스 알림판</title><style>
*{box-sizing:border-box}body{margin:0;background:#f2f5fa;color:#142339;font:18px/1.65 "Malgun Gothic",sans-serif}header{background:#132c4e;color:white;padding:22px max(24px,calc((100vw - 1120px)/2))}header strong{font-size:24px}.badge{float:right;border:1px solid #7499c5;border-radius:20px;padding:2px 14px;font-size:14px}main{max-width:1120px;margin:40px auto;padding:0 24px}h1{font-size:34px;line-height:1.35;margin:12px 0 20px}h2{font-size:25px}.eyebrow{font-size:15px;color:#426287}.panel,article{background:white;border:1px solid #d6e0ee;border-radius:14px;padding:28px;margin:20px 0}label{display:block;font-weight:700;margin-bottom:12px}input{font:inherit;padding:12px 16px;border:2px solid #7290b2;border-radius:8px;width:min(650px,75%)}button,.filter{font:inherit;background:#185cc3;color:white;padding:13px 24px;border:0;border-radius:8px;cursor:pointer;text-decoration:none;display:inline-block}button{margin-left:10px}a{color:#164fa4;text-underline-offset:4px}nav{display:flex;gap:12px;flex-wrap:wrap}.filter[aria-current]{background:#132c4e}.muted{color:#61718a;font-size:16px}.notice{border-top:1px solid #dce4f0;padding:20px 0}.notice:first-child{border-top:0}.notice a{font-size:21px;font-weight:700}.pin{color:#805419;background:#fff0d7;padding:2px 8px;border-radius:5px;margin-right:12px;font-size:14px}.meta{color:#526580;font-size:15px}.proof{font-size:23px;line-height:1.9;padding:22px;background:#edf5ff;border-left:5px solid #2869bd}footer{max-width:1120px;padding:12px 24px 30px;margin:auto;color:#61718a;font-size:14px}
</style></head><body><header><strong>한빛 캠퍼스 알림판</strong><span class="badge">공개 합성 데이터 · 로컬 테스트</span></header><main>${body}</main><footer>실제 기관·개인의 정보나 접수 기능을 사용하지 않는 로컬 벤치마크입니다.</footer></body></html>`;
}
function home() {
  return layout('공지 검색', `<p class="eyebrow">캠퍼스 소식 / 공지 검색</p><h1>필요한 공지를 찾아보세요</h1><p>검색한 뒤 분류를 선택하면 해당 공지 목록을 확인할 수 있습니다.</p><section class="panel"><form method="get" action="/search"><label for="query">공지 검색어</label><input id="query" name="q" type="search" value="" autocomplete="off" maxlength="200"><button type="submit">검색</button><p id="query-state" class="muted" aria-live="polite">검색어를 입력하세요.</p></form></section><section class="panel"><h2>이용 안내</h2><p>고정 공지는 연도별 새 공지보다 먼저 표시됩니다. 제목과 작성일을 함께 확인하세요.</p></section><script>document.getElementById('query').addEventListener('input',event=>{document.getElementById('query-state').textContent=event.target.value?'입력한 검색어: '+event.target.value:'검색어를 입력하세요.'});</script>`);
}
function resultCard(slug, pinned = false) {
  const article = ARTICLES[slug];
  return `<div class="notice">${pinned ? '<span class="pin">고정 공지</span>' : ''}<a href="/articles/${slug}">${escape(article.title)}</a><p class="meta">${article.category} · 작성일 ${article.date}</p></div>`;
}
function search(url) {
  const query = url.searchParams.get('q') ?? '';
  const category = url.searchParams.get('category') ?? 'all';
  const matches = query.trim() === QUERY;
  const link = (id, name) => `<a class="filter" href="/search?q=${escape(encodeURIComponent(query))}&amp;category=${id}"${category === id ? ' aria-current="page"' : ''}>${name}</a>`;
  const heading = category === 'library' ? '도서관 검색 결과' : category === 'student' ? '학생지원 검색 결과' : '검색 분류를 선택하세요';
  const results = !matches ? '<p>검색 결과가 없습니다. 검색어를 확인해 주세요.</p>'
    : category === 'library' ? resultCard('library-rules', true) + resultCard('library-night-2025') + resultCard('library-night-2026')
    : category === 'student' ? resultCard('night-shuttle')
    : '<p>도서관 3건 · 학생지원 1건</p><p>분류를 선택하면 제목과 작성일이 포함된 공지 목록을 볼 수 있습니다.</p>';
  return layout(heading, `<p class="eyebrow">캠퍼스 소식 / 검색 결과</p><h1>${heading}</h1><p>검색어: <strong>${escape(query)}</strong></p><nav aria-label="검색 결과 분류">${link('all', '전체')}${link('library', '도서관')}${link('student', '학생지원')}</nav><section class="panel">${results}</section><a href="/">다시 검색</a>`);
}
function articlePage(slug) {
  const article = ARTICLES[slug];
  return layout(article.title, `<p class="eyebrow">캠퍼스 소식 / ${article.category} / 공지 본문</p><article><p class="meta">${article.category} · 작성일 ${article.date}</p><h1>${article.title}</h1><p class="proof">${article.body}</p><p>이 페이지의 정보는 벤치마크를 위해 작성한 합성 자료입니다.</p></article><a href="/search?q=${encodeURIComponent(QUERY)}&amp;category=library">검색 결과로 돌아가기</a>`);
}

/** Start only a local, read-only fixture; imports have no network side effects. */
export async function startGoalFixture({ port = 0 } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_FIXTURE_PORT');
  const server = createServer((request, response) => {
    const send = (status, html) => {
      response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(html);
    };
    if (request.method !== 'GET') { send(405, layout('지원하지 않는 요청', '<h1>GET 요청만 지원합니다.</h1>')); return; }
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); } catch { send(400, 'Invalid request'); return; }
    if ((url.searchParams.get('q') ?? '').length > 200) { send(400, 'Query too long'); return; }
    if (url.pathname === '/') { send(200, home()); return; }
    if (url.pathname === '/search') { send(200, search(url)); return; }
    const slug = url.pathname.startsWith('/articles/') ? url.pathname.slice('/articles/'.length) : '';
    if (Object.hasOwn(ARTICLES, slug)) { send(200, articlePage(slug)); return; }
    send(404, layout('페이지 없음', '<h1>페이지를 찾을 수 없습니다.</h1>'));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]))) throw new Error('Usage: node goal-fixture.mjs [--port NUMBER]');
  const fixture = await startGoalFixture({ port: args.length ? Number(args[1]) : 0 });
  console.log(JSON.stringify({ kind: 'synthetic_goal_fixture', origin: fixture.origin }));
  process.once('SIGINT', () => fixture.close());
  process.once('SIGTERM', () => fixture.close());
}
