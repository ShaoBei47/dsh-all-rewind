// Client script test: executes the real assets/ui.js against a tiny DOM stub and
// asserts the per-user-message rewind control, payload and re-attach behaviour.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_FILE = path.resolve(HERE, '..', 'assets', 'ui.js')
const SOURCE = fs.readFileSync(UI_FILE, 'utf8')

// ---------------------------------------------------------------- DOM stub

class FakeNode {
  constructor(tagName) {
    this.tagName = String(tagName || '').toUpperCase()
    this.children = []
    this.attributes = {}
    this.listeners = {}
    this.style = {}
    this.id = ''
    this.className = ''
    this.title = ''
    this.textContent = ''
    this.type = ''
    this.parentNode = null
  }

  appendChild(child) {
    this.children.push(child)
    if (child && typeof child === 'object') child.parentNode = this
    return child
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    if (child) child.parentNode = null
    return child
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
    if (name === 'id') this.id = String(value)
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
  }

  addEventListener(event, handler) {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(handler)
  }

  click() {
    for (const handler of this.listeners.click ?? []) handler()
  }

  querySelector(selector) {
    return findAll(this.children, selector)[0] ?? null
  }

  querySelectorAll(selector) {
    return findAll(this.children, selector)
  }
}

function findAll(roots, selector) {
  const result = []
  const visit = (node) => {
    if (matches(node, selector)) result.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  for (const root of roots) visit(root)
  return result
}

/** Supports the handful of selectors the panel uses: `.class` and `[attr]` / `[attr="value"]`. */
function matches(node, selector) {
  if (!node || typeof node !== 'object' || !node.getAttribute) return false
  const parts = selector.match(/\[[^\]]+\]|\.[A-Za-z0-9_-]+/g)
  if (!parts) return false
  return parts.every((part) => {
    if (part.startsWith('.')) {
      return String(node.className || '').split(/\s+/).includes(part.slice(1))
    }
    const body = part.slice(1, -1)
    const equalIndex = body.indexOf('=')
    if (equalIndex < 0) return node.getAttribute(body) !== null
    const name = body.slice(0, equalIndex)
    const value = body.slice(equalIndex + 1).replace(/^"|"$/g, '')
    return node.getAttribute(name) === value
  })
}

function createDom() {
  const document = {
    readyState: 'complete',
    head: new FakeNode('head'),
    body: new FakeNode('body'),
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    getElementById(id) {
      return findAll([document.body, document.head], '[id]').find((node) => node.id === id) ?? null
    },
    querySelector(selector) {
      return findAll([document.body], selector)[0] ?? null
    },
    querySelectorAll(selector) {
      return findAll([document.body], selector)
    },
    addEventListener() {},
  }
  return document
}

function conversationDom(document, { sessionId = 'session-ui-1', turns = [1, 2], includeRoot = true } = {}) {
  if (!includeRoot) return
  const root = new FakeNode('div')
  root.setAttribute('data-conversation-session', sessionId)
  document.body.appendChild(root)
  for (const turn of turns) {
    const userNode = new FakeNode('div')
    userNode.setAttribute('data-chat-flow-kind', 'user')
    userNode.setAttribute('data-chat-turn', String(turn))
    const bubble = new FakeNode('div')
    bubble.textContent = `第 ${turn} 轮用户提示词`
    userNode.appendChild(bubble)
    root.appendChild(userNode)
    const assistantNode = new FakeNode('div')
    assistantNode.setAttribute('data-chat-flow-kind', 'assistant-step')
    assistantNode.setAttribute('data-chat-turn', String(turn))
    root.appendChild(assistantNode)
  }
  return root
}

// -------------------------------------------------------------- fetch stub

function createFetch(routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url, init })
    const key = String(url).replace(/^\/dsh-all-rewind/, '').split('?')[0]
    const handler = routes[key]
    if (!handler) return { ok: false, status: 404, text: async () => JSON.stringify({ error: `no stub ${key}` }) }
    const value = typeof handler === 'function' ? handler(init) : handler
    if (value && value.__status) {
      return { ok: false, status: value.__status.code, text: async () => JSON.stringify({ error: value.__status.error }) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(value) }
  }
  return { fetch, calls }
}

