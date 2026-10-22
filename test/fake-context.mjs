// A deliberately small Cordis stand-in: only the API surface the plugin uses.
// Cordis executes `ctx.effect(fn)` immediately and keeps `fn()`'s disposer, and
// `ctx.inject(deps, cb)` runs `cb` once the deps exist. The fake mirrors that so
// plugin wiring is exercised without booting the whole DSH host.

export function createFakeContext(initialServices = {}) {
  const services = { ...initialServices }
  const listeners = new Map()
  const tools = new Map()
  const routes = new Map()
  const taps = []
  const effects = []
  const logs = []

  const ctx = {
    logger(name) {
      const record = (level) => (message) => logs.push({ level, name, message: String(message) })
      return { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') }
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name)?.delete(fn)
    },
    emit(name, ...args) {
      for (const fn of listeners.get(name) ?? []) fn(...args)
      return true
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') effects.push(disposer)
      else if (disposer && typeof disposer[Symbol.asyncDispose] === 'function') effects.push(() => disposer[Symbol.asyncDispose]())
      return disposer
    },
    inject(deps, callback) {
      for (const dep of deps) {
        if (!(dep in services)) throw new Error(`fake ctx: missing injected service ${dep}`)
      }
      // Cordis hands the injected callback a context that can read services as
      // properties (`ready.tools`); use the proxy once it exists.
      callback(proxyRef.current)
      return () => {}
    },
    get(key) {
      return services[key]
    },
    set(key, value) {
      services[key] = value
      return value
    },
    async dispose() {
      for (const dispose of effects.splice(0)) {
        try {
          await dispose()
        } catch {
          // keep disposing
        }
      }
    },
  }

  const webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    tapIndex(transform) {
      taps.push(transform)
      return () => taps.splice(taps.indexOf(transform), 1)
    },
    applyIndexTaps(html) {
      return taps.reduce((acc, transform) => transform(acc), html)
    },
  }
  const toolRuntime = {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
    get(name) {
      return tools.get(name)
    },
  }

  services.webServer = services.webServer ?? webServer
  services.tools = services.tools ?? toolRuntime
  if (!('sessions' in services)) services.sessions = { get: () => undefined }
  if (!('agents' in services)) services.agents = { list: () => [] }
  if (!('sandboxPolicy' in services)) services.sandboxPolicy = { resolve: () => ({ mode: 'workspace-write' }) }

  const proxyRef = { current: undefined }
  // Cordis mixes services onto the context (`ctx.tools`, `ctx.webServer`, ...);
  // a proxy reproduces that without hand-writing every property.
  const proxy = new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (prop in services) return services[prop]
      return undefined
    },
    set(target, prop, value, receiver) {
      if (prop in target) return Reflect.set(target, prop, value, receiver)
      services[prop] = value
      return true
    },
    has(target, prop) {
      return prop in target || prop in services
    },
  })
  proxyRef.current = proxy
  proxy.ctx = proxy
  return { ctx: proxy, raw: ctx, services, listeners, tools, routes, taps, effects, logs, webServer }
}

/** Minimal http.ServerResponse stand-in. */
export function createMockResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
      return this
    },
    end(body) {
      this.body = typeof body === 'string' ? body : String(body ?? '')
      this.headersSent = true
      return this
    },
  }
}

/** Minimal http.IncomingMessage stand-in for a JSON request. */
export function createMockRequest({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8')
  const listeners = new Map()
  const req = {
    method,
    url,
    headers,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return req
    },
    destroy() {},
  }
  // Emit on the next tick so the handler has attached its listeners.
  process.nextTick(() => {
    for (const fn of listeners.get('data') ?? []) fn(payload)
    for (const fn of listeners.get('end') ?? []) fn()
  })
  return req
}

/** Invoke one registered route handler and await its response. */
export function callRoute(route, request) {
  const response = createMockResponse()
  const done = new Promise((resolve) => {
    const originalEnd = response.end.bind(response)
    response.end = (body) => {
      originalEnd(body)
      resolve(response)
    }
    route.handler(request, response)
  })
  return done
}
