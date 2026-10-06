// 实时速度方框的桌面浮层窗口。
//
// ZCode 插件无法往客户端界面注入内容，所以这里用独立 Electron 窗口把方框
// 「浮」在 ZCode 上。为了让它表现得像界面的一部分：
//   - 窗口矩形始终对齐 ZCode 主窗口（由 desktop/follow-window.ps1 常驻探测位置）
//   - 联动由跟随脚本决定：ZCode 最小化或被别的应用盖住 → 浮层隐藏；
//     ZCode 退出 → 跟随脚本收到 gone，浮层跟着退出
//   - 透明、无边框、不进任务栏、始终置顶
//   - **默认鼠标穿透**：不在方框上时点击落到下面的 ZCode，不挡操作
//
// 本文件与挂件 zcode-whale-widget 的浮层同源（同一定位/穿透/合成自愈机制），
// 只改了命名与端口。Electron 的 userData 目录取包名（zcode-tps-overlay），
// 与挂件的 zcode-whale-overlay 分开，两个浮层互不干扰。
//
// 非 Windows 平台拿不到窗口信息，退回「覆盖整个工作区」的静态浮层。
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const PORT = Number(process.env.TPS_PORT) || 39331
const TARGET_URL = 'http://127.0.0.1:' + PORT + '/'

// 排查用日志：只有开启调试端口时才写，平时零开销。
const DEBUG_LOG = process.env.TPS_DEBUG_PORT
  ? path.join(os.homedir(), '.zcode', 'tps', 'overlay-debug.log')
  : null
function log(...parts) {
  if (!DEBUG_LOG) return
  try {
    fs.appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + parts.join(' ') + '\n')
  } catch (err) {}
}

// 注意：这里刻意**不**调用 app.disableHardwareAcceleration()。
// 关掉硬件加速会让透明窗口走 CPU 合成，实测内容会被画到偏离窗口的位置，必须保留 GPU 合成。

// 排查用：设置 TPS_DEBUG_PORT 后可以用 Chrome DevTools 协议连进这个浮层页面。
const DEBUG_PORT = Number(process.env.TPS_DEBUG_PORT) || 0
if (DEBUG_PORT > 0) {
  app.commandLine.appendSwitch('remote-debugging-port', String(DEBUG_PORT))
}

let win = null
let interactive = false
let follower = null

// 跟随探测间隔（毫秒）。越小越跟手，代价是探测脚本醒来更频繁——它每次只做
// 几个微秒级的 Win32 调用，所以即使是 16ms 也不构成负担。默认 40ms（约 25 次/秒）。
const FOLLOW_INTERVAL_DEFAULT = 40
function clampFollowInterval(value) {
  const n = Number(value)
  if (!isFinite(n) || n <= 0) return FOLLOW_INTERVAL_DEFAULT
  return Math.min(2000, Math.max(16, Math.round(n)))
}
let followIntervalMs = clampFollowInterval(process.env.TPS_FOLLOW_INTERVAL_MS || FOLLOW_INTERVAL_DEFAULT)

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    transparent: true,
    frame: false,
    // 保持 resizable:true：Electron 对 resizable:false 的窗口会把 min/max 尺寸
    // 锁成创建时的大小，之后 setBounds 改尺寸会被拒绝，页面视口就不再跟随。
    resizable: true,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    title: '实时速度',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  // screen-saver 级别才能稳稳浮在其它应用之上
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })

  win.loadURL(TARGET_URL)

  // 页面加载完成后补发一次视口，避免启动早期的 rect 消息丢失。
  win.webContents.on('did-finish-load', () => {
    interactive = false
    try {
      win.setIgnoreMouseEvents(true, { forward: true })
    } catch (err) {}
    if (!lastViewport) return
    try {
      win.webContents.send('tps:viewport', lastViewport)
    } catch (err) {}
  })

  // 页面加载失败（多为服务未启动）：稍后重试，避免留下空白窗口
  win.webContents.on('did-fail-load', () => {
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.loadURL(TARGET_URL)
    }, 2000)
  })

  win.on('closed', () => {
    win = null
  })

  if (process.platform === 'win32') {
    startFollower()
  } else {
    win.once('ready-to-show', () => {
      win.show()
      win.setIgnoreMouseEvents(true, { forward: true })
    })
  }
}

// ---------- 透明窗口合成自愈 ----------
// Windows 上透明窗口的 GPU 合成偶发整体失效（休眠/锁屏/显示器变化之后）：窗口还在、
// 页面也活着，但内容不再画到屏幕上。对策：抓一帧页面自查，全透明就先重载页面，
// 反复失败再重建窗口。
let blankFrames = 0
let lastRebuildAt = 0
let verifying = false

function pageLooksBlank(img) {
  if (!img || img.isEmpty()) return true
  try {
    const small = img.resize({ width: 48, height: 27 })
    const buf = small.toBitmap()
    for (let i = 3; i < buf.length; i += 4) {
      if (buf[i] > 8) return false
    }
  } catch (err) {
    return false
  }
  return true
}

