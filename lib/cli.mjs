// 命令行入口，供 /speed 命令、skill 与人工排查使用。
// 只读操作（status/json/speed）不会拉起服务；start/stop/window 才会动进程。
import { readConfig } from './config.mjs'
import { formatTurnLine, turnSpeedSnapshot } from './metrics.mjs'
import { ensureServer, findRunningServer, stopServer, widgetUrl } from './service.mjs'
import { installRuntime, isRuntimeInstalled, overlayStatus, runtimePaths, startOverlay, stopOverlay } from './overlay.mjs'
import { anchorPayload } from './anchor.mjs'

function fmtRate(v) {
  return v != null && isFinite(v) ? Number(v).toFixed(1) : '--'
}

async function cmdStatus() {
  const running = await findRunningServer()
  const overlay = await overlayStatus()
  const cfg = readConfig()
  const snap = turnSpeedSnapshot({ current: false })

  console.log('   ⚡  实时速度 · ZCode')
  console.log('   ──────────────────────────────')
  if (snap.ok) {
    console.log('   本问速率   ' + fmtRate(snap.tokPerSec) + ' tok/s' + (snap.segments > 1 ? '（' + snap.segments + ' 段加权）' : ''))
    console.log('   首 token   ' + (snap.ttftMs != null ? (snap.ttftMs / 1000).toFixed(1) + ' s' : '--'))
    console.log('   采样时刻   ' + (snap.sampleAt ? new Date(snap.sampleAt).toLocaleTimeString('zh-CN', { hour12: false }) : '--'))
    console.log('   本问输出   ' + Number(snap.outputTokens).toLocaleString('en-US') + ' tok（含思考 ' + Number(snap.reasoningTokens).toLocaleString('en-US') + '）')
    console.log('   会话       ' + (snap.title || '(未命名)') + '  模型 ' + (snap.modelShort || '--'))
  } else {
    console.log('   本问速率   暂无数据（' + (snap.reason || 'unknown') + '）')
  }
  console.log('   ──────────────────────────────')
  console.log(
    '   方框服务   ' +
      (running
        ? widgetUrl(running.port) + '  (运行中 pid ' + (running.health && running.health.pid) + ')'
        : '未运行（node lib/cli.mjs start 启动）')
  )
  console.log(
    '   桌面浮层   ' +
      (overlay.running
        ? '运行中（pid ' + overlay.pid + '）'
        : overlay.installed
          ? '未运行（node lib/cli.mjs window start 启动）'
          : '未运行 · Electron 运行时未安装（node lib/cli.mjs desktop install）')
  )
  const anchor = anchorPayload(cfg.stackGapPx)
  console.log('   贴靠锚点   ' + (anchor.anchor ? 'left ' + anchor.anchor.left + ', top ' + anchor.anchor.top + '（会话用量方框上方）' : '未读到会话用量方框位置，暂在左上角'))
  console.log('   字号/间距  倍率 ' + anchor.whaleScale + ' · 间距 ' + anchor.gapPx + 'px')
  return 0
}

async function cmdSpeed() {
  const snap = turnSpeedSnapshot({ current: false })
  console.log(formatTurnLine(snap))
  return snap.ok ? 0 : 1
}

async function cmdJson() {
  const cfg = readConfig()
  const running = await findRunningServer()
  const overlay = await overlayStatus()
  const snap = turnSpeedSnapshot({ current: false })
  console.log(
    JSON.stringify(
      {
        speed: snap,
        anchor: anchorPayload(cfg.stackGapPx),
        widget: running ? { running: true, url: widgetUrl(running.port), port: running.port } : { running: false },
        overlay: { running: overlay.running, pid: overlay.pid || null, installed: overlay.installed },
        config: cfg,
        now: new Date().toISOString(),
      },
      null,
      2
    )
  )
  return 0
}

async function cmdWindow(argv) {
  const action = argv[0] || 'status'
  if (action === 'start') {
    const r = await startOverlay()
    if (r.running) {
      console.log('⚡ 桌面浮层已就绪（pid ' + r.pid + '）—— 速度方框浮在会话用量方框上方，指针压到它时才接管鼠标')
      console.log('   关掉：node lib/cli.mjs window stop')
      return 0
    }
    console.log('桌面浮层启动失败：' + (r.error || '未知原因'))
    if (r.hint) console.log('   ' + r.hint)
    return 1
  }
  if (action === 'stop') {
    const r = await stopOverlay()
    console.log(r.ok ? '⚡ 桌面浮层已关闭' : '关闭失败：' + r.error)
    return r.ok ? 0 : 1
  }
  const s = await overlayStatus()
  console.log('桌面浮层：' + (s.running ? '运行中（pid ' + s.pid + '）' : '未运行'))
  console.log('Electron 运行时：' + (s.installed ? '已安装 ' + runtimePaths().electronExe : '未安装（node lib/cli.mjs desktop install）'))
  return 0
}

async function cmdDesktopInstall() {
  if (isRuntimeInstalled()) {
    console.log('✅ Electron 运行时已就绪（复用挂件安装的那一份）：' + runtimePaths().electronExe)
    console.log('   现在可以运行：node lib/cli.mjs window start')
    return 0
  }
  console.log('正在安装 Electron 运行时到 ' + runtimePaths().runtimeDir + ' …')
  console.log('（约 150MB，一次性；之后桌面浮层直接可用）')
  const r = await installRuntime()
  if (r.ok) {
    console.log('✅ 安装完成：' + r.electronExe)
    console.log('   现在可以运行：node lib/cli.mjs window start')
    return 0
  }
  console.log('❌ 安装失败于「' + r.step + '」')
  console.log(String(r.output || '').trim())
  return 1
}

async function cmdStart() {
  const r = await ensureServer()
  if (r.running) {
    console.log('⚡ 方框服务已就绪：' + widgetUrl(r.port) + (r.started ? '（本次新启动）' : '（复用已在运行的服务）'))
    return 0
  }
  console.log('方框服务启动失败：' + (r.error || '未知原因'))
  return 1
}

async function cmdStop() {
  const r = await stopServer()
  console.log(r.ok ? '⚡ 方框服务已停止' : '停止失败：' + r.error)
  return r.ok ? 0 : 1
}

const [cmd, ...rest] = process.argv.slice(2)
const commands = {
  status: cmdStatus,
  speed: cmdSpeed,
  json: cmdJson,
  start: cmdStart,
  stop: cmdStop,
  window: () => cmdWindow(rest),
  desktop: cmdDesktopInstall,
  url: async () => {
    const running = await findRunningServer()
    console.log(running ? widgetUrl(running.port) : '')
    return running ? 0 : 1
  },
}

const run = commands[cmd] || cmdStatus
run()
  .then((code) => {
    process.exitCode = code || 0
  })
  .catch((err) => {
    console.error('执行失败：' + String((err && err.message) || err))
    process.exitCode = 1
  })