function pointsPayload(sessionId, points) {
  return { sessionId, workspace: 'F:/demo/project', active: true, points }
}

function point(turn, version, extra = {}) {
  return {
    version,
    commit: String(version).padStart(64, 'a'),
    label: `before-chat-turn-${turn}`,
    type: 'before-chat-turn',
    turn,
    preview: `第 ${turn} 轮提示词`,
    time: Date.now() - turn * 60_000,
    changed: turn,
    files: 5,
    ...extra,
  }
}

// ------------------------------------------------------------------ harness

async function flush(times = 10) {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function tick(ms = 160) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function bootUi(options = {}) {
  const document = createDom()
  if (options.conversation !== false) conversationDom(document, options)
  const routes = {
    '/api/points': pointsPayload(options.sessionId ?? 'session-ui-1', options.points ?? [point(1, 10), point(2, 20)]),
    '/api/status': { ok: true, storage: { dataDir: 'F:/demo/.dsh/dsh-all-rewind', diskBytes: 6.8 * 1024 * 1024 } },
    '/api/revert': {
      ok: true,
      restored: ['src/a.ts', 'src/b.ts'],
      removed: ['src/old.ts'],
      skipped: [],
      conflicts: [],
      warnings: [],
      safetyVersion: 5,
      postVersion: 6,
      target: { version: 10, turn: 1, label: 'before-chat-turn-1' },
    },
    ...(options.routes ?? {}),
  }
  const { fetch, calls } = createFetch(routes)
  const observers = []
  const intervals = []
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback
      observers.push(this)
    }
    observe() {}
    disconnect() {}
    trigger() {
      this.callback()
    }
  }
  const window = { confirm: () => options.confirmAnswer !== false, fetch }
  const context = vm.createContext({
    window,
    document,
    fetch,
    console,
    setTimeout,
    clearTimeout,
    setInterval: (fn) => {
      intervals.push(fn)
      return intervals.length
    },
    clearInterval() {},
    Map,
    Set,
    Number,
    String,
    Date,
    Math,
    JSON,
    Promise,
    MutationObserver: FakeMutationObserver,
  })
  vm.runInContext(SOURCE, context, { filename: 'assets/ui.js' })
  const api = window.__dshAllRewind
  // start() debounces the first reconcile; drive it explicitly for deterministic tests.
  api.reconcile()
  return { window, document, calls, api, observers, intervals, routes }
}

function userNode(document, turn) {
  return document.querySelectorAll('[data-chat-flow-kind="user"][data-chat-turn]')
    .find((node) => node.getAttribute('data-chat-turn') === String(turn))
}

function controls(node) {
  return node.querySelectorAll('[data-dsh-all-rewind]')
}

function controlButton(wrapper) {
  return wrapper.children[0]
}

// -------------------------------------------------------------------- tests

async function waitFor(predicate, { timeout = 2500, interval = 5 } = {}) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  return false
}

test('does nothing when the page has no conversation root', async () => {
  const ui = bootUi({ conversation: false })
  await flush()
  assert.equal(ui.calls.length, 0)
  assert.equal(ui.document.querySelectorAll('[data-dsh-all-rewind]').length, 0)
})

test('renders a rewind action under every user prompt that has a snapshot', async () => {
  const ui = bootUi()
  assert.ok(await waitFor(() => controls(userNode(ui.document, 1)).length === 1))
  assert.ok(await waitFor(() => controls(userNode(ui.document, 2)).length === 1))
  assert.ok(ui.calls.some((call) => call.url.includes('/api/points?sessionId=session-ui-1')))
  for (const turn of [1, 2]) {
    const found = controls(userNode(ui.document, turn))
    const label = found[0].querySelector('.dar-label')
    assert.equal(label.textContent, `回退到第 ${turn} 轮对话之前`)
    assert.match(found[0].title || controlButton(found[0]).title, /快照: F:\/demo\/\.dsh\/dsh-all-rewind/)
  }
  for (const node of ui.document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')) {
    assert.equal(controls(node).length, 0, 'assistant nodes never get a control')
  }
})

test('no control is rendered for a turn without a rewind point', async () => {
  const ui = bootUi({ points: [point(2, 20)] })
  assert.ok(await waitFor(() => controls(userNode(ui.document, 2)).length === 1))
  assert.equal(controls(userNode(ui.document, 1)).length, 0)
})

