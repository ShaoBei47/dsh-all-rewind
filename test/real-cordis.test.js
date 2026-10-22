// Real-Cordis load smoke: proves the plugin module is a valid Cordis plugin
// (apply() must not return an arbitrary value) and that services resolve.
// Skipped automatically when a Cordis build is not reachable.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import plugin from '../lib/index.js'
import { makeTempDir, makeWorkspace, cleanup } from './helpers.mjs'

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
    assert.ok(routes.has('/dsh-all-rewind/ui.js'))

    root.emit('session/created', { id: 'session-cordis-1', header: { cwd: workspace } })
    root.emit('session/event', { id: 'session-cordis-1' }, { type: 'turn/start', data: { turn: 1 }, seq: 1, time: Date.now() })
    await new Promise((resolve) => setTimeout(resolve, 200))

    const sessionDir = path.join(dataDir, 'snapshots', 'session-cordis-1', 'v2')
    assert.ok(fs.existsSync(path.join(sessionDir, 'first_graph.json')))
    assert.ok(fs.existsSync(path.join(sessionDir, 'objects')))
    assert.ok(fs.existsSync(path.join(sessionDir, 'version_file_1.json')))

    await root.fiber.dispose()
    assert.ok(true)
  } finally {
    cleanup(workspace, dataDir)
  }
})
