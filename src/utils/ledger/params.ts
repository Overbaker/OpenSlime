function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

/** Every threshold, budget and cap of the ledger, lessons, probes and summary. Part of the harness fingerprint. */
export const PARAMS = deepFreeze({
  append: {
    maxLineBytes: 65536,
    maxText: 1024,
    maxTopic: 200,
    maxArray: 100,
    minOptions: 2,
    maxOptions: 6,
    lockRetryMs: 50,
    lockTimeoutMs: 2000,
  },
  summary: {
    defaultLines: 40,
    maxLines: 200,
    defaultBytes: 8192,
    minBytes: 512,
    maxBytes: 32768,
    cohorts: 5,
    minCohortN: 5,
  },
  verdict: {
    minAdjudicated: 10,
    minRuns: 5,
    keepContribution: 0.6,
    maxFailureRate: 0.2,
  },
  rubberStamp: {
    window: 10,
    adoptedShare: 0.9,
    minDecisions: 10,
    firstPositionRate: 0.8,
  },
  lessons: {
    lineMax: 160,
    cueMax: 160,
    bodyMaxBytes: 16384,
    indexLineMax: 200,
    queryDefault: 5,
    queryMax: 20,
    showMaxLines: 60,
    adopt: { minWins: 4, minMargin: 3, minChanges: 2 },
    globalAdopt: { minWins: 2, maxLosses: 0 },
    retire: { lossMargin: 2, inertWindow: 5, inertMax: 3, maxDecisive: 8, maxTotal: 10 },
  },
  probe: {
    perChange: 2,
    perSession: 3,
    perLessonPerChange: 2,
    severeLossWeight: 2,
    maxAdoptedLinesPerBrief: 2,
    displayMaxLines: 12,
    blindInterdiffMaxLines: 20,
  },
  harnessRules: {
    calibrationGap: 0.15,
    calibrationMinN: 20,
    winRuleRetiredShare: 0.3,
    winRuleMinAdoptions: 5,
    budgetMinOpportunities: 20,
    blindDisagreeShare: 0.5,
    blindMinN: 6,
    reviewerContribution: 0.6,
    reviewerMinN: 10,
    laterCriticalRate: 0.2,
    laterCriticalMinN: 10,
  },
})

export type Params = typeof PARAMS
