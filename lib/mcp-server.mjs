// MCP (stdio) 服务：让 ZCode 会话内可以直接查本问实时速度、启停浮层。
//
// 传输是 MCP 标准的 stdio + 换行分隔 JSON（NDJSON），不依赖任何 npm 包，
// 便于插件直接分发。stdout 只写协议消息，诊断信息一律走 stderr。
import readline from 'node:readline'
import { readConfig, writeConfig } from './config.mjs'
import { turnSpeedSnapshot } from './metrics.mjs'
import { anchorPayload } from './anchor.mjs'
import { ensureServer, findRunningServer, stopServer, widgetUrl } from './service.mjs'
import { isRuntimeInstalled, overlayStatus, startOverlay, stopOverlay } from './overlay.mjs'

const SERVER_INFO = { name: 'zcode-tps-widget', version: '1.0.0' }
const PROTOCOL_FALLBACK = '2024-11-05'

const TOOLS = [
  {
    name: 'tps_speed',
    description:
      '读取「本问」的实时输出速率（tok/s，含思考 token；多段轮次按段加权）、首 token 延迟（TTFT）与采样时刻。数据只读自 ZCode 本地用量库。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tps_widget',
    description:
      '管理实时速度方框。start/stop/status/url 针对网页版服务（浏览器打开地址即可）；overlay_start/overlay_stop/overlay_status 针对桌面浮层——一个透明置顶窗口，速度方框贴在会话用量方框正上方，默认鼠标穿透。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status', 'url', 'overlay_start', 'overlay_stop', 'overlay_status'],
          description: '要执行的动作',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'tps_config',
    description: '查看或修改实时速度方框配置：贴靠间距（stackGapPx）、端口、会话自启开关。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: 'get 查看，set 修改' },
        stackGapPx: { type: 'number', description: '速度方框与会话用量方框之间的垂直间距（像素）' },
        port: { type: 'number', description: '方框服务固定端口，改后需重启服务' },
        autoStartWidget: { type: 'boolean', description: '是否在会话启动时自动拉起方框服务' },
        autoStartOverlay: { type: 'boolean', description: '是否在会话启动时自动拉起桌面浮层' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
]

function toolSpeed() {
  // 默认返回「当前正在看的会话」最新一问（不因本问暂无数据而空手；方框用的是同一口径）
  const snap = turnSpeedSnapshot({ current: false })
  if (!snap.ok) {
    const map = {
      'no-session': '本地库暂无模型请求记录（新装 ZCode 首次使用时会出现）。',
      'no-turn': '这个会话还没有已完成的一问——产生一次对话后就有数据。',
      'no-db': '找不到用量库 db.sqlite。',
      'no-sqlite': '读不到数据源（需要 Node 22.5+ 的内置 node:sqlite）。',
    }
    return { text: '⚡ 暂无速度数据：' + (map[snap.reason] || snap.reason || '未知原因'), isError: true }
  }
  const lines = [
    '⚡ 实时速度（当前会话最新一问）',
    '输出速率：' + (snap.tokPerSec != null ? snap.tokPerSec.toFixed(1) : '--') + ' tok/s' + (snap.segments > 1 ? '（' + snap.segments + ' 段加权，排除工具等待）' : ''),
    '首 token 延迟：' + (snap.ttftMs != null ? (snap.ttftMs / 1000).toFixed(1) + ' s' : '--'),
    '采样时刻：' + (snap.sampleAt ? new Date(snap.sampleAt).toLocaleTimeString('zh-CN', { hour12: false }) + '（' + fmtAge(snap.sampleAt) + '）' : '--'),
    '本问输出：' + Number(snap.outputTokens).toLocaleString('en-US') + ' tok（含思考 ' + Number(snap.reasoningTokens).toLocaleString('en-US') + '）',
    '会话：' + (snap.title || '(未命名)') + ' · 模型 ' + (snap.modelShort || '--'),
  ]
  if (snap.segments > 1) lines.push('峰值：' + (snap.peakTokPerSec != null ? snap.peakTokPerSec.toFixed(1) : '--') + ' tok/s')
  return { text: lines.join('\n') }
}

function fmtAge(ms) {
  const s = Math.max(0, (Date.now() - Number(ms)) / 1000)
  if (s < 90) return Math.round(s) + ' 秒前'
  if (s < 7200) return Math.round(s / 60) + ' 分钟前'
  return (s / 3600).toFixed(1) + ' 小时前'
}

async function toolWidget(args) {
  const action = args && args.action
  if (action === 'overlay_start') {
    if (!isRuntimeInstalled()) {
      return {
        text:
          '桌面浮层需要 Electron 运行时（约 150MB，一次性）。若已装过会话用量方框挂件则会复用同一份。请在终端执行：\n  node lib/cli.mjs desktop install\n装好后再执行 overlay_start。',
        isError: true,
      }
    }
    const r = await startOverlay()
    if (!r.running) return { text: '桌面浮层启动失败：' + (r.error || '未知原因'), isError: true }
    return {
      text:
        '⚡ 桌面浮层已就绪（pid ' + r.pid + '）：速度方框贴在会话用量方框正上方，默认鼠标穿透，指针压到它上才会接管鼠标。' +
        (r.started ? '（本次新启动）' : '（复用已在运行的浮层）'),
    }
  }
  if (action === 'overlay_stop') {
    const r = await stopOverlay()
    return r.ok ? { text: '⚡ 桌面浮层已关闭' } : { text: '关闭失败：' + r.error, isError: true }
  }
  if (action === 'overlay_status') {
    const s = await overlayStatus()
    const lines = ['桌面浮层：' + (s.running ? '运行中（pid ' + s.pid + '）' : '未运行')]
    lines.push('Electron 运行时：' + (s.installed ? '已安装' : '未安装（node lib/cli.mjs desktop install）'))
    if (s.running) lines.push('提示：浮层透明置顶，鼠标移上去才接管点击；node lib/cli.mjs window stop 可关闭。')
    return { text: lines.join('\n') }
  }
  if (action === 'start') {
    const r = await ensureServer()
    if (!r.running) return { text: '启动失败：' + (r.error || '未知原因'), isError: true }
    return {
      text: '⚡ 速度方框已就绪：' + widgetUrl(r.port) + (r.started ? '（本次新启动）' : '（复用已在运行的服务）') + '\n用浏览器打开该地址即可看到方框。',
    }
  }
  if (action === 'stop') {
    const r = await stopServer()
    return r.ok ? { text: '⚡ 速度方框服务已停止' } : { text: '停止失败：' + r.error, isError: true }
  }
  if (action === 'url') {
    const running = await findRunningServer()
    return running ? { text: widgetUrl(running.port) } : { text: '方框服务未在运行', isError: true }
  }
  const running = await findRunningServer()
  if (!running) return { text: '方框服务未运行。可用 action=start 启动。' }
  return {
    text: ['⚡ 方框服务运行中', '地址：' + widgetUrl(running.port), 'pid：' + (running.health && running.health.pid)].join('\n'),
  }
}

async function toolConfig(args) {
  const action = args && args.action
  if (action === 'set') {
    const patch = {}
    if (typeof args.stackGapPx === 'number') patch.stackGapPx = args.stackGapPx
    if (Number.isInteger(args.port) && args.port > 0 && args.port < 65536) patch.port = args.port
    if (typeof args.autoStartWidget === 'boolean') patch.autoStartWidget = args.autoStartWidget
    if (typeof args.autoStartOverlay === 'boolean') patch.autoStartOverlay = args.autoStartOverlay
    if (Object.keys(patch).length === 0) return { text: '没有需要修改的字段。', isError: true }
    writeConfig(patch)
    const changed = Object.keys(patch).map((k) => k + '=' + String(patch[k])).join(', ')
    const note = patch.port ? '\n端口变更需要重启方框服务（action=stop 再 start）。' : ''
    return { text: '已更新：' + changed + note }
  }
  const cfg = readConfig()
  const anchor = anchorPayload(cfg.stackGapPx)
  const ov = await overlayStatus()
  return {
    text: [
      '⚡ 实时速度方框配置',
      '端口：' + (cfg.port || '自动（默认 39331）'),
      '贴靠间距：' + cfg.stackGapPx + 'px',
      '字号跟随：' + anchor.whaleScale + '×（随会话用量方框）',
      '会话自启：服务 ' + (cfg.autoStartWidget ? '开' : '关') + '、桌面浮层 ' + (cfg.autoStartOverlay ? '开' : '关'),
      '桌面浮层：' + (ov.running ? '运行中（pid ' + ov.pid + '）' : ov.installed ? '未运行' : '未运行 · 运行时未安装'),
    ].join('\n'),
  }
}

async function callTool(name, args) {
  switch (name) {
    case 'tps_speed':
      return toolSpeed()
    case 'tps_widget':
      return toolWidget(args)
    case 'tps_config':
      return toolConfig(args)
    default:
      return { text: '未知工具：' + name, isError: true }
  }
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

async function handle(msg) {
  const id = msg && msg.id
  const method = msg && msg.method
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') return
    return
  }
  if (method === 'initialize') {
    const requested = msg.params && msg.params.protocolVersion
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested || PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    })
    return
  }
  if (method === 'ping') {
    write({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    write({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const name = msg.params && msg.params.name
    const args = (msg.params && msg.params.arguments) || {}
    try {
      const out = await callTool(name, args)
      write({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: out.text }], isError: !!out.isError },
      })
    } catch (err) {
      write({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: '工具执行失败：' + String((err && err.message) || err) }],
          isError: true,
        },
      })
    }
    return
  }
  write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + String(method) } })
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
let chain = Promise.resolve()
rl.on('line', (line) => {
  const text = String(line).trim()
  if (!text) return
  let msg
  try {
    msg = JSON.parse(text)
  } catch (err) {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  chain = chain.then(() => handle(msg)).catch((err) => {
    process.stderr.write('[zcode-tps] ' + String((err && err.message) || err) + '\n')
  })
})
rl.on('close', () => {
  chain.then(() => process.exit(0)).catch(() => process.exit(0))
})

process.stderr.write('[zcode-tps] MCP server ready (' + SERVER_INFO.version + ')\n')
