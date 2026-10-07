import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { GeminiMonitorJob } from '../types'

// Follows the gemini plugin's jobs through the global index the companion
// writes to ~/.claude/gemini-companion/index.json: a status line, a toast when
// a job finishes, a live pane (/gemini-panel) and, for background jobs started
// from this session, a prompt that wakes Claude up to review the result.

const PANE = 'gemini-jobs'
const POLL_MS = 2000
const ACTIVE = new Set(['queued', 'running'])

const jobsAtom = atom({ plugin: 'gemini-monitor', key: 'jobs' } as const, [])
const tailsAtom = atom({ plugin: 'gemini-monitor', key: 'tails' } as const, {})
const wakeAtom = atom({ plugin: 'gemini-monitor', key: 'wake' } as const, true)

function elapsed(from: string | undefined, now: number): string {
  const start = Date.parse(from ?? '')
  if (!Number.isFinite(start)) return ''
  const seconds = Math.max(0, Math.round((now - start) / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
}

function cut(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`
}

function folder(path: string | undefined): string {
  return (path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
}

function progressLines(log: string): string[] {
  return log
    .split(/\r?\n/)
    .filter(line => line.startsWith('['))
    .map(line => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter(Boolean)
    .slice(-4)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gemini-panel',
      description: 'Open the live pane of Gemini jobs',
    })
    await $.command.register({
      name: 'gemini-wake',
      description: 'Turn on or off the prompt that wakes Claude when a background Gemini job finishes (on|off)',
    })

    const stored = await $.store.get('wake')
    if (typeof stored === 'boolean') await update($, wakeAtom, () => stored)

    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    const indexPath = `${home}/.claude/gemini-companion/index.json`
    const sessionId = await $.session.id()
    const seen = new Map<string, string>()
    let seeded = false

    const poll = async () => {
      let jobs: GeminiMonitorJob[]
      try {
        const parsed = JSON.parse(await $.fs.read(indexPath))
        jobs = Array.isArray(parsed.jobs) ? parsed.jobs : []
      } catch {
        return
      }

      const now = await $.clock.now()
      const running = jobs.filter(job => ACTIVE.has(job.status))
      const tails: Record<string, string[]> = {}
      for (const job of running.slice(0, 4)) {
        if (!job.logFile) continue
        try {
          tails[job.id] = progressLines(await $.fs.read(job.logFile))
        } catch {
          // the log does not exist yet
        }
      }
      await update($, jobsAtom, () => jobs.slice(0, 12))
      await update($, tailsAtom, () => tails)

      const first = running[0]
      if (first) {
        const more = running.length > 1 ? ` (+${running.length - 1})` : ''
        $.ui.status(
          `Gemini${more}: ${first.title ?? first.id} · ${first.phase ?? first.status} · ${elapsed(first.startedAt ?? first.createdAt, now)}`,
        )
      } else {
        $.ui.status(undefined)
      }

      if (seeded) {
        const wake = await read($, wakeAtom)
        for (const job of jobs) {
          const before = seen.get(job.id)
          if (!before || !ACTIVE.has(before) || ACTIVE.has(job.status)) continue
          $.ui.toast(`Gemini finished: ${job.title ?? job.id} (${job.status})`, { timeoutMs: 8000 })
          if (wake && job.background && job.sessionId === sessionId && job.status !== 'cancelled') {
            void $.prompt.submit({
              text: `Gemini job ${job.id} (${job.title ?? 'task'}) finished with status ${job.status}. Run /gemini:result ${job.id}, review what it did and tell me the next step.`,
            })
          }
        }
      }
      seen.clear()
      for (const job of jobs) seen.set(job.id, job.status)
      seeded = true
    }

    await poll()
    $.clock.every(POLL_MS, poll)

    return next(e)
  })

  on('command.run', { command: 'gemini-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Gemini jobs' })

    return { text: 'Opened the Gemini jobs pane.' }
  })

  on('command.run', { command: 'gemini-wake' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const current = await read($, wakeAtom)
    const next = arg === 'on' ? true : arg === 'off' ? false : !current
    await update($, wakeAtom, () => next)
    await $.store.set('wake', next)

    return {
      text: next
        ? 'Wake-up is on: when a background Gemini job from this session finishes, Claude gets a prompt to review it.'
        : 'Wake-up is off: you only get the on-screen notification when a Gemini job finishes.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const jobs = await read($, jobsAtom)
    const tails = await read($, tailsAtom)
    const wake = await read($, wakeAtom)
    const width = Math.max(20, e.props.bodyColumns ?? 80)
    const now = await $.clock.now()
    const running = jobs.filter(job => ACTIVE.has(job.status))
    const finished = jobs.filter(job => !ACTIVE.has(job.status)).slice(0, 6)

    return (
      <Box flexDirection="column">
        <Text dimColor>{cut(`Wake Claude on finish: ${wake ? 'on' : 'off'} (/gemini-wake)`, width)}</Text>
        <Text bold>Running</Text>
        {running.length === 0 && <Text dimColor>No Gemini jobs running.</Text>}
        {running.map(job => (
          <Box key={job.id} flexDirection="column">
            <Text color="cyan">
              {cut(
                `${job.title ?? job.id} · ${job.phase ?? job.status} · ${elapsed(job.startedAt ?? job.createdAt, now)} · ${folder(job.workspaceRoot)}`,
                width,
              )}
            </Text>
            {(tails[job.id] ?? []).map(line => (
              <Text dimColor>{cut(`  ${line}`, width)}</Text>
            ))}
          </Box>
        ))}
        <Text bold>Recent</Text>
        {finished.length === 0 && <Text dimColor>No finished jobs yet.</Text>}
        {finished.map(job => (
          <Text key={job.id} color={job.status === 'completed' ? 'green' : job.status === 'failed' ? 'red' : undefined}>
            {cut(`${job.status} · ${job.title ?? job.id} · ${folder(job.workspaceRoot)} · ${job.summary ?? ''}`, width)}
          </Text>
        ))}
      </Box>
    )
  })
}
