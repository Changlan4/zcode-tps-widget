// 本地 HTTP 服务：速度方框的数据与页面。
//
// ZCode 插件没有「往界面注入脚本」的能力，所以自带一个独立页面：桌面浮层加载它，
// 浏览器打开 http://127.0.0.1:<port>/ 也是同一个方框。
//
// 安全边界（本地服务容易被任意网页探测）：
//   - 只监听 127.0.0.1，不对外暴露
//   - 校验 Host 头，防 DNS rebinding
//   - 写操作校验 Origin，拒绝跨站伪造
//   - 关闭服务需要 server.json 里的随机令牌
//   - 不返回通配 CORS 头（页面与接口同源，不需要跨域）
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_ID, CONFIG_FILE, DEFAULT_PORT, SERVER_INFO_FILE } from './paths.mjs'
import { readConfig } from './config.mjs'
import { turnSpeedSnapshot } from './metrics.mjs'
import { anchorPayload } from './anchor.mjs'
import { boxCss } from './box-css.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BOX_JS = path.join(HERE, 'box.js')
const VERSION = '1.0.0'
const TOKEN = crypto.randomBytes(16).toString('hex')

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

function hostAllowed(req, port) {
  const host = String(req.headers.host || '')
  const allowed = ['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port]
  return allowed.indexOf(host) !== -1
}

function originAllowed(req, port) {
  const origin = req.headers.origin
  if (!origin) return true // 非浏览器请求（curl 等）没有 Origin
  const allowed = ['http://127.0.0.1:' + port, 'http://localhost:' + port, 'http://[::1]:' + port]
  return allowed.indexOf(String(origin)) !== -1
}

function sendJson(res, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch (err) {
    body = JSON.stringify({ ok: false, error: '序列化失败' })
  }
  res.writeHead(status, JSON_HEADERS)
  res.end(body)
}

// 背景透明：浮层里方框直接浮在 ZCode 界面上；普通浏览器里是白底 + 方框。
function pageHtml(dark) {
  const bg = dark ? '#12161f' : 'transparent'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>实时速度 · ZCode</title>
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:${bg}}
${boxCss()}
</style>
</head>
<body>
<script defer src="/tps/box.js"></script>
</body>
</html>
`
}

function createRequestHandler(port) {
  return async function handle(req, res) {
    if (!hostAllowed(req, port)) {
      sendJson(res, 403, { ok: false, error: 'host not allowed' })
      return
    }
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1:' + port)
    } catch (err) {
      sendJson(res, 400, { ok: false, error: 'bad request' })
      return
    }
    const pathname = url.pathname
    const method = (req.method || 'GET').toUpperCase()
    const isWrite = method === 'PUT' || method === 'POST' || method === 'DELETE'
    if (isWrite && !originAllowed(req, port)) {
      sendJson(res, 403, { ok: false, error: 'origin not allowed' })
      return
    }

    // 页面
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(pageHtml(url.searchParams.get('bg') === 'dark'))
      return
    }

    // 前端脚本
    if (pathname === '/tps/box.js') {
      try {
        const js = fs.readFileSync(BOX_JS)
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': String(js.length),
        })
        res.end(js)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('box.js unavailable')
      }
      return
    }

    // 本问实时速度：默认按「当前正在看的会话」取它最新一问（方框就该显示这个）；
    // 带 ?current=1 才启用 --current 严格守卫（本问无数据时返回 ok:false，不冒充上一轮）。
    if (pathname === '/tps/speed.json') {
      try {
        const strict = url.searchParams.get('current') === '1'
        const sessionId = url.searchParams.get('session') || ''
        sendJson(res, 200, turnSpeedSnapshot({ current: strict, sessionId: sessionId || undefined }))
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          reason: 'error',
          error: String((err && err.message) || err).slice(0, 200),
        })
      }
      return
    }

    // 贴靠锚点：会话用量方框的位置与字号
    if (pathname === '/tps/anchor.json') {
      try {
        sendJson(res, 200, anchorPayload(readConfig().stackGapPx))
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String((err && err.message) || err).slice(0, 200) })
      }
      return
    }

    // 健康检查：给命令、MCP、hook 用来判断服务是否已在跑
    if (pathname === '/tps/health') {
      const cfg = readConfig()
      sendJson(res, 200, {
        ok: true,
        app: APP_ID,
        version: VERSION,
        pid: process.pid,
        port,
        configFile: CONFIG_FILE,
        portPinned: cfg.port,
        stackGapPx: cfg.stackGapPx,
        updatedAt: Date.now(),
      })
      return
    }

    // 关闭服务（需要 server.json 里的令牌）
    if (pathname === '/tps/shutdown' && isWrite) {
      if (String(req.headers['x-tps-token'] || '') !== TOKEN) {
        sendJson(res, 403, { ok: false, error: 'bad token' })
        return
      }
      sendJson(res, 200, { ok: true, stopping: true })
      setTimeout(() => stop(0), 50)
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }
}

let server = null

function writeServerInfo(port) {
  try {
    fs.mkdirSync(path.dirname(SERVER_INFO_FILE), { recursive: true })
    fs.writeFileSync(
      SERVER_INFO_FILE,
      JSON.stringify(
        {
          pid: process.pid,
          port,
          url: 'http://127.0.0.1:' + port + '/',
          token: TOKEN,
          version: VERSION,
          startedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      'utf8'
    )
  } catch (err) {}
}

function clearServerInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(SERVER_INFO_FILE, 'utf8'))
    if (info && info.pid === process.pid) fs.unlinkSync(SERVER_INFO_FILE)
  } catch (err) {}
}

function stop(code) {
  clearServerInfo()
  try {
    if (server) server.close()
  } catch (err) {}
  setTimeout(() => process.exit(code), 60)
}

// 端口占用时向后顺延，避免和其它本地服务抢端口
function listen(port, attemptsLeft) {
  server = http.createServer(createRequestHandler(port))
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      try {
        server.close()
      } catch (e) {}
      listen(port + 1, attemptsLeft - 1)
      return
    }
    console.error('[zcode-tps-widget] 无法启动服务:', String((err && err.message) || err))
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    writeServerInfo(port)
    console.log('⚡ 实时速度方框已就绪: http://127.0.0.1:' + port + '/')
    console.log('   数据目录: ' + path.dirname(SERVER_INFO_FILE))
  })
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

const configPort = readConfig().port
listen(configPort || DEFAULT_PORT, 20)

export { stop }
