#!/usr/bin/env node
/**
 * EvoPanel ç¬ç« Web æå¡å¨ï¼Headless æ¨¡å¼ï¼? * æ é Tauri / Rust / GUIï¼çº¯ Node.js è¿è¡
 * éç¨äº?Linux æå¡å¨ãDocker ç­æ æ¡é¢ç¯å¢
 *
 * ç¨æ³ï¼? *   npm run serve              # é»è®¤ 0.0.0.0:1420
 *   npm run serve -- --port 8080
 *   npm run serve -- --host 127.0.0.1 --port 3000
 *   PORT=8080 npm run serve
 */
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import net from 'net'
import { _initApi, _apiMiddleware } from './dev-api.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST_DIR = path.resolve(__dirname, '..', 'dist')

// === è§£æå½ä»¤è¡åæ?===
function parseServePort() {
  const keys = ['EVOFLOW_WEBUI_HTTP_PORT', 'EVOFLOW_VITE_PORT', 'PORT']
  for (const key of keys) {
    const n = parseInt(String(process.env[key] || '').trim(), 10)
    if (Number.isFinite(n) && n > 1 && n < 65536) return n
  }
  return 1420
}

function parseArgs() {
  const args = process.argv.slice(2)
  let host = process.env.HOST || '0.0.0.0'
  let port = parseServePort()
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host' && args[i + 1]) host = args[++i]
    if (args[i] === '--port' && args[i + 1]) port = parseInt(args[++i], 10)
    if (args[i] === '-p' && args[i + 1]) port = parseInt(args[++i], 10)
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
EvoPanel Web Server (Headless)

ç¨æ³: node scripts/serve.js [éé¡¹]

éé¡¹:
  --host <addr>   çå¬å°å (é»è®¤: 0.0.0.0)
  --port, -p <n>  çå¬ç«¯å£ (é»è®¤: 1420)
  --help, -h      æ¾ç¤ºå¸®å©

ç¯å¢åé:
  HOST            çå¬å°å
  PORT            çå¬ç«¯å£

ç¤ºä¾:
  npm run serve                    # 0.0.0.0:1420
  npm run serve -- --port 8080     # 0.0.0.0:8080
  npm run serve -- --host 127.0.0.1 -p 3000
`)
      process.exit(0)
    }
  }
  return { host, port }
}

// === MIME ç±»åæ å° ===
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
}

// === éææä»¶æå?===
function serveStatic(req, res) {
  // URL å»æ query string
  const urlPath = req.url.split('?')[0]
  let filePath = path.join(DIST_DIR, urlPath === '/' ? 'index.html' : urlPath)

  // å®å¨æ£æ¥ï¼ä¸åè®¸ç®å½éå?  if (!filePath.startsWith(DIST_DIR)) {
    res.statusCode = 403
    res.end('Forbidden')
    return
  }

  // å°è¯è¯»åæä»¶
  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isFile()) {
      sendFile(res, filePath)
      return
    }

    // SPA fallbackï¼é APIãééæèµæº?â?index.html
    const ext = path.extname(urlPath)
    if (!ext || ext === '.html') {
      sendFile(res, path.join(DIST_DIR, 'index.html'))
    } else {
      res.statusCode = 404
      res.end('Not Found')
    }
  })
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath)
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'

  // ç¼å­ç­ç¥ï¼èµæºæä»¶é¿ç¼å­ï¼HTML ä¸ç¼å­?  if (ext === '.html') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  }

  res.setHeader('Content-Type', contentType)
  fs.createReadStream(filePath).pipe(res)
}

// === å¯å¨æå¡å?===
async function main() {
  // æ£æ?dist ç®å½
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    console.error('â?æªæ¾å?dist/index.htmlï¼è¯·åè¿è¡? npm run build')
    process.exit(1)
  }

  const { host, port } = parseArgs()

  // åå§å?API
  _initApi()

  const server = http.createServer(async (req, res) => {
    // CORS å¤´ï¼æ¹ä¾¿å¼åè°è¯ï¼
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }

    // API è¯·æ±
    await _apiMiddleware(req, res, () => {
      // é?API â?éææä»?      serveStatic(req, res)
    })
  })

  // WebSocket ä»£ç
  let gatewayPort = 18789
  try {
    const cfgPath = path.join(homedir(), '.evopanel', 'evopanel.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    gatewayPort = cfg?.gateway?.port || 18789
  } catch {}

  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws')) {
      socket.destroy()
      return
    }

    const target = net.createConnection(gatewayPort, '127.0.0.1', () => {
      const reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
      const headers = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n')
      target.write(reqLine + headers + '\r\n\r\n')
      if (head.length) target.write(head)
      socket.pipe(target)
      target.pipe(socket)
    })

    target.on('error', () => socket.destroy())
    socket.on('error', () => target.destroy())
  })

  server.listen(port, host, () => {
    console.log('')
    console.log('  âââââââââââââââââââââââââââââââââââââââââââ?)
    console.log('  â?                                        â?)
    console.log('  â?  ð¦ EvoPanel Web Server (Headless)    â?)
    console.log('  â?                                        â?)
    console.log(`  â?  http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`.padEnd(44) + 'â?)
    if (host === '0.0.0.0') {
      console.log(`  â?  http://0.0.0.0:${port}/`.padEnd(44) + 'â?)
    }
    console.log('  â?                                        â?)
    console.log('  âââââââââââââââââââââââââââââââââââââââââââ?)
    console.log('')
    console.log('  æ?Ctrl+C åæ­¢æå¡')
    console.log('')
  })

  // ä¼ééå?  process.on('SIGINT', () => { console.log('\n  ð æå¡å·²åæ­?); process.exit(0) })
  process.on('SIGTERM', () => { console.log('\n  ð æå¡å·²åæ­?); process.exit(0) })
}

main().catch(e => { console.error('å¯å¨å¤±è´¥:', e); process.exit(1) })
