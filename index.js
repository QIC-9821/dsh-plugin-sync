import { Engine, readVersion } from './lib/engine.js'
import { createRoutes } from './lib/http.js'

export const name = '@qic-9821/dsh-plugin-sync'

/**
 * Config is optional: hosts without @deepseek-ai/schemastery must still load
 * the plugin (they just lose the generated settings form).
 */
let z = null
try {
  const mod = await import('@deepseek-ai/schemastery')
  z = mod?.default ?? mod ?? null
} catch {
  z = null
}

const field = (schema) => (typeof schema?.extra === 'function' ? schema.extra('volatile', true) : schema)

export const Config = z
  ? z.object({
      enabled: field(z.boolean().default(true)),
      autoStart: field(z.boolean().default(true)),
      autoRestart: field(z.boolean().default(true)),
      intervalMinutes: field(z.natural().default(0)),
      startupDelaySec: field(z.natural().default(25)),
      direction: field(z.string().default('push')),
      conflict: field(z.string().default('local')),
      peerMode: field(z.string().default('off')),
      peerUrl: field(z.string().default('')),
      peerToken: field(z.string().default('')),
      peerName: field(z.string().default('')),
      localName: field(z.string().default('')),
      peerHost: field(z.string().default('')),
      peerUser: field(z.string().default('')),
      peerPort: field(z.natural().default(22)),
      peerKey: field(z.string().default('')),
      peerHttpPort: field(z.natural().default(18777)),
      capPlugins: field(z.boolean().default(true)),
      capConfig: field(z.boolean().default(false)),
      capInstall: field(z.boolean().default(false)),
      capFiles: field(z.boolean().default(false)),
      capRemoteApply: field(z.boolean().default(true)),
      capSecrets: field(z.boolean().default(false)),
      include: field(z.array(z.string()).default([])),
      exclude: field(z.array(z.string()).default([])),
      profileDir: field(z.string().default('')),
      maxBundleBytes: field(z.natural().default(48 * 1024 * 1024)),
      timeoutMs: field(z.natural().default(60000)),
    })
  : undefined

export const inject = ['tools']

function pickLogger(logger) {
  if (typeof logger?.info === 'function') return logger
  return {
    info: (...args) => console.log('[plugin-sync]', ...args),
    warn: (...args) => console.warn('[plugin-sync]', ...args),
    error: (...args) => console.error('[plugin-sync]', ...args),
  }
}

export async function apply(ctx, config = {}) {
  const logger = pickLogger(ctx?.logger)
  const engine = new Engine({ ctx, config, env: process.env, logger })
  engine.version = readVersion(new URL('./package.json', import.meta.url))

  const disposers = []

  if (typeof ctx?.tools?.register === 'function') {
    try {
      disposers.push(ctx.tools.register(pluginSyncToolSpec(engine)))
      disposers.push(ctx.tools.register(pluginSyncConfigToolSpec(engine)))
    } catch (error) {
      logger.warn?.(`tool registration failed: ${error?.message || error}`)
    }
  }

  const mountRoutes = (hostCtx) => {
    const webServer = hostCtx?.webServer ?? hostCtx?.get?.('webServer')
    if (!webServer || typeof webServer.register !== 'function') return
    try {
      const origin = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : ''
      const routes = createRoutes({ engine, ctx, origin })
      disposers.push(webServer.register({ kind: 'prefix', path: '/plugin-sync', handler: routes.handle }))
    } catch (error) {
      logger.warn?.(`web route registration failed: ${error?.message || error}`)
    }
  }

  // On a cold boot a bundle row can be instantiated before the web server
  // exists (the server rides a later row); acquiring it lazily keeps the row
  // loading on profiles without a web UI too.
  if (typeof ctx?.inject === 'function') {
    disposers.push(ctx.inject(['webServer'], (hostCtx) => mountRoutes(hostCtx)))
  } else {
    mountRoutes(ctx)
  }

  try {
    engine.schedule()
  } catch (error) {
    logger.warn?.(`schedule failed: ${error?.message || error}`)
  }

  const cfg = engine.cfg()
  engine.log(`ready: profile=${engine.profileDir(cfg) || '?'} peer=${cfg.peerMode} caps=${['capPlugins', 'capConfig', 'capInstall', 'capFiles'].filter((key) => cfg[key]).join('+') || 'none'}`)

  const dispose = async () => {
    engine.dispose()
    for (const disposer of disposers.reverse()) {
      try {
        disposer?.()
      } catch {
        // ignore teardown errors
      }
    }
  }

  ctx.effect?.(() => () => dispose(), 'dsh-plugin-sync: teardown')
  return dispose
}

function pluginSyncToolSpec(engine) {
  return {
    name: 'plugin_sync',
    description: [
      'Inspect or run the cross-machine DSH plugin sync (inventory, configs, enable state, package installs, local plugin folders).',
      'action="status" reports this machine, the peer and the last run.',
      'action="plan" shows what a sync would change, without changing anything.',
      'action="run" performs the sync now (respects the capability switches and the direction setting).',
      'Use it when the user asks whether plugins are in sync, what would change, or asks to sync now.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'plan', 'run'], description: 'status | plan | run' },
        direction: {
          type: 'string',
          enum: ['push', 'pull', 'both', 'off'],
          description: 'Override the configured direction for this call.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    timeoutMs: 600000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      const action = String(args?.action || 'status')
      const direction = typeof args?.direction === 'string' ? args.direction : null
      if (action === 'status') return engine.status()
      if (action === 'plan') return engine.plan({ direction })
      if (action === 'run') return engine.sync({ trigger: 'tool', direction })
      return { ok: false, error: `unknown action: ${action}` }
    },
  }
}

function pluginSyncConfigToolSpec(engine) {
  return {
    name: 'plugin_sync_config',
    description: [
      'Read or update the plugin-sync settings: peer (http/ssh), capability switches, direction/conflict and schedule.',
      'action="get" returns the current effective settings (the peer token is never returned).',
      'action="set" merges a patch (any of: enabled, direction, conflict, peerMode, peerUrl, peerHost, peerUser, peerPort, peerKey, peerHttpPort, peerToken, capPlugins, capConfig, capInstall, capFiles, capRemoteApply, capSecrets, autoStart, autoRestart, intervalMinutes, startupDelaySec, include, exclude).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'] },
        patch: { type: 'object', additionalProperties: true, description: 'Settings to merge (action="set").' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    timeoutMs: 60000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      const action = String(args?.action || 'get')
      if (action === 'get') {
        const cfg = engine.cfg()
        return {
          ...cfg,
          peerToken: cfg.peerToken ? '[set]' : '',
          profileDir: engine.profileDir(cfg),
        }
      }
      if (action === 'set') {
        const patch = args?.patch && typeof args.patch === 'object' ? args.patch : {}
        engine.updateState(patch)
        engine.schedule()
        const cfg = engine.cfg()
        return { ok: true, ...cfg, peerToken: cfg.peerToken ? '[set]' : '' }
      }
      return { ok: false, error: `unknown action: ${action}` }
    },
  }
}
