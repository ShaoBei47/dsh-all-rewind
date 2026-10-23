// Loader-level integration: copy the package into a throwaway profile's
// node_modules and let the real Cordis loader import + start it by name, which
// is exactly what DSH does with a `cordis.patch.yml` insert entry.
// Skipped when a Cordis/Loader build is not reachable.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')

function resolveRuntime() {
  const candidates = [
    process.env.DSH_CORDIS_PATH,
    path.resolve(PACKAGE_ROOT, '.tmp', 'asar', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
    'F:/plugins/.tmp/asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js',
  ].filter(Boolean)
  for (const cordis of candidates) {
    try {
      if (!fs.statSync(cordis).isFile()) continue
      const loader = path.resolve(path.dirname(cordis), '..', '..', 'cordis-plugin-loader', 'lib', 'index.js')
      if (fs.statSync(loader).isFile()) return { cordis, loader }
    } catch {
      // next candidate
    }
  }
  return undefined
}

const runtime = resolveRuntime()

test('Cordis loader imports the installed package by name and starts it', {
  skip: !runtime && 'cordis + loader build not found (set DSH_CORDIS_PATH)',
}, async () => {
  const { Context } = await import(pathToFileURL(runtime.cordis).href)
  const Loader = (await import(pathToFileURL(runtime.loader).href)).default

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-all-rewind-loader-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(profile, '.dsh')
  try {
    const target = path.join(profile, 'node_modules', 'dsh-all-rewind')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(PACKAGE_ROOT, target, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}test`) && !src.includes(`${path.sep}.tmp`),
    })

    const root = new Context()
    const tools = new Map()
    const routes = new Map()
    root.provide('tools', {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    })
    root.provide('webServer', {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
      tapIndex() {
        return () => {}
      },
    })
    root.provide('sessions', { get: () => undefined })
    root.provide('agents', { list: () => [] })
    root.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) })

    await root.plugin(Loader, { baseUrl: pathToFileURL(`${profile}${path.sep}`).href })
    // DSH installs a profile-aware module importer here; the raw loader falls
    // back to Node's bare resolution, which cannot see a temp profile. Mirror the
    // real importer so `import('dsh-all-rewind')` resolves inside `node_modules`.
    root.loader.internal = {
      async import(name) {
        if (name.startsWith('.')) return import(pathToFileURL(path.resolve(profile, name)).href)
        const packageDir = path.join(profile, 'node_modules', ...name.split('/'))
        const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
        const entry = path.join(packageDir, manifest.main ?? 'lib/index.js')
        return import(pathToFileURL(entry).href)
      },
    }
    await root.loader.create({ id: 'dsh-all-rewind', name: 'dsh-all-rewind', config: { keepTurns: 5 } })
    await root.loader.await()
    await new Promise((resolve) => setTimeout(resolve, 300))

    assert.deepEqual([...tools.keys()].sort(), ['rewind_list', 'rewind_prune', 'rewind_restore', 'rewind_status'])
    assert.ok(routes.has('/dsh-all-rewind/api/rewind'))
    assert.ok(routes.has('/dsh-all-rewind/api/status'))
    assert.ok(routes.has('/dsh-all-rewind/ui.js'))

    await root.fiber.dispose()
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(profile, { recursive: true, force: true })
  }
})
