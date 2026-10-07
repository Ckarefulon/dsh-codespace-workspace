/**
 * A tiny static server for the browser DOM harness.
 *
 * It serves the repo root so the harness can fetch `../../lib/client.js` exactly
 * as the app's own loader does, but only ever from inside the repo.
 *
 * Run: node test/serve.mjs
 * Then open http://127.0.0.1:19501/test/browser/index.html
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  // `/` REDIRECTS rather than serving the page directly: the page's own
  // `./harness.js` and `../../lib/client.js` are relative to its real path, so
  // serving it under `/` would resolve them against the repo root instead.
  if (url === '/') {
    res.writeHead(302, { location: '/test/browser/index.html' })
    res.end()
    return
  }
  const file = resolve(root, '.' + url)
  // `file` must be the root itself or sit underneath it.
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('forbidden')
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found: ' + url)
  }
})

server.listen(19501, '127.0.0.1', () => {
  console.log('harness served at http://127.0.0.1:19501/')
  console.log('serving repo root: ' + root)
})
