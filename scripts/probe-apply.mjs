// End-to-end probe of the peer write path: opens the tunnel, authenticates,
// and posts an empty plan so the peer runs applyPlan (no state change).
// Usage: node scripts/probe-apply.mjs
import { effectiveConfig } from '../lib/config.js'
import { PeerLink } from '../lib/transport.js'

const cfg = effectiveConfig({}, process.env)
const link = new PeerLink(cfg, { log: (m) => console.log('[peer]', m) })
try {
  const pong = await link.call('/plugin-sync/peer/ping')
  console.log('ping  :', JSON.stringify(pong))
  // A caller without the token must be refused; PeerLink always adds the real
  // one, so this one goes through plain fetch on the same tunnel.
  const baseUrl = await link.ensure()
  const raw = await fetch(`${baseUrl}/plugin-sync/peer/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ops: [] }),
  })
  console.log('auth  :', raw.status, (await raw.text()).slice(0, 160))
  const tail = process.argv[2]
    ? JSON.parse(process.argv[2])
    : [
        // A row that does not exist: proves the call really reaches the peer's
        // pluginManager (it must answer "unknown plugin") without changing state.
        { kind: 'plugin-disable', entryId: 'include:probe-does-not-exist' },
        // Config writes need capConfig on the peer; this one must be dropped.
        { kind: 'config', target: 'dsh-memory-evolve', value: { probe: true } },
      ]
  const applied = await link.call('/plugin-sync/peer/apply', { method: 'POST', body: { ops: tail } })
  console.log('apply :', JSON.stringify(applied, null, 2))
} finally {
  link.dispose()
}
