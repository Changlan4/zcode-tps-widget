// 速度方框（桌面浮层 / 网页版共用）。
//
// 显示「本问」的实时输出速率、首 token 延迟、采样时刻。本问 = 当前会话最新的
// turn_id；多段轮次（模型→工具→模型）按段加权，即总产出 / 总纯生成时长，
// 段间的工具等待不计入分母。
//
// 位置：固定贴在「会话用量方框」正上方（同左边缘、间隔 stackGapPx），宽度与字号
// 跟随会话用量方框，做到两个方框 UI 一致、位置紧挨。锚点位置由主进程读会话用量
// 方框的记忆位置（localStorage 的 zcw-box-pos）后在 /tps/anchor.json 里给出。
//
// 浮层里的定位机制（见 desktop/main.cjs 的 applyZCodeBounds）：
//   - 浮层窗口铺满整个工作区，主进程把 ZCode 窗口矩形作为「视口」发进来，
//     位置以这个矩形为基准，于是方框看起来待在 ZCode 窗口里
//   - 窗口默认鼠标穿透。指针落在方框上时才让窗口接管鼠标，离开后又交回去。
//     普通浏览器里没有 tpsDesktop，穿透逻辑自动失效、方框始终可交互。
(function () {
  'use strict'

  var ANCHOR_POLL_MS = 1500 // 锚点（会话用量方框位置/字号）刷新间隔
  var POLL_MS = 2000 // 数据刷新间隔
  var SWITCH_RECHECK_MS = 600 // 检测到会话切换后的补刷间隔

  var BASE_W = 300 // 与会话用量方框同宽（width = 300 × 会话用量方框字号倍率）
  var BASE_FONT = 13

  var bridge = typeof window !== 'undefined' && window.tpsDesktop ? window.tpsDesktop : null

  var root, dotEl, chipEl, rateNumEl, rowsEl, footEl

  // ---------- 数据 ----------
  var snapshot = null // 当前显示的快照（可能来自缓存）
  var errorText = ''
  var failCount = 0
  var fetching = false
  var lastSessionId = null
  var switchTimer = null
  var staleReason = '' // 非空表示当前显示的是缓存（「上轮数据」）
  var emptyReason = '' // 连缓存都没有时的原因

  // 缓存：把每个会话最近一次的有效快照存进 localStorage（换会话、刷新页面都能兜住）。
  // 换会话后新会话尚未产生模型请求时，就先用它自己（或最近一次）的快照顶上，
  // 有新数据再刷新——方框不会空掉。
  var STORE_KEY = 'zcw-tps-last-v1'
  var CACHE_MAX_SESSIONS = 12
  var cache = { bySession: {}, last: null }

  function loadCache() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
      if (raw && typeof raw === 'object' && raw.bySession) {
        cache = { bySession: raw.bySession || {}, last: raw.last || null }
      }
    } catch (err) {}
  }

  function saveCache() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(cache))
    } catch (err) {}
  }

  function remember(d) {
    if (!d || !d.ok || !d.sessionId) return
    cache.bySession[d.sessionId] = d
    cache.last = d
    var keys = Object.keys(cache.bySession)
    if (keys.length > CACHE_MAX_SESSIONS) delete cache.bySession[keys[0]]
    saveCache()
  }

  // 该会话的缓存快照；没有就退回最近一次（任意会话）
  function cachedFor(sessionId) {
    return (sessionId && cache.bySession[sessionId]) || cache.last || null
  }

  // 锚点：会话用量方框的左上角（DIP，相对 ZCode 视口）与其字号倍率
  var anchor = null // { left, top, scale }
  var gapPx = 10

  function num(v) {
    var n = Number(v)
    return isFinite(n) ? n : 0
  }

  function fmtInt(n) {
    n = Math.round(num(n))
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  function clock(ms) {
    var d = new Date(num(ms))
    var p = function (v) {
      return (v < 10 ? '0' : '') + v
    }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  }

  function ageText(ms) {
    if (!ms) return ''
    var s = Math.max(0, (Date.now() - ms) / 1000)
    if (s < 90) return Math.round(s) + '秒前'
    if (s < 7200) return Math.round(s / 60) + '分钟前'
    return (s / 3600).toFixed(1) + '小时前'
  }

  // ---------- 渲染 ----------
  // 三行指标：色板与会话用量方框一致（蓝=延迟、绿=产出、琥珀=采样）
  var ROWS = [
    { key: 'ttft', label: '首 token 延迟', color: '#7aa2f7' },
    { key: 'out', label: '本问输出', color: '#6cc4a8' },
    { key: 'sample', label: '采样时刻', color: '#e0af68' },
  ]

  function buildRow(row) {
    var el = document.createElement('div')
    el.className = 'row'
    el.setAttribute('data-key', row.key)
    el.innerHTML =
      '<span class="swatch" style="background:' +
      row.color +
      '"></span>' +
      '<span class="label"></span>' +
      '<span class="val"></span>'
    return el
  }

  function buildUi() {
    root = document.createElement('div')
    root.id = 'box'
    root.innerHTML =
      '<div class="head">' +
      '  <span class="dot"></span>' +
      '  <span class="title">实时速度</span>' +
      '  <span class="chip"></span>' +
      '</div>' +
      '<div class="speed">' +
      '  <span class="num">--</span>' +
      '  <span class="unit">tok/s</span>' +
      '</div>' +
      '<div class="body"></div>' +
      '<div class="foot"></div>'

    dotEl = root.querySelector('.dot')
    chipEl = root.querySelector('.chip')
    rateNumEl = root.querySelector('.speed .num')
    rowsEl = root.querySelector('.body')
    footEl = root.querySelector('.foot')

    ROWS.forEach(function (r) {
      rowsEl.appendChild(buildRow(r))
    })

    document.body.appendChild(root)
  }

  function setRow(key, label, value) {
    var el = rowsEl.querySelector('.row[data-key="' + key + '"]')
    if (!el) return
    el.querySelector('.label').textContent = label
    el.querySelector('.val').textContent = value
  }

  // 脚注只在「需要说明」时出现（显示上轮数据 / 无数据 / 取数失败）；
  // 正常有数据时不留脚注，方框保持干净。
  function setFoot(text) {
    if (text) {
      footEl.textContent = text
      footEl.style.display = ''
    } else {
      footEl.textContent = ''
      footEl.style.display = 'none'
    }
  }

  function render() {
    var s = snapshot
    if (!s) {
      dotEl.className = 'dot bad'
      chipEl.style.display = 'none'
      rateNumEl.textContent = '--'
      rateNumEl.className = 'num idle'
      ROWS.forEach(function (r) {
        setRow(r.key, r.label, '--')
      })
      setFoot(errorText || reasonText(emptyReason))
      fitWindow()
      return
    }

    var stale = !!staleReason
    dotEl.className = 'dot' + (stale ? ' warn' : '')

    if (s.modelShort) {
      chipEl.style.display = ''
      chipEl.textContent = s.modelShort
      chipEl.title = s.model || ''
    } else {
      chipEl.style.display = 'none'
    }

    if (s.tokPerSec != null) {
      rateNumEl.textContent = num(s.tokPerSec).toFixed(1)
      rateNumEl.className = 'num' + (stale ? ' idle' : '')
    } else {
      rateNumEl.textContent = '--'
      rateNumEl.className = 'num idle'
    }

    setRow('ttft', '首 token 延迟', s.ttftMs != null ? (s.ttftMs / 1000).toFixed(1) + ' s' : '--')
    var out = fmtInt(s.outputTokens) + ' tok'
    if (s.reasoningTokens > 0) out += '（思考 ' + fmtInt(s.reasoningTokens) + '）'
    setRow('out', stale ? '上轮输出' : '本问输出', out)
    setRow(
      'sample',
      '采样时刻',
      s.sampleAt ? clock(s.sampleAt) + ' · ' + ageText(s.sampleAt) : '--'
    )

    // 正常态不留脚注；本会话暂无新数据时说明「显示的是上轮」
    setFoot(stale ? '上轮数据 · ' + reasonText(staleReason) : '')
    fitWindow()
  }

  function reasonText(reason) {
    switch (reason) {
      case 'no-sqlite':
        return '读不到数据源（需要 Node 22.5+）'
      case 'no-db':
        return '找不到用量库'
      case 'no-session':
      case 'no-turn':
        return '本会话暂无已完成的一问'
      case 'no-current-turn':
        return '本问尚未产生模型请求'
      case 'query-failed':
        return '读库失败'
      case 'fetch-failed':
        return '取数失败'
      default:
        return '等待数据…'
    }
  }

  // 把一次取数结果落到界面：有效快照直接用；没有新数据就用缓存兜底（标成「上轮」）
  function applySnapshot(data) {
    if (data && data.ok) {
      staleReason = ''
      emptyReason = ''
      snapshot = data
      remember(data)
      // 会话切换（在 ZCode 里打开别的会话）：短促补刷一次，等新会话的数字稳定
      if (data.sessionId) {
        if (lastSessionId !== null && data.sessionId !== lastSessionId) {
          if (switchTimer) clearTimeout(switchTimer)
          switchTimer = setTimeout(fetchOnce, SWITCH_RECHECK_MS)
        }
        lastSessionId = data.sessionId
      }
    } else {
      var cached = cachedFor(data && data.sessionId)
      if (cached) {
        snapshot = cached
        staleReason = (data && data.reason) || 'no-current-turn'
        if (data && data.sessionId) lastSessionId = data.sessionId
      } else {
        snapshot = null
        emptyReason = (data && data.reason) || ''
      }
    }
    render()
  }

  // ---------- 取数 ----------
  function fetchOnce() {
    if (fetching) return
    fetching = true
    fetch('/tps/speed.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        failCount = 0
        errorText = ''
        applySnapshot(data)
      })
      .catch(function () {
        // 偶发一次失败不吵（服务重启的几秒空窗很常见），连续失败才提示。
        // 有缓存就用缓存顶着，方框不会因为一次取数失败而空掉。
        failCount += 1
        errorText = failCount >= 3 ? '取数失败，重试中…' : ''
        var cached = cachedFor(lastSessionId)
        if (cached) {
          snapshot = cached
          staleReason = 'fetch-failed'
          render()
        } else {
          snapshot = null
          emptyReason = 'fetch-failed'
          render()
        }
      })
      .then(function () {
        fetching = false
      })
  }

  function fetchAnchor() {
    fetch('/tps/anchor.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        if (!data || !data.ok) return
        gapPx = num(data.gapPx) || 10
        anchor = data.anchor || null
        applyWhaleScale(data.whaleScale)
        settle()
      })
      .catch(function () {})
  }

  function startPolling() {
    fetchOnce()
    fetchAnchor()
    setInterval(fetchOnce, POLL_MS)
    setInterval(fetchAnchor, ANCHOR_POLL_MS)
  }

  // ---------- 定位 ----------
  var externalViewport = null

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v
  }

  function vp() {
    if (externalViewport) return { w: externalViewport.w, h: externalViewport.h }
    return { w: window.innerWidth || 1280, h: window.innerHeight || 800 }
  }

  function express(left, top) {
    var ox = externalViewport ? externalViewport.x : 0
    var oy = externalViewport ? externalViewport.y : 0
    root.style.left = Math.round(ox + left) + 'px'
    root.style.top = Math.round(oy + top) + 'px'
  }

  // 贴在会话用量方框正上方：同左边缘，底边在它顶边之上 gapPx。
  function settle() {
    if (!root) return
    var v = vp()
    var h = root.offsetHeight || 0
    var w = root.offsetWidth || 0
    var left, top
    if (anchor && isFinite(anchor.left) && isFinite(anchor.top)) {
      left = anchor.left
      top = anchor.top - gapPx - h
    } else {
      // 读不到锚点（会话用量方框从未移动/未运行）：停在左上角常量位置
      left = 24
      top = 24
    }
    // 只把钳制结果用于显示，绝不写回记忆。最小化的动画里有几十毫秒窗口矩形很小，
    // 若把结果存下来，恢复后方框会永远停在角落。
    left = clamp(left, 0, Math.max(0, v.w - w))
    top = clamp(top, 0, Math.max(0, v.h - h))
    express(left, top)
  }

  // 尺寸跟随会话用量方框：宽度与字号按同一个倍率缩放，做到 UI 长度一致。
  // 倍率来自会话用量方框自己的 zcw-box-view（挂件 box.js 的 applyScale），
  // 基准也照抄挂件：BASE_W 300、字号 13。
  function applyWhaleScale(scale) {
    var s = clamp(num(scale) || 1, 0.7, 2.4)
    root.style.width = Math.round(BASE_W * s) + 'px'
    root.style.fontSize = Math.round(BASE_FONT * s) + 'px'
  }

  function fitWindow() {
    settle()
  }

  // 双击刷新数据
  function bindGestures() {
    root.addEventListener('dblclick', function (e) {
      e.preventDefault()
      fetchOnce()
      fetchAnchor()
    })
  }

  // ---------- 浮层：鼠标接管 ----------
  var interactive = false
  var lastPointer = null

  function setInteractive(next) {
    if (!bridge || interactive === !!next) return
    interactive = !!next
    try {
      bridge.setInteractive(interactive)
    } catch (err) {}
  }

  function shouldInteract() {
    if (!lastPointer) return false
    try {
      var el = document.elementFromPoint(lastPointer.x, lastPointer.y)
      if (!el) return false
      return !!(el === root || (root.contains && root.contains(el)))
    } catch (err) {
      return false
    }
  }

  function bindOverlay() {
    if (!bridge) return
    // 视口消息到达前坐标基准未定，先藏住，避免启动瞬间在屏幕一角闪一下。
    root.style.visibility = 'hidden'
    setTimeout(function () {
      root.style.visibility = ''
    }, 3000)
    document.addEventListener('mousemove', function (e) {
      lastPointer = { x: e.clientX, y: e.clientY }
      setInteractive(shouldInteract())
    })
    document.addEventListener('mouseleave', function () {
      lastPointer = null
      setInteractive(false)
    })
    if (typeof bridge.onHidden === 'function') {
      bridge.onHidden(function () {
        interactive = false
      })
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) interactive = false
    })
    if (typeof bridge.onViewport === 'function') {
      bridge.onViewport(function (rect) {
        if (!rect || typeof rect.width !== 'number' || rect.width <= 0) return
        if (rect.width < 200 || rect.height < 200) return
        var first = externalViewport === null
        externalViewport = { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
        if (first) root.style.visibility = ''
        settle()
      })
    }
  }

  // ---------- 启动 ----------
  function boot() {
    buildUi()
    applyWhaleScale(1)
    bindGestures()
    loadCache()

    if (bridge) {
      root.classList.add('overlay')
      bindOverlay()
    }
    settle()
    startPolling()
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () {
        settle()
      })
    }
    // 高度会随字体/数据变化，用一个很轻的兜底把位置钉住
    setInterval(fitWindow, 1000)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
