export type ReviewChangesCandidate = {
  summary: string
}

export type ReviewChangesPhase = 'collecting' | 'analyzing' | 'writing'

export type ReviewChangesRun = {
  runId: string
  label: string
  phase: ReviewChangesPhase
}

export type ReviewChangesLast = {
  label: string
  htmlPath: string
}

declare module 'claude-code' {
  interface PluginState {
    'review-changes': {
      candidate: ReviewChangesCandidate | null
      run: ReviewChangesRun | null
      last: ReviewChangesLast | null
      isHidden: boolean
    }
  }
}
