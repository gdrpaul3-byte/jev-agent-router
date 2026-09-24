import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const page = await readFile(new URL('./demo.html', import.meta.url));
const server = createServer((request, response) => {
  if (request.url !== '/' || request.method !== 'GET') { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(page);
});
server.listen(8776, '127.0.0.1', () => console.log('Offline browser fixture: http://127.0.0.1:8776/'));
process.on('SIGINT', () => server.close());
