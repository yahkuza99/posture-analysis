// Minimal static server for local use and tests: `npm run serve` → http://localhost:8080
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

export function serve(port = 8080) {
  const server = http.createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise(r => server.listen(port, () => r(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = +process.env.PORT || 8080;
  await serve(port);
  console.log(`Posture Analysis: http://localhost:${port}`);
}
