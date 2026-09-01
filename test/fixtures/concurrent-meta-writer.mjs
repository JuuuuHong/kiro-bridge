#!/usr/bin/env node
// Cross-process concurrency fixture for the per-job lock (F4).
//
// Each child writes a distinct metadata field and appends a distinct recent
// event under the per-job lock, repeated N times. If the lock works, no
// writer's field is ever lost even though all processes contend on one file.
//
// argv: <jobId> <cwd> <label> <iterations>
import * as jobs from '../../scripts/lib/jobs.mjs'

const [, , jobId, cwd, label, iterationsRaw] = process.argv
const iterations = Number(iterationsRaw) || 50

for (let i = 0; i < iterations; i++) {
  jobs.updateMeta(jobId, (meta) => {
    const marks = { ...(meta.marks || {}) }
    marks[label] = (marks[label] || 0) + 1
    return { marks }
  }, cwd)
}

process.exit(0)
