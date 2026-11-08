export enum FixtureScenario {
  Baseline = 'baseline',
  Stress = 'stress',
  ShortLines = 'short-lines',
  BigFile = 'big-file',
  LongLine = 'long-line',
  HugeLine = 'huge-line',
  Entries = 'entries',
}

export type FixtureSummary = {
  scenario: FixtureScenario
  reviewDirectory: string
  patchBytes: number
  fileCount: number
  hunkCount: number
  additions: number
  deletions: number
  generationMilliseconds: number
}

export type MeasureResult = {
  scenario: FixtureScenario
  fileCount: number
  hunkCount: number
  additions: number
  deletions: number
  scanMilliseconds: number
  sortMilliseconds: number
  firstFrameMilliseconds: number
  launchMilliseconds: number
  switchMilliseconds: number[]
  scrollMilliseconds: number[]
  longestIndexQuantumMilliseconds: number
  fullIndexMilliseconds: number
  windowReadMilliseconds: number[]
  reviewedMarkMilliseconds: number
  rssMebibytes: number
  rssAfterScanMebibytes: number
}

export type Budget = {
  launchMilliseconds: number
  switchP99Milliseconds: number
  scrollP95Milliseconds: number
  scrollP99Milliseconds: number
  indexQuantumMilliseconds: number
  rssMebibytes: number
}
