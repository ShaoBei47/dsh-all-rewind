// Real-Cordis load smoke: proves the plugin module is a valid Cordis plugin
// (apply() must not return an arbitrary value), that services resolve, and that a
// turn/start event produces a shadow-git anchor. Skipped automatically when a
// Cordis build is not reachable.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import plugin from '../lib/index.js'
import { makeTempDir, makeWorkspace, cleanup, fakeSession } from './helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function findCordis() {
  const candidates = [
    process.env.DSH_CORDIS_PATH,
    path.resolve(HERE, '..', '.tmp', 'asar', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
    'F:/plugins/.tmp/asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // next
    }
  }
  return undefined
}

const cordisPath = findCordis()

test('loads and disposes inside a real Cordis context', { skip: !cordisPath && 'cordis build not found (set DSH_CORDIS_PATH)' }, async () => {
  const { Context } = await import(`file://${cordisPath.replace(/\\/g, '/')}`)
  const root = new Context()
  const tools = new Map()
  const routes = new Map()
  root.provide('webServer', {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    tapIndex() {
      return () => {}
    },
  })
  root.provide('tools', {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  })
  root.provide('sessions', { get: () => undefined })
  root.provide('agents', { list: () => [] })
  root.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) })

  const workspace = makeWorkspace({ 'a.txt': 'v1' })
  const dataDir = makeTempDir('dsh-all-rewind-cordis-')
  try {
    root.plugin(plugin, { dataDir, keepTurns: 5 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual([...tools.keys()].sort(), ['rewind_list', 'rewind_prune', 'rewind_restore', 'rewind_status'])
    assert.ok(routes.has('/dsh-all-rewind/api/rewind'))
    assert.ok(routes.has('/dsh-all-rewind/ui.js'))

    const session = fakeSession('session-cordis-1', workspace)
    root.emit('session/created', session)
    root.emit('session/event', session, { type: 'turn/start', data: { turn: 1 }, seq: 0, time: Date.now() })
    // Give the queued git snapshot time to finish inside the real event loop.
    const stateFile = path.join(dataDir, 'shadows')
    const deadline = Date.now() + 20_000
    let anchored = false
    while (Date.now() < deadline) {
      const dirs = fs.existsSync(stateFile) ? fs.readdirSync(stateFile) : []
      for (const entry of dirs) {
        const statePath = path.join(stateFile, entry, 'state.json')
        if (!fs.existsSync(statePath)) continue
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
        const record = state.sessions?.['session-cordis-1']
        if (record && Object.keys(record.turns ?? {}).length > 0) anchored = true
      }
      if (anchored) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(anchored, true, 'a turn anchor was recorded in the shadow state')
    assert.ok(fs.existsSync(path.join(dataDir, 'shadows')), 'shadow storage created')
    assert.ok(tools.has('rewind_status'))

    await root.fiber.dispose()
  } finally {
    cleanup(workspace, dataDir)
  }
})
