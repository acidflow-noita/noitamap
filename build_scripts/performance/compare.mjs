/** Compare paired runs on one browser/renderer. Timing warnings are separate
 * from correctness failures; the initial reference is never advanced silently. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null;
}
export function compareRuns(runs, config) {
  const invalid = runs.filter(run => !run.valid);
  const variants = [...new Set(runs.map(run => run.variant))];
  const fingerprints = new Set(runs.filter(r => r.valid).map(r => JSON.stringify([r.browser, r.graphics?.renderer, r.backend])));
  const problems = invalid.map(r => `${r.variant}/${r.scenario}/${r.trial}: ${r.failure || 'invalid run'}`);
  if (!variants.includes('candidate') || variants.length < 2) problems.push('Candidate and at least one baseline are required.');
  if (fingerprints.size > 1) problems.push('Browser or rendering backend differed between runs; timings cannot be compared.');
  const rows = [];
  for (const scenario of [...new Set(runs.map(r => r.scenario))]) {
    for (const phase of [...new Set(runs.filter(r => r.scenario === scenario).flatMap(r => r.phases.map(p => p.label)))]) {
      const values = Object.fromEntries(variants.map(variant => [variant, runs
        .filter(r => r.valid && r.variant === variant && r.scenario === scenario)
        .flatMap(r => r.phases.filter(p => p.label === phase).map(p => p.durationMs))]));
      const complete = Object.values(values).every(v => v.length === config.repeats && v.every(n => Number.isFinite(n) && n >= 0));
      if (!complete) problems.push(`Incomplete/invalid samples: ${scenario}/${phase}`);
      const rowRuns = runs.filter(r => r.valid && r.scenario === scenario && r.phases.some(p => p.label === phase));
      const matchingGraphics = new Set(rowRuns.map(r => JSON.stringify([r.browser, r.graphics?.renderer, r.backend]))).size === 1;
      const medians = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, median(v)]));
      const row = { scenario, phase, values, medians, comparable: complete && matchingGraphics,
        regressions: /** @type {{baseline: string, deltaMs: number, relative: number}[]} */ ([]) };
      for (const baseline of variants.filter(v => v !== 'candidate')) {
        if (!row.comparable) continue;
        const before = medians[baseline], after = medians.candidate;
        if (before === null || after === null) continue;
        const deltaMs = after - before, relative = before > 0 ? deltaMs / before : 0;
        const threshold = phase === 'navigation-frame-gap' ? config.navigationWarning ?? config.warning : config.warning;
        if (deltaMs > threshold.absoluteMs && relative > threshold.relative)
          row.regressions.push({ baseline, deltaMs, relative });
      }
      rows.push(row);
    }
  }
  // An unavailable baked case must not hide a valid dynamic-case slowdown.
  return { comparable: problems.length === 0, problems, rows, timingRegressions: rows.filter(r => r.regressions.length) };
}
export function markdownSummary(result, runs) {
  const variants = [...new Set(runs.map(r => r.variant))];
  const lines = ['## Map performance', '',
    'Paired local production builds; fresh browser profiles for cold runs. Software graphics unless the recorded renderer says otherwise.', '',
    ...variants.map(v => `- ${v}: ${runs.find(r => r.variant === v)?.commit || 'unknown commit'}`), '',
    '| Case | ' + variants.join(' | ') + ' |', '|---|' + variants.map(() => '---:').join('|') + '|'];
  for (const r of result.rows) lines.push(`| ${r.scenario}: ${r.phase} | ${variants.map(v => r.medians[v] === null ? 'missing' : `${Math.round(r.medians[v])} ms`).join(' | ')} |`);
  lines.push('', 'Times are medians. Navigation frame gaps are responsiveness metrics, not exact input-to-pixel latency.');
  for (const problem of result.problems) lines.push(`\n**INVALID:** ${problem}`);
  for (const row of result.timingRegressions) for (const r of row.regressions)
    lines.push(`\n**Timing warning:** ${row.scenario}/${row.phase} vs ${r.baseline}: +${Math.round(r.deltaMs)} ms (${(r.relative * 100).toFixed(1)}%).`);
  return lines.join('\n') + '\n';
}
