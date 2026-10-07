export type GeminiMonitorJob = {
  id: string
  title?: string
  kindLabel?: string
  status: string
  phase?: string
  summary?: string
  workspaceRoot?: string
  logFile?: string
  sessionId?: string
  write?: boolean
  background?: boolean
  threadId?: string
  errorMessage?: string
  createdAt?: string
  startedAt?: string
  completedAt?: string
  updatedAt?: string
}

declare module 'claude-code' {
  interface PluginState {
    'gemini-monitor': {
      jobs: GeminiMonitorJob[]
      tails: Record<string, string[]>
      wake: boolean
    }
  }
}
