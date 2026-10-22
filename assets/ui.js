/* dsh-all-rewind — client panel (v0.3).
 *
 * Renders a small "回退到本轮对话之前" action directly under every user prompt
 * bubble, matching the TRAE placement (per-message, not a floating widget).
 * The chat DOM already exposes stable attributes:
 *   - [data-conversation-session]                 current session id
 *   - [data-chat-flow-kind="user"][data-chat-turn] one user prompt + its turn
 *
 * React owns that DOM, so we only APPEND our own node inside the user flow item
 * and re-attach it through a MutationObserver if React replaces the subtree.
 * Clicking the action asks for confirmation and POSTs /api/revert.
 */
(function () {
  'use strict'
  if (window.__dshAllRewind) return
  window.__dshAllRewind = true

  var API = '/dsh-all-rewind'
  var ROOT_SELECTOR = '[data-conversation-session]'
  var USER_SELECTOR = '[data-chat-flow-kind="user"][data-chat-turn]'
  var BUTTON_MARKER = 'data-dsh-all-rewind'

  var state = {
    sessionId: null,
    points: new Map(),       // turn -> rewind point
    storage: null,
    fetching: false,
    lastFetchAt: 0,
    busy: false,
  }

  var scheduled = false
  var toastTimer = null
  var toastNode = null

  // ------------------------------------------------------------------ utils

  function api(path, options) {
    var init = { headers: { Accept: 'application/json' }, credentials: 'same-origin' }
    if (options && options.body) {
      init.method = 'POST'
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }
    return fetch(API + path, init).then(function (response) {
      return response.text().then(function (text) {
        var data = null
        try { data = text ? JSON.parse(text) : null } catch (error) { data = null }
        if (!response.ok) {
          var failure = new Error((data && (data.error || data.message)) || ('HTTP ' + response.status))
          failure.status = response.status
          throw failure
        }
        return data
      })
    })
  }

  function injectStyle() {
    if (document.getElementById('dsh-all-rewind-style')) return
    var style = document.createElement('style')
    style.id = 'dsh-all-rewind-style'
    style.textContent = [
      '.dar-turn-revert{display:flex;justify-content:flex-end;margin:2px 0 0;line-height:1}',
      '.dar-turn-revert-btn{display:inline-flex;align-items:center;gap:4px;',
      'border:0;background:transparent;cursor:pointer;padding:3px 7px;border-radius:var(--dsw-radius-sm,6px);',
      'color:var(--dsw-alias-label-tertiary,#8a8a93);',
      'font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'opacity:.78;transition:opacity .12s ease,background .12s ease,color .12s ease}',
      '.dar-turn-revert-btn:hover{opacity:1;color:var(--dsw-alias-label-secondary,#b9b9c2);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dar-turn-revert-btn[disabled]{cursor:default;opacity:.45}',
      '.dar-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483000;',
      'max-width:min(560px,calc(100vw - 40px));padding:9px 14px;border-radius:10px;',
      'border:1px solid var(--dsw-alias-border-l2,#3a3a42);',
      'background:var(--dsw-alias-button-floating-fill,#1f2024);color:var(--dsw-alias-label-primary,#e9e9ec);',
      'box-shadow:0 10px 34px rgba(0,0,0,.32);',
      'font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.6;',
      'white-space:pre-wrap;word-break:break-word}',
      '.dar-toast[data-kind=error]{border-color:var(--dsw-alias-state-error-primary,#e5484d)}',
    ].join('')
    document.head.appendChild(style)
  }

  function showToast(text, kind) {
    injectStyle()
    if (!toastNode) {
      toastNode = document.createElement('div')
      toastNode.className = 'dar-toast'
      document.body.appendChild(toastNode)
    }
    toastNode.textContent = text
    toastNode.setAttribute('data-kind', kind === 'error' ? 'error' : 'ok')
    toastNode.style.display = 'block'
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      if (toastNode) toastNode.style.display = 'none'
    }, kind === 'error' ? 9000 : 6500)
  }

  function formatBytes(bytes) {
    var value = Number(bytes) || 0
    var units = ['B', 'KiB', 'MiB', 'GiB']
    var unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024
      unit += 1
    }
    return value.toFixed(unit === 0 ? 0 : 1) + ' ' + units[unit]
  }

  // --------------------------------------------------------------- plumbing

  function conversationRoot() {
    return document.querySelector(ROOT_SELECTOR)
  }

  function currentSessionId() {
    var root = conversationRoot()
    return root ? root.getAttribute('data-conversation-session') : null
  }

  function userNodes() {
    var list = document.querySelectorAll(USER_SELECTOR)
    var result = []
    for (var index = 0; index < list.length; index += 1) result.push(list[index])
    return result
  }

  function buttonLabel(point) {
    return '回退到第 ' + point.turn + ' 轮对话之前'
  }

  function buttonTitle(point) {
    var parts = [buttonLabel(point)]
    if (point.changed) parts.push('本轮改动 ' + point.changed + ' 个文件')
    if (point.preview) parts.push('「' + point.preview + '」')
    if (state.storage && state.storage.dataDir) {
      parts.push('快照: ' + state.storage.dataDir + (state.storage.diskBytes ? '（' + formatBytes(state.storage.diskBytes) + '）' : ''))
    }
    return parts.join(' · ')
  }

  function ensureButton(node, point) {
    var existing = node.querySelector('[' + BUTTON_MARKER + ']')
    var turn = String(point.turn)
    if (existing) {
      if (existing.getAttribute(BUTTON_MARKER) !== turn) existing.remove()
      else {
        var label = existing.querySelector('.dar-label')
        if (label) label.textContent = buttonLabel(point)
        existing.title = buttonTitle(point)
        var innerButton = existing.querySelector('button')
        if (innerButton) innerButton.title = buttonTitle(point)
        return
      }
    }
    var wrapper = document.createElement('div')
    wrapper.className = 'dar-turn-revert'
    wrapper.setAttribute(BUTTON_MARKER, turn)
    var button = document.createElement('button')
    button.className = 'dar-turn-revert-btn'
    button.type = 'button'
    button.title = buttonTitle(point)
    var icon = document.createElement('span')
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = '↩'
    var label = document.createElement('span')
    label.className = 'dar-label'
    label.textContent = buttonLabel(point)
    button.appendChild(icon)
    button.appendChild(label)
    button.addEventListener('click', function () {
      revert(point)
    })
    wrapper.appendChild(button)
    node.appendChild(wrapper)
  }

  function reconcile() {
    scheduled = false
    var sessionId = currentSessionId()
    if (!sessionId) return
    if (sessionId !== state.sessionId) {
      state.sessionId = sessionId
      state.points = new Map()
      state.lastFetchAt = 0
      fetchPoints()
    }
    var nodes = userNodes()
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index]
      var turn = Number(node.getAttribute('data-chat-turn'))
      if (!Number.isFinite(turn)) continue
      var point = state.points.get(turn)
      var existing = node.querySelector('[' + BUTTON_MARKER + ']')
      if (!point) {
        if (existing) existing.remove()
        continue
      }
      ensureButton(node, point)
    }
    // Drop controls whose owner node React replaced or that lost their point.
    var stale = document.querySelectorAll('[' + BUTTON_MARKER + ']')
    for (var staleIndex = 0; staleIndex < stale.length; staleIndex += 1) {
      var owner = stale[staleIndex].parentNode
      var ownerKind = owner && owner.getAttribute ? owner.getAttribute('data-chat-flow-kind') : null
      if (ownerKind !== 'user') stale[staleIndex].remove()
    }
  }

  function scheduleReconcile() {
    if (scheduled) return
    scheduled = true
    setTimeout(reconcile, 120)
  }

  function fetchPoints() {
    var sessionId = state.sessionId
    if (!sessionId || state.fetching) return Promise.resolve()
    state.fetching = true
    return Promise.all([
      api('/api/points?sessionId=' + encodeURIComponent(sessionId) + '&limit=200'),
      api('/api/status').catch(function () { return null }),
    ]).then(function (results) {
      state.fetching = false
      state.lastFetchAt = Date.now()
      if (sessionId !== state.sessionId) return
      var payload = results[0] || {}
      var status = results[1]
      if (status && status.storage) state.storage = status.storage
      var map = new Map()
      var points = payload.points || []
      for (var index = 0; index < points.length; index += 1) {
        var point = points[index]
        if (point.type !== 'before-chat-turn' || !Number.isFinite(point.turn)) continue
        map.set(point.turn, point)
      }
      state.points = map
      reconcile()
    }).catch(function (error) {
      state.fetching = false
      showToast('读取回滚点失败：' + (error && error.message ? error.message : error), 'error')
    })
  }

  function revert(point) {
    if (state.busy) return
    var ok = window.confirm(
      '回退到第 ' + point.turn + ' 轮对话发起之前？\n\n'
      + '· 该轮及之后 AI 对工作区文件的修改将被撤销\n'
      + '· 回退前会自动记录安全快照，可再次回退\n'
      + '· 已打开的文件请在编辑器中重新打开以刷新内容',
    )
    if (!ok) return
    state.busy = true
    showToast('正在回退到第 ' + point.turn + ' 轮之前…', 'ok')
    api('/api/revert', { body: { sessionId: state.sessionId, target: point.version } })
      .then(function (result) {
        state.busy = false
        var lines = [
          '已回退到第 ' + point.turn + ' 轮之前：还原 ' + result.restored.length + ' 个文件，删除 '
            + result.removed.length + ' 个文件',
        ]
        if (result.skipped && result.skipped.length) lines.push('跳过 ' + result.skipped.length + ' 个外部改动文件')
        if (result.warnings && result.warnings.length) lines.push('警告：' + result.warnings.length + ' 个文件未还原')
        if (result.safetyVersion) lines.push('安全快照 v' + result.safetyVersion)
        showToast(lines.join('\n'), 'ok')
        return fetchPoints()
      })
      .catch(function (error) {
        state.busy = false
        showToast('回退失败：' + (error && error.message ? error.message : error), 'error')
      })
  }

  // ------------------------------------------------------------------ mount

  function start() {
    injectStyle()
    scheduleReconcile()
    if (typeof MutationObserver === 'function') {
      var observer = new MutationObserver(function () { scheduleReconcile() })
      observer.observe(document.body, { childList: true, subtree: true })
    }
    // Light polling: each new turn adds a rewind point.
    setInterval(function () {
      if (!currentSessionId()) return
      if (Date.now() - state.lastFetchAt < 2500) return
      fetchPoints()
    }, 2500)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }

  window.__dshAllRewind = {
    refresh: fetchPoints,
    reconcile: reconcile,
    state: state,
  }
})()
