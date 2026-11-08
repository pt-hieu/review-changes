export type ReviewChangesCandidate = {
  summary: string
}

export type ReviewChangesPhase = 'collecting' | 'analyzing'

export type ReviewChangesRun = {
  runId: string
  label: string
  phase: ReviewChangesPhase
}

export type ReviewChangesPane = {
  reviewDirectory: string
  repositoryRoot: string
  label: string
  blockId: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'review-changes': {
      candidate: ReviewChangesCandidate | null
      run: ReviewChangesRun | null
      pane: ReviewChangesPane | null
      isHidden: boolean
    }
  }
}
