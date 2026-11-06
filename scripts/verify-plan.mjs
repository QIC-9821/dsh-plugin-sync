#!/usr/bin/env node
/**
 * Offline check: fetch both snapshots (local over HTTP, peer over the ssh
 * tunnel) and print the plan the *current* merge.js would produce.
 *
 * Useful right after editing the planner, without restarting the host:
 *   node scripts/verify-plan.mjs
 * Peer settings come from the running plugin's state file.
 */
import { effectiveConfig } from '../lib/config.js'
import { planMerge, summarize } from '../lib/merge.js'
import { PeerLink } from '../lib/transport.js'
import { summarizeSnapshot } from '../lib/snapshot.js'

const origin = process.env.PLUGIN_SYNC_ORIGIN || 'http://127.0.0.1:63975'
const state = effectiveConfig({}, process.env)

const localResponse = await fetch(`${origin}/plugin-sync/api/snapshot`)
if (!localResponse.ok) throw new Error(`local snapshot → HTTP ${localResponse.status}`)
const local = await localResponse.json()

const link = new PeerLink(state, { log: (line) => console.log(`[peer] ${line}`) })
if (!link.configured) throw new Error('peer not configured in ~/.dsh/plugin-sync/state.json')
const remote = await link.call('/plugin-sync/peer/snapshot', {
  method: 'POST',
  body: { includeConfig: Boolean(state.capConfig), includeSources: Boolean(state.capFiles) },
})
link.dispose()

const options = {
  conflict: state.conflict || 'local',
  capPlugins: state.capPlugins !== false,
  capInstall: state.capInstall === true,
  capConfig: state.capConfig === true,
  capFiles: state.capFiles === true,
  include: state.include || [],
  exclude: state.exclude || [],
  mirror: false,
  selfName: '@qic-9821/dsh-plugin-sync',
}

console.log('local:', JSON.stringify(summarizeSnapshot(local)))
console.log('peer :', JSON.stringify(summarizeSnapshot(remote)))
const plan = planMerge(local, remote, options)
console.log('stats:', JSON.stringify(summarize(plan.ops, plan.notes)))
for (const op of plan.ops) console.log(' op ', op.kind, op.name || op.entryId)
for (const note of plan.notes.slice(0, 8)) console.log(' skip', note.target, '—', note.reason)
