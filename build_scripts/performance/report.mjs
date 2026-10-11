const browserName = name => ({ chromium: 'Chromium', firefox: 'Firefox' }[name] || name);
const baselineName = name => ({ previous: 'previous commit', reference: 'fixed reference' }[name] || name);
const checks = {
  'cold-start': 'First dynamic load',
  'warm-new-seed': 'Switch dynamic seed',
  'cached-return': 'Return to cached seed',
  'cached-reload': 'Reload dynamic map',
  'cached-url-navigation': 'Reopen dynamic URL',
  'mod-new-seed': 'Mod seed change',
  'mod-position-only': 'Mod position update',
  'mod-unlocks': 'Mod unlock update',
  'mod-pillars': 'Mod pillar update',
  'baked-start': 'Open baked Daily',
  'first-dynamic': 'Baked Daily → dynamic',
};
const checkName = row => row.phase === 'navigation-frame-gap'
  ? `Pan/zoom pause (${row.scenario === 'baked' ? 'after Daily switch' : 'dynamic map'})`
  : checks[row.phase] || row.phase;
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const time = value => !Number.isFinite(value) ? 'Unavailable'
  : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
const change = warning => `+${time(warning.deltaMs)} (+${(warning.relative * 100).toFixed(1)}%) vs ${baselineName(warning.baseline)}`;

/** One deploy-check verdict for the workflow page, with all browsers in one
 * optional table. Never infer a deploy pass from a partial/failed comparison. */
export function aggregateReport(combined, config) {
  const results = combined.results;
  const runs = results.flatMap(result => result.runs);
  const failed = runs.filter(run => !run.valid);
  const warnings = results.flatMap(result => result.comparison.timingRegressions.map(row => ({ browser: result.browser, row })));
  const issues = [...combined.problems, ...results.flatMap(result =>
    result.comparison.problems.map(problem => `${browserName(result.browser)}: ${problem}`))];
  let status, headline;
  if (!combined.valid || issues.length || failed.length || !runs.length) {
    status = 'hold';
    headline = failed.length
      ? `DEPLOY: HOLD — ${failed.length} of ${runs.length} browser runs failed; the performance check is incomplete.`
      : 'DEPLOY: HOLD — Missing or inconsistent test results; this commit has not passed the performance check.';
  } else if (warnings.length) {
    status = config.enforceTiming ? 'hold' : 'review';
    const ranked = warnings.flatMap(({ browser, row }) => row.regressions.map(warning => ({ browser, row, warning })))
      .sort((a, b) => Number(b.warning.baseline === 'previous') - Number(a.warning.baseline === 'previous')
        || b.warning.deltaMs - a.warning.deltaMs);
    const { browser, row, warning } = ranked[0];
    const count = `${warnings.length} timing warning${warnings.length === 1 ? '' : 's'}`;
    headline = `DEPLOY: ${status.toUpperCase()} — All ${runs.length} browser runs passed; ${count}: ${browserName(browser)} ${checkName(row).toLowerCase()} ${change(warning)}.`;
  } else {
    status = 'pass';
    headline = `DEPLOY: PASS — All ${runs.length} browser runs passed; no slowdown warning against the previous commit or fixed reference.`;
  }

  const lines = [`**${escape(headline)}**`, '',
    `Covers the automated map checks in ${results.map(result => browserName(result.browser)).join(' and ') || 'both browsers'}. ${config.repeats} repeats; software graphics.`, ''];
  if (combined.valid && warnings.length) lines.push(config.enforceTiming
    ? 'The timing warning fails this check.' : 'Timing warnings require review but do not fail the workflow.', '');
  lines.push('<details>', '<summary>Detailed timings, compared commits and diagnostics</summary>', '');
  const variants = ['candidate', 'previous', 'reference'];
  const names = { candidate: 'This commit', previous: 'Previous commit', reference: 'Fixed reference' };
  lines.push(variants.map(variant => `${names[variant]}: \`${escape(runs.find(run => run.variant === variant)?.commit?.slice(0, 7) || 'unavailable')}\``).join(' · '), '');
  if (issues.length) lines.push('**Failed or incomplete checks:**', '', ...[...new Set(issues)].map(issue => `- ${escape(issue)}`), '');
  if (warnings.length) lines.push('**Timing warnings:**', '', ...warnings.map(({ browser, row }) =>
    `- ${browserName(browser)} — ${checkName(row)}: ${row.regressions.map(change).join('; ')}.`), '');
  lines.push('| Browser | Check | This commit | Previous commit | Fixed reference | Finding |',
    '|---|---|---:|---:|---:|---|');
  for (const { browser, comparison } of results) for (const row of comparison.rows) {
    const finding = !row.comparable ? 'Not comparable' : row.regressions.length
      ? row.regressions.map(change).join('; ') : 'No slowdown flagged';
    lines.push(`| ${browserName(browser)} | ${escape(checkName(row))} | ${variants.map(v => time(row.medians[v])).join(' | ')} | ${escape(finding)} |`);
  }
  lines.push('', 'Times are medians. Warnings use the median change within matched runner trials, which can differ from subtracting the displayed medians.',
    `Load/switch warnings require both >${config.warning.relative * 100}% and >${time(config.warning.absoluteMs)} extra time. Navigation warnings require both >${(config.navigationWarning || config.warning).relative * 100}% and >${time((config.navigationWarning || config.warning).absoluteMs)} extra pause.`,
    'Baked tests replay a captured public bake; CDN latency and live rollover are excluded. Raw reports are in the map-performance-summary artifact.', '', '</details>', '');
  return { status, headline, markdown: lines.join('\n') };
}

export function verdictAnnotation(report) {
  const level = { pass: 'notice', review: 'warning', hold: 'error' }[report.status];
  const text = report.headline.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return `::${level} title=Overall deploy verdict::${text}`;
}