test('clicking the action posts the exact revert payload and reports the result', async () => {
  const ui = bootUi()
  assert.ok(await waitFor(() => controls(userNode(ui.document, 1)).length === 1))
  controlButton(controls(userNode(ui.document, 1))[0]).click()
  const revertCall = await waitFor(() => ui.calls.find((call) => call.url === '/dsh-all-rewind/api/revert'))
  assert.ok(ui.calls.find((call) => call.url === '/dsh-all-rewind/api/revert'), 'POST /api/revert issued')
  const call = ui.calls.find((entry) => entry.url === '/dsh-all-rewind/api/revert')
  assert.equal(call.init.method, 'POST')
  const payload = JSON.parse(call.init.body)
  assert.equal(payload.sessionId, 'session-ui-1')
  assert.equal(payload.target, 10)
  assert.ok(await waitFor(() => {
    const toast = ui.document.querySelector('.dar-toast')
    return toast && /已回退到第 1 轮之前/.test(toast.textContent)
  }), 'result toast rendered')
  const toast = ui.document.querySelector('.dar-toast')
  assert.match(toast.textContent, /还原 2 个文件/)
  assert.match(toast.textContent, /安全快照 v5/)
})

test('cancelling the confirm dialog does not call the API', async () => {
  const ui = bootUi({ confirmAnswer: false })
  assert.ok(await waitFor(() => controls(userNode(ui.document, 1)).length === 1))
  controlButton(controls(userNode(ui.document, 1))[0]).click()
  await flush()
  assert.ok(!ui.calls.some((call) => call.url === '/dsh-all-rewind/api/revert'))
})

test('mutation observer re-attaches the action after React replaces the node', async () => {
  const ui = bootUi()
  assert.ok(await waitFor(() => controls(userNode(ui.document, 1)).length === 1))
  const node = userNode(ui.document, 1)
  controls(node)[0].remove()
  assert.equal(controls(node).length, 0)
  ui.observers[0].trigger()
  assert.ok(await waitFor(() => controls(node).length === 1), 'action re-attached')
})

test('switching sessions refetches points for the new session', async () => {
  const ui = bootUi()
  assert.ok(await waitFor(() => controls(userNode(ui.document, 1)).length === 1))
  const before = ui.calls.filter((call) => call.url.includes('/api/points')).length
  ui.document.querySelector('[data-conversation-session]').setAttribute('data-conversation-session', 'session-ui-2')
  ui.routes['/api/points'] = pointsPayload('session-ui-2', [point(1, 33)])
  ui.api.reconcile()
  assert.ok(await waitFor(() => ui.calls.filter((call) => call.url.includes('/api/points')).length > before))
  assert.ok(ui.calls.filter((call) => call.url.includes('/api/points')).at(-1).url.includes('sessionId=session-ui-2'))
  assert.ok(await waitFor(() => controls(userNode(ui.document, 1)).length === 1))
  assert.match(controls(userNode(ui.document, 1))[0].title || controlButton(controls(userNode(ui.document, 1))[0]).title, /本轮改动/)
})

test('polling refreshes points so new turns appear without a reload', async () => {
  const ui = bootUi({ points: [point(1, 10)] })
  assert.ok(await waitFor(() => controls(userNode(ui.document, 1)).length === 1))
  assert.equal(controls(userNode(ui.document, 2)).length, 0)
  ui.routes['/api/points'] = pointsPayload('session-ui-1', [point(1, 10), point(2, 20)])
  ui.api.state.lastFetchAt = 0
  ui.intervals[0]()
  assert.ok(await waitFor(() => controls(userNode(ui.document, 2)).length === 1), 'new turn control appeared')
})

test('API failure surfaces an error toast', async () => {
  const ui = bootUi({
    routes: {
      '/api/points': { __status: { code: 500, error: 'snapshot store unavailable' } },
    },
  })
  assert.ok(await waitFor(() => {
    const toast = ui.document.querySelector('.dar-toast')
    return toast && /回滚点失败/.test(toast.textContent)
  }), 'error toast rendered')
  assert.match(ui.document.querySelector('.dar-toast').textContent, /snapshot store unavailable/)
})
