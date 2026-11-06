window.__ModuleLoader__.load({
  id: 'dsh-plugin-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const API = '/plugin-sync/api/'

    const CARD = {
      border: '1px solid var(--dsh-border, rgba(127,127,127,.28))',
      borderRadius: 12,
      padding: '14px 16px',
      marginBottom: 14,
      background: 'var(--dsh-surface, transparent)',
    }
    const LABEL = { fontSize: 12.5, opacity: 0.7, marginBottom: 4 }
    const INPUT = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 9px',
      borderRadius: 8,
      border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
    }
    const BUTTON = {
      padding: '7px 14px',
      borderRadius: 8,
      border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      font: 'inherit',
    }
    const BUTTON_PRIMARY = { ...BUTTON, background: 'var(--dsh-accent, #3b82f6)', borderColor: 'var(--dsh-accent, #3b82f6)', color: '#fff' }
    const ROW = { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', fontSize: 13 }
    const MUTED = { fontSize: 12.5, opacity: 0.65 }

    async function api(path, options) {
      const response = await fetch(API + path, options)
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        return { error: text || `HTTP ${response.status}` }
      }
    }

    function post(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
    }

    function Card(props) {
      return h('div', { style: CARD }, [
        h('div', { key: 'title', style: { fontSize: 13.5, fontWeight: 600, marginBottom: 10 } }, props.title),
        props.children,
      ])
    }

    function Field(props) {
      return h('div', { style: { marginTop: 10 } }, [
        props.label ? h('div', { key: 'label', style: LABEL }, props.label) : null,
        props.children,
      ])
    }

    function Toggle(props) {
      return h(
        'label',
        {
          key: props.id,
          style: {
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
            padding: '6px 0',
            borderBottom: '1px dashed var(--dsh-border, rgba(127,127,127,.25))',
            cursor: 'pointer',
          },
        },
        [
          h('input', {
            key: 'box',
            type: 'checkbox',
            checked: Boolean(props.checked),
            onChange: (event) => props.onChange(event.target.checked),
            style: { marginTop: 2 },
          }),
          h('span', { key: 'text' }, [
            h('b', { key: 'name' }, props.label),
            props.desc ? h('div', { key: 'desc', style: MUTED }, props.desc) : null,
          ]),
        ],
      )
    }

    function SyncSettings(props) {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(null)
      const [out, setOut] = useState('')
      const [draft, setDraft] = useState({})

      const load = useCallback(async () => {
        try {
          const next = await api('state')
          if (next && next.error) setError(String(next.error))
          else {
            setState(next)
            setError(null)
          }
        } catch (cause) {
          setError(cause?.message || String(cause))
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const config = state?.config || {}
      const value = useCallback((key) => (draft[key] !== undefined ? draft[key] : config[key]), [draft, config])
      const setValue = useCallback((key, next) => setDraft((current) => ({ ...current, [key]: next })), [])

      const save = useCallback(async () => {
        if (Object.keys(draft).length === 0) return
        setBusy('save')
        try {
          const next = await post('config', { ...draft, capabilities: collectCaps(draft) })
          if (next && next.status) {
            setState(next)
            setDraft({})
          }
          setError(next?.error ? String(next.error) : null)
        } catch (cause) {
          setError(cause?.message || String(cause))
        } finally {
          setBusy(null)
        }
      }, [draft])

      // capability toggles land in draft under their own keys
      const collectCaps = (patch) => {
        const caps = {}
        for (const cap of state?.capabilityCatalog || []) {
          if (patch[cap.key] !== undefined) caps[cap.key] = patch[cap.key]
        }
        return caps
      }

      const run = useCallback(
        async (action) => {
          setBusy(action)
          setOut(action === 'sync' ? '同步中…' : '计算中…')
          try {
            const result = action === 'sync' ? await post('sync', {}) : await api('plan')
            setOut(JSON.stringify(result, null, 2).slice(0, 20000))
            if (result?.status) setState((current) => (current ? { ...current, status: result.status } : current))
          } catch (cause) {
            setOut(String(cause?.message || cause))
          } finally {
            setBusy(null)
          }
        },
        [],
      )

      const status = state?.status
      const statusRows = useMemo(() => {
        if (!status) return []
        return [
          [
            '本机',
            status.local
              ? `${status.local.node || '?'} · ${status.local.profile || '?'} · ${status.local.bundles} 包 / ${status.local.plugins} 条目`
              : status.localError || '读取失败',
          ],
          ['profile 目录', status.profileDir || '?'],
          ['对端', status.peer?.describe || '?'],
          [
            '上次同步',
            status.lastRun
              ? `${formatTime(status.lastRun.at)} · ${status.lastRun.ok ? '成功' : `失败：${status.lastRun.error || ''}`}`
              : '还没跑过',
          ],
          ['当前', status.running ? '同步中…' : '空闲'],
        ]
      }, [status])

      if (!state) {
        return h('div', { style: { padding: 16, fontSize: 13 } }, error ? `读取失败：${error}` : '读取中…')
      }

      return h(
        'div',
        { style: { padding: props.compact ? 0 : '4px 2px 24px' } },
        [
          error
            ? h('div', { key: 'err', style: { color: 'var(--dsh-danger, #d9534f)', marginBottom: 10, fontSize: 13 } }, error)
            : null,

          h(Card, { key: 'status', title: '状态' }, [
            ...statusRows.map(([key, text], index) =>
              h('div', { key: `row-${index}`, style: ROW }, [
                h('span', { key: 'k', style: { opacity: 0.65 } }, key),
                h('span', { key: 'v', style: { textAlign: 'right', wordBreak: 'break-all' } }, String(text)),
              ]),
            ),
            h('div', { key: 'actions', style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } }, [
              h(
                'button',
                { key: 'sync', style: BUTTON_PRIMARY, disabled: Boolean(busy), onClick: () => run('sync') },
                busy === 'sync' ? '同步中…' : '立即同步',
              ),
              h('button', { key: 'plan', style: BUTTON, disabled: Boolean(busy), onClick: () => run('plan') }, '只看计划'),
              h('button', { key: 'reload', style: BUTTON, disabled: Boolean(busy), onClick: () => void load() }, '刷新'),
            ]),
          ]),

          h(Card, { key: 'peer', title: '对端' }, [
            h(Field, { key: 'mode', label: '连接方式' }, select(value('peerMode'), [
              ['off', '未配置'],
              ['http', 'HTTP（对端 Web 端口）'],
              ['ssh', 'SSH 隧道（推荐，跨公网）'],
            ], (next) => setValue('peerMode', next))),
            h(Field, { key: 'url', label: 'HTTP 地址' }, input(value('peerUrl'), 'http://127.0.0.1:18777', (next) => setValue('peerUrl', next))),
            h('div', { key: 'ssh', style: { display: 'grid', gridTemplateColumns: '2fr 1fr 90px', gap: 8 } }, [
              h(Field, { key: 'host', label: 'SSH 主机' }, input(value('peerHost'), '114.55.146.70', (next) => setValue('peerHost', next))),
              h(Field, { key: 'user', label: '用户' }, input(value('peerUser'), 'dsh', (next) => setValue('peerUser', next))),
              h(Field, { key: 'port', label: '端口' }, input(value('peerPort'), '22', (next) => setValue('peerPort', Number(next) || 22))),
            ]),
            h('div', { key: 'tunnel', style: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8 } }, [
              h(Field, { key: 'httpPort', label: '对端 Web 端口' }, input(value('peerHttpPort'), '18777', (next) => setValue('peerHttpPort', Number(next) || 18777))),
              h(Field, { key: 'key', label: 'SSH 私钥' }, input(value('peerKey'), 'C:\\Users\\QIC\\.ssh\\dsh_cloud_ed25519', (next) => setValue('peerKey', next))),
            ]),
            h(Field, { key: 'name', label: '对端名称（显示用）' }, input(value('peerName'), 'cloud', (next) => setValue('peerName', next))),
            h(
              Field,
              { key: 'token', label: config.peerTokenSet ? '对端令牌（留空表示不改）' : '对端令牌（两端要一致）' },
              input(draft.peerToken ?? '', '两端填同一串随机字符', (next) => setValue('peerToken', next)),
            ),
            h('div', { key: 'hint', style: { ...MUTED, marginTop: 8 } }, '两台机器都要装本插件；令牌是「对端」接口的凭据，不填则对端接口一律拒绝。'),
          ]),

          h(Card, { key: 'direction', title: '同步方式与时機' }, [
            h(Field, { key: 'dir', label: '方向' }, select(value('direction'), (state.directionCatalog || []).map((item) => [item.key, item.label]), (next) => setValue('direction', next))),
            h(Field, { key: 'conflict', label: '冲突策略' }, select(value('conflict'), [
              ['local', '以发起方为准'],
              ['peer', '以接收方为准'],
              ['newest', '版本新者优先'],
            ], (next) => setValue('conflict', next))),
            h('div', { key: 'sched', style: { marginTop: 10 } }, [
              h(Toggle, {
                key: 'enable',
                label: '总开关',
                desc: '关掉后「启动时同步」和手动同步都不动作',
                checked: Boolean(value('enabled')),
                onChange: (next) => setValue('enabled', next),
              }),
              h(Toggle, {
                key: 'startup',
                label: '软件启动时同步',
                desc: 'DSH 启动后约 25 秒跑一轮（等宿主把插件都挂上）',
                checked: Boolean(value('autoStart')),
                onChange: (next) => setValue('autoStart', next),
              }),
              h(Toggle, {
                key: 'restart',
                label: '服务器重启后同步',
                desc: '进程重启之后再补一轮，处理对端还在启动的情况',
                checked: Boolean(value('autoRestart')),
                onChange: (next) => setValue('autoRestart', next),
              }),
              h(Field, { key: 'interval', label: '每隔多少分钟同步（0 = 不按间隔）' },
                input(value('intervalMinutes'), '0', (next) => setValue('intervalMinutes', Number(next) || 0))),
              h(Field, { key: 'delay', label: '启动后延迟秒数' },
                input(value('startupDelaySec'), '25', (next) => setValue('startupDelaySec', Number(next) || 0))),
            ]),
          ]),

          h(Card, { key: 'caps', title: '权限（每一项可以单独关）' },
            (state.capabilityCatalog || []).map((cap) =>
              h(Toggle, {
                key: cap.key,
                label: cap.label,
                desc: cap.desc,
                checked: Boolean(value(cap.key)),
                onChange: (next) => setValue(cap.key, next),
              }),
            ),
          ),

          h('div', { key: 'save', style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
            h('button', { key: 'save', style: BUTTON_PRIMARY, disabled: Boolean(busy) || Object.keys(draft).length === 0, onClick: () => void save() }, '保存设置'),
            h('span', { key: 'hint', style: MUTED }, Object.keys(draft).length === 0 ? '没有未保存的改动' : `${Object.keys(draft).length} 项待保存`),
          ]),

          out ? h('pre', { key: 'out', style: { marginTop: 12, whiteSpace: 'pre-wrap', fontSize: 11.5, maxHeight: 260, overflow: 'auto', background: 'rgba(127,127,127,.1)', padding: 10, borderRadius: 8 } }, out) : null,
        ].filter(Boolean),
      )
    }

    function input(current, placeholder, onChange) {
      return h('input', {
        style: INPUT,
        value: current === undefined || current === null ? '' : String(current),
        placeholder,
        onChange: (event) => onChange(event.target.value),
      })
    }

    function select(current, options, onChange) {
      return h(
        'select',
        { style: INPUT, value: current ?? '', onChange: (event) => onChange(event.target.value) },
        options.map(([key, label]) => h('option', { key, value: key }, label)),
      )
    }

    function formatTime(value) {
      if (!value) return '?'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return String(value)
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'plugin-sync', order: 16, label: () => '插件同步' },
            SyncSettings,
          ),
        )
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            { name: 'settings.plugins.tab', id: 'plugin-sync', order: 60, label: () => '同步' },
            (props) => h(SyncSettings, { ...props, compact: true }),
          ),
        )
      },
    }
  },
})