async function verifyCompositor(reason) {
  if (!win || win.isDestroyed() || !win.isVisible() || verifying) return
  verifying = true
  try {
    const img = await win.webContents.capturePage()
    if (!pageLooksBlank(img)) {
      blankFrames = 0
      return
    }
    blankFrames += 1
    log('compositor-blank', reason + ' consecutive=' + blankFrames)
    if (blankFrames <= 2) {
      try {
        win.webContents.reload()
      } catch (err) {}
    } else if (Date.now() - lastRebuildAt > 60000) {
      lastRebuildAt = Date.now()
      blankFrames = 0
      log('compositor-rebuild', 'reload did not help, recreating window')
      try {
        win.destroy()
      } catch (err) {}
      createWindow()
    }
  } catch (err) {
  } finally {
    verifying = false
  }
}

function scheduleCompositorCheck(delayMs, reason) {
  setTimeout(() => {
    verifyCompositor(reason).catch(() => {})
  }, delayMs)
}

// ---------- 跟随 ZCode 主窗口 ----------
function startFollower() {
  let hwnd = ''
  try {
    hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString()
  } catch (err) {
    log('hwnd-failed', String((err && err.message) || err))
    return
  }
  const script = path.join(__dirname, 'follow-window.ps1')
  const child = spawn(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-OverlayHwnd',
      hwnd,
      '-IntervalMs',
      String(followIntervalMs),
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  follower = child
  log('follower-started', 'interval=' + followIntervalMs + 'ms')
  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg = null
      try {
        msg = JSON.parse(line)
      } catch (err) {
        log('follower-bad-line', line.slice(0, 120))
        continue
      }
      applyZCodeBounds(msg)
    }
  })
  child.stderr.on('data', (chunk) => log('follower-stderr', chunk.toString('utf8').slice(0, 200)))
  child.on('exit', (code) => {
    if (follower !== child) return
    follower = null
    log('follower-exit', String(code))
    // 跟随脚本自己退了（多半是 ZCode 已退出）：浮层也没有存在意义了
    if (code !== null && !app.isQuitting) app.quit()
  })
}

function restartFollower(reason) {
  if (!win || win.isDestroyed()) return
  log('follower-restart', reason + ' interval=' + followIntervalMs)
  const old = follower
  follower = null
  if (old) {
    try {
      old.kill()
    } catch (err) {}
  }
  startFollower()
}

// 把 ZCode 窗口矩形换算成浮层窗口内的相对矩形后发给页面（页面把它当自己的视口）。
// 这里刻意不改浮层窗口自己的位置与尺寸（它始终铺满工作区）：Windows 上透明窗口一旦
// setBounds 改变尺寸/位置，合成层不会跟着重排，页面内容会被画到偏离窗口的地方。
let lastViewport = null

function applyZCodeBounds(msg) {
  if (!win || win.isDestroyed()) return
  if (msg.gone) {
    log('zcode-gone')
    app.quit()
    return
  }
  if (msg.hide || msg.show === false) {
    try {
      win.webContents.send('tps:overlay-hidden')
    } catch (err) {}
    applyInteractive(false)
    if (win.isVisible()) win.hide()
    log('hidden', msg.hide ? 'window-missing' : 'zcode-not-foreground')
    return
  }

  let rect = { x: msg.x, y: msg.y, width: msg.w, height: msg.h }
  // ZCode 给的是物理像素，Electron 的坐标是 DIP
  try {
    if (screen.screenToDipRect) {
      const dip = screen.screenToDipRect(null, rect)
      if (dip && dip.width > 0 && dip.height > 0) rect = dip
    }
  } catch (err) {}

  const winBounds = win.getBounds()
  lastViewport = {
    x: Math.round(rect.x - winBounds.x),
    y: Math.round(rect.y - winBounds.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }

  if (!win.isVisible()) {
    win.showInactive()
    applyInteractive(false)
    log('shown-at', JSON.stringify(lastViewport))
    scheduleCompositorCheck(2500, 'shown')
  }

  try {
    win.webContents.send('tps:viewport', lastViewport)
  } catch (err) {}
}

// ---------- 鼠标接管切换 ----------
function applyInteractive(next) {
  if (!win || win.isDestroyed()) {
    log('interactive-ignored', String(next))
    return
  }
  const want = !!next
  if (want === interactive) {
    log('interactive-same', String(want))
    return
  }
  interactive = want
  if (want) {
    win.setIgnoreMouseEvents(false)
  } else {
    win.setIgnoreMouseEvents(true, { forward: true })
  }
  log('interactive-applied', String(want))
}

ipcMain.on('tps:interactive', (_event, value) => {
  log('ipc-interactive', String(value))
  applyInteractive(value)
})
ipcMain.on('tps:follow-interval', (_event, value) => {
  const next = clampFollowInterval(value)
  if (next === followIntervalMs) return
  followIntervalMs = next
  restartFollower('interval-changed')
})
ipcMain.handle('tps:follow-interval-get', () => followIntervalMs)
ipcMain.on('tps:quit', () => app.quit())
ipcMain.handle('tps:workarea', () => screen.getPrimaryDisplay().workArea)

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  app.isQuitting = true
  if (follower) {
    try {
      follower.kill()
    } catch (err) {}
    follower = null
  }
})

app.whenReady().then(() => {
  createWindow()

  const { powerMonitor } = require('electron')
  powerMonitor.on('resume', () => scheduleCompositorCheck(5000, 'resume'))
  powerMonitor.on('unlock-screen', () => scheduleCompositorCheck(3000, 'unlock-screen'))
  screen.on('display-metrics-changed', () => scheduleCompositorCheck(3000, 'display-metrics-changed'))
  setInterval(() => {
    verifyCompositor('periodic').catch(() => {})
  }, 5 * 60 * 1000)
})
