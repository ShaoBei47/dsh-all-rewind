// Client script test: executes the real assets/ui.js against a tiny DOM stub and
// asserts the per-user-message rewind control, the in-place visual collapse, the
// composer backfill and the persisted cut marker.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_FILE = path.resolve(HERE, '..', 'assets', 'ui.js')
const SOURCE = fs.readFileSync(UI_FILE, 'utf8')
const CUT_PREFIX = 'dsh-all-rewind:cut:'
const HIDDEN_MARKER = 'data-dar-hidden'

// ---------------------------------------------------------------- DOM stub

class FakeNode {
  constructor(tagName) {
    this.tagName = String(tagName || '').toUpperCase()
    this.nodeType = 1
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

  removeAttribute(name) {
    delete this.attributes[name]
  }

  addEventListener(event, handler) {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(handler)
  }

  click() {
    for (const handler of this.listeners.click ?? []) handler()
  }

  focus() {}

  matches(selector) {
    return matches(this, selector)
  }

  closest(selector) {
    let node = this
    while (node) {
      if (node.matches && node.matches(selector)) return node
      node = node.parentNode
    }
    return null
  }

  querySelector(selector) {
    return findAll(this.children, selector)[0] ?? null
  }

  querySelectorAll(selector) {
    return findAll(this.children, selector)
  }

  get nextElementSibling() {
    if (!this.parentNode) return null
    const siblings = this.parentNode.children
    const index = siblings.indexOf(this)
    return index >= 0 ? siblings[index + 1] ?? null : null
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

/** Supports the selectors the panel uses: `.class`, `[attr]`, `[attr="value"]`. */
function matches(node, selector) {
  if (!node || typeof node !== 'object' || !node.getAttribute) return false
  const parts = String(selector).match(/\[[^\]]+\]|\.[A-Za-z0-9_-]+/g)
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
    execCommand: () => true,
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

/**
 * Build a transcript:
 *   root[data-conversation-session]
 *     flow (each: [data-chat-flow-kind])
 *       user bubble (user flow: data-chat-flow-kind="user" data-chat-turn)
 *     composer[contenteditable="true"]
 */
function conversationDom(document, { sessionId = 'session-ui-1', turns = [1, 2] } = {}) {
  const root = new FakeNode('div')
  root.setAttribute('data-conversation-session', sessionId)
  document.body.appendChild(root)
  for (const turn of turns) {
    const item = new FakeNode('div')
    item.className = 'flow-item'
    item.setAttribute('data-chat-flow-kind', 'user')
    item.setAttribute('data-chat-turn', String(turn))
    const label = new FakeNode('div')
    label.className = 'bubble'
    label.textContent = `第 ${turn} 轮用户提示词`
    item.appendChild(label)
    root.appendChild(item)
    const reply = new FakeNode('div')
    reply.className = 'flow-item'
    reply.setAttribute('data-chat-flow-kind', 'assistant-step')
    reply.setAttribute('data-chat-turn', String(turn))
    reply.textContent = `第 ${turn} 轮 AI 回复`
    root.appendChild(reply)
  }
  // The composer lives outside the transcript, like the real app.
  const composer = new FakeNode('div')
  composer.setAttribute('contenteditable', 'true')
  composer.textContent = ''
  document.body.appendChild(composer)
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
      return {
        ok: false,
        status: value.__status.code,
        text: async () => JSON.stringify({ error: value.__status.error, code: value.__status.code }),
      }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(value) }
  }
  return { fetch, calls }
}

function point(turn, seq, prompt = `第 ${turn} 轮提示词`) {
  return {
    turn,
    label: `before-chat-turn-${turn}`,
    commit: String(turn).padStart(40, 'a'),
    seq,
    seqBefore: seq - 1,
    time: Date.now() - turn * 60_000,
    preview: prompt,
    prompt,
    filesChanged: turn,
    rewindable: true,
  }
}

function pointsPayload(sessionId, points, pendingCut = null) {
  return { ok: true, sessionId, workspace: 'F:/demo/project', conversation: true, pendingCut, points }
}

function statusPayload() {
  return {
    ok: true,
    storage: { dataDir: 'F:/demo/.dsh/dsh-all-rewind', diskBytes: 1024 },
    git: { available: true, version: '2.45.1', executable: 'git' },
  }
}

// ------------------------------------------------------------------ harness

async function flush(times = 10) {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitFor(predicate, { timeout = 2500, interval = 5 } = {}) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  return false
}

function bootUi(options = {}) {
  const document = createDom()
  if (options.conversation !== false) conversationDom(document, options)
  let currentPendingCut = options.pendingCut ?? null
  const routes = {
    '/api/points': () => pointsPayload(
      options.sessionId ?? 'session-ui-1',
      options.points ?? [point(1, 10), point(2, 20)],
      currentPendingCut,
    ),
    '/api/status': statusPayload(),
    '/api/rewind': {
      ok: true,
      turn: 1,
      files: { restored: ['src/a.ts'], removed: ['src/old.ts'], safetyCommit: 'f'.repeat(40) },
      conversation: { deferred: true, mode: 'surface-replace', turn: 1, cutAtSeq: 10 },
      warnings: [],
    },
    ...(options.routes ?? {}),
  }
  const { fetch, calls } = createFetch(routes)
  const observers = []
  const intervals = []
  const storage = new Map(Object.entries(options.localStorage ?? {}))
  let reloads = 0
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
  const window = {
    confirm: () => options.confirmAnswer !== false,
    fetch,
    getSelection: () => null,
    location: { reload: () => { reloads += 1 } },
  }
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
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
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
  api.reconcile()
  return {
    window,
    document,
    calls,
    api,
    observers,
    intervals,
    routes,
    storage,
    setPendingCut: (cut) => { currentPendingCut = cut },
    reloads: () => reloads,
  }
}

function flowItems(document) {
  return document.querySelectorAll('.flow-item')
}

function userFlow(document, turn) {
  return flowItems(document).find((node) => node.getAttribute('data-chat-flow-kind') === 'user'
    && node.getAttribute('data-chat-turn') === String(turn))
}

function controls(node) {
  return node.querySelectorAll('[data-dsh-all-rewind]')
}

function isHidden(node) {
  return node.getAttribute(HIDDEN_MARKER) === '1' || node.style.display === 'none'
}

function composer(document) {
  return document.querySelector('[contenteditable="true"]')
}

// -------------------------------------------------------------------- tests

test('does nothing when the page has no conversation root', async () => {
  const ui = bootUi({ conversation: false })
  await flush()
  assert.equal(ui.calls.length, 0)
  assert.equal(ui.document.querySelectorAll('[data-dsh-all-rewind]').length, 0)
})

test('renders a rewind action under every prompt that has an anchor', async () => {
  const ui = bootUi()
  assert.ok(await waitFor(() => controls(userFlow(ui.document, 1)).length === 1))
  assert.ok(await waitFor(() => controls(userFlow(ui.document, 2)).length === 1))
  assert.ok(ui.calls.some((call) => call.url.includes('/api/points?sessionId=session-ui-1')))
  for (const turn of [1, 2]) {
    const found = controls(userFlow(ui.document, turn))
    assert.equal(found[0].querySelector('.dar-label').textContent, `回退到第 ${turn} 轮对话之前`)
    assert.match(found[0].title || found[0].children[0].title, /git 2\.45\.1/)
  }
  for (const node of flowItems(ui.document)) {
    if (node.getAttribute('data-chat-flow-kind') !== 'user') assert.equal(controls(node).length, 0)
  }
})

test('clicking rewinds files, collapses later messages, backfills the prompt and stores the cut', async () => {
  const ui = bootUi()
  ui.setPendingCut({ turn: 2, cutAtSeq: 20 })
  assert.ok(await waitFor(() => controls(userFlow(ui.document, 2)).length === 1))
  controls(userFlow(ui.document, 2))[0].children[0].click()
  assert.ok(await waitFor(() => ui.calls.find((entry) => entry.url === '/dsh-all-rewind/api/rewind')))
  const call = ui.calls.find((entry) => entry.url === '/dsh-all-rewind/api/rewind')
  assert.equal(call.init.method, 'POST')
  assert.deepEqual(JSON.parse(call.init.body), { sessionId: 'session-ui-1', turn: 2, mode: 'all' })

  // The clicked prompt and everything after it are visually collapsed...
  assert.ok(await waitFor(() => isHidden(userFlow(ui.document, 2))))
  assert.equal(isHidden(userFlow(ui.document, 1)), false, 'earlier prompts stay visible')
  // ...the prompt is backfilled for editing...
  assert.equal(composer(ui.document).textContent, '第 2 轮提示词')
  // ...and the cut marker is persisted for the next page load.
  const marker = JSON.parse(ui.storage.get(`${CUT_PREFIX}session-ui-1`))
  assert.equal(marker.turn, 2)
  assert.equal(marker.key, '第 2 轮提示词')
  assert.equal(ui.reloads(), 0, 'in-place rewind never reloads the page')
  const toast = ui.document.querySelector('.dar-toast')
  assert.match(toast.textContent, /已回退到第 2 轮之前/)
  assert.match(toast.textContent, /对话已折叠/)
  assert.match(toast.textContent, /回填到输入框/)
})

test('cancelling the confirm dialog does not call the API', async () => {
  const ui = bootUi({ confirmAnswer: false })
  assert.ok(await waitFor(() => controls(userFlow(ui.document, 1)).length === 1))
  controls(userFlow(ui.document, 1))[0].children[0].click()
  await flush()
  assert.ok(!ui.calls.some((call) => call.url === '/dsh-all-rewind/api/rewind'))
})

test('a persisted cut is re-applied after a reload', async () => {
  const ui = bootUi({
    pendingCut: { turn: 2, cutAtSeq: 20 },
    localStorage: {
      [`${CUT_PREFIX}session-ui-1`]: JSON.stringify({ turn: 2, key: '第 2 轮提示词' }),
    },
  })
  assert.ok(await waitFor(() => isHidden(userFlow(ui.document, 2))), 'stored cut collapsed the transcript')
  assert.equal(isHidden(userFlow(ui.document, 1)), false)
})

test('the stored cut is cleared once the host applied it', async () => {
  const ui = bootUi({
    pendingCut: null,
    points: [point(1, 10)],
    localStorage: {
      [`${CUT_PREFIX}session-ui-1`]: JSON.stringify({ turn: 2, key: '第 2 轮提示词' }),
    },
  })
  // Wait for the points fetch: the pending cut is gone and the prompt no longer
  // exists (the surface replace removed it), so the marker must be dropped.
  assert.ok(await waitFor(() => ui.calls.some((call) => call.url.includes('/api/points'))))
  await flush()
  assert.equal(ui.storage.has(`${CUT_PREFIX}session-ui-1`), false)
})

test('mutation observer re-attaches the action after React replaces the node', async () => {
  const ui = bootUi()
  assert.ok(await waitFor(() => controls(userFlow(ui.document, 1)).length === 1))
  const node = userFlow(ui.document, 1)
  controls(node)[0].remove()
  assert.equal(controls(node).length, 0)
  ui.observers[0].trigger()
  assert.ok(await waitFor(() => controls(node).length === 1), 'action re-attached')
})

test('polling refreshes points so new turns appear without a reload', async () => {
  const ui = bootUi({ points: [point(1, 10)] })
  assert.ok(await waitFor(() => controls(userFlow(ui.document, 1)).length === 1))
  assert.equal(controls(userFlow(ui.document, 2)).length, 0)
  ui.routes['/api/points'] = pointsPayload('session-ui-1', [point(1, 10), point(2, 20)])
  ui.api.state.lastFetchAt = 0
  ui.intervals[0]()
  assert.ok(await waitFor(() => controls(userFlow(ui.document, 2)).length === 1), 'new turn control appeared')
})

test('a failed rewind surfaces an error toast and keeps the transcript intact', async () => {
  const ui = bootUi({
    routes: {
      '/api/rewind': { __status: { code: 409, error: 'session is still running' } },
    },
  })
  assert.ok(await waitFor(() => controls(userFlow(ui.document, 1)).length === 1))
  controls(userFlow(ui.document, 1))[0].children[0].click()
  assert.ok(await waitFor(() => {
    const toast = ui.document.querySelector('.dar-toast')
    return toast && /回退失败/.test(toast.textContent)
  }))
  assert.equal(isHidden(userFlow(ui.document, 1)), false)
  assert.ok(!ui.storage.has(`${CUT_PREFIX}session-ui-1`))
})

test('a points read failure surfaces an error toast', async () => {
  const ui = bootUi({
    routes: {
      '/api/points': { __status: { code: 500, error: 'shadow repository unavailable' } },
    },
  })
  assert.ok(await waitFor(() => {
    const toast = ui.document.querySelector('.dar-toast')
    return toast && /读取回退点失败/.test(toast.textContent)
  }))
  assert.match(ui.document.querySelector('.dar-toast').textContent, /shadow repository unavailable/)
})
