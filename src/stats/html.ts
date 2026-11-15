import { closeSync, constants, fsyncSync, lstatSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import type { Card, AgreementPair } from './metrics.js';
import type { EvidenceFinding, EvidenceRound, Recommendation, StatsReport } from './report.js';
import { costText, durationText, failureMixText, money, pctText, perAdoptedText } from './text.js';

/*
 * The scorecard as one self-contained HTML file (`stats --html <file>`): inline CSS, no script, no font, no image and
 * no link to anything; a Content-Security-Policy of `default-src 'none'` backs that. Light and dark follow
 * `prefers-color-scheme`, and it reads at phone width (wide tables scroll inside their own box).
 *
 * Everything that came from a round is untrusted: finding titles were written by seats that read PR content, and
 * targets, paths and model names come from the store. Every interpolated value goes through `h`, which escapes it;
 * only markup this file builds itself is passed through, as `Raw`. Values appear only in text, never in an attribute,
 * a URL or the style sheet.
 */

class Raw {
  constructor(readonly html: string) {}
}

/** Escapes a value for HTML text or a quoted attribute; control characters become U+FFFD. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '\uFFFD')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function piece(v: unknown): string {
  if (v instanceof Raw) return v.html;
  if (Array.isArray(v)) return v.map(piece).join('');
  if (v === null || v === undefined) return '';
  return esc(v);
}

/** Markup with every interpolation escaped (a `Raw` or an array of them passes through). */
function h(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += piece(v) + (strings[i + 1] ?? '');
  });
  return new Raw(out);
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f7f8fa; --panel: #ffffff; --text: #1b1f24; --muted: #57606a; --line: #d8dee4;
  --accent: #2557c7; --good: #1a7f37; --flag: #b3245b; --flag-bg: #fbe9f0; --code: #eef1f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216; --panel: #171b21; --text: #e6e9ee; --muted: #9aa4b1; --line: #2c333d;
    --accent: #7aa2f7; --good: #56c271; --flag: #f07ca8; --flag-bg: #3a1a28; --code: #222831;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.page { max-width: 72rem; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.5rem; margin: 0.5rem 0; }
h2 { font-size: 1.15rem; margin: 2rem 0 0.5rem; border-bottom: 1px solid var(--line); padding-bottom: 0.25rem; }
h3 { font-size: 1rem; margin: 1rem 0 0.25rem; }
p, li, dd { overflow-wrap: anywhere; }
.muted { color: var(--muted); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin: 10px 0; }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { font-weight: 600; color: var(--muted); }
td.title, td.metric { white-space: normal; min-width: 12rem; overflow-wrap: anywhere; }
details { margin: 8px 0; }
summary { cursor: pointer; font-weight: 600; }
code { background: var(--code); padding: 0 4px; border-radius: 4px; font-size: 0.9em; overflow-wrap: anywhere; }
.flag { display: inline-block; color: var(--flag); background: var(--flag-bg); border: 1px solid var(--flag); border-radius: 999px; padding: 0 8px; font-weight: 600; font-size: 0.85em; }
.keep { display: inline-block; color: var(--good); border: 1px solid var(--good); border-radius: 999px; padding: 0 8px; font-size: 0.85em; }
dl { margin: 0; }
dt { font-weight: 600; margin-top: 0.5rem; }
dd { margin: 0 0 0 1rem; color: var(--muted); }
`;

function metricRows(cards: ReadonlyArray<{ head: string; card: Card }>): Raw {
  const row = (label: string, f: (c: Card) => string): Raw => h`<tr><th scope="row">${label}</th>${cards.map(({ card }) => h`<td class="metric">${f(card)}</td>`)}</tr>`;
  return h`<div class="scroll"><table>
<thead><tr><th scope="col">metric</th>${cards.map(({ head }) => h`<th scope="col">${head}</th>`)}</tr></thead>
<tbody>
${row('rounds seated', (c) => String(c.rounds_seated))}
${row('ratified (rate)', (c) => `${c.rounds_ratified} (${pctText(c.ratified_rate)})`)}
${row('adjudicated, ratified', (c) => String(c.adjudicated_ratified))}
${row('failure mix', failureMixText)}
${row('fallback used', (c) => `${c.failures.fallback_used_rounds} (${pctText(c.failures.fallback_used_rate)})${c.failures.as_fallback_rounds !== null ? `; sat as a fallback ${c.failures.as_fallback_rounds}` : ''}`)}
${row('relaunched', (c) => `${c.failures.relaunch_rounds} (${pctText(c.failures.relaunch_rate)})`)}
${row('verdicts', (c) => `SHIP ${c.verdicts.SHIP}, SWF ${c.verdicts['SHIP-WITH-FIXES']}, NW ${c.verdicts['NEEDS-WORK']}, none ${c.verdicts.none}`)}
${row('raised / adopted / refuted', (c) => `${c.findings.raised} / ${c.findings.adopted} / ${c.findings.refuted}${c.findings.pending > 0 ? ` (${c.findings.pending} ruling pending)` : ''}`)}
${row('precision', (c) => pctText(c.findings.precision))}
${row('unique adopted / owed / HIGH', (c) => `${c.unique.adopted} / ${c.unique.owed} / ${c.unique.high} (of ${c.unique.raised} unique)`)}
${row('drop-one: blocking lost', (c) => String(c.drop_one.blocking_lost))}
${row('drop-one: flipped to SHIP', (c) => `${c.drop_one.flipped_to_ship}${c.drop_one.flipped_rounds.length > 0 ? ` (rounds ${c.drop_one.flipped_rounds.join(', ')})` : ''}`)}
${row('drop-one: quorum lost', (c) => String(c.drop_one.quorum_lost))}
${row('lone dissents (right)', (c) => `${c.dissent.lone} (${c.dissent.right} right, ${pctText(c.dissent.right_rate)})`)}
${row('cost', costText)}
${row('duration p50 / p90', (c) => `${durationText(c.cost.duration_ms_p50)} / ${durationText(c.cost.duration_ms_p90)}`)}
${row('cost per adopted finding', perAdoptedText)}
</tbody></table></div>`;
}

function matrix(pairs: readonly AgreementPair[], keys: readonly string[]): Raw {
  if (pairs.length === 0) return h`<p class="muted">No two ratified with a verdict in the same round.</p>`;
  const cell = (a: string, b: string): Raw => {
    if (a === b) return h`<td class="muted">-</td>`;
    const p = pairs.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    if (!p) return h`<td class="muted">no shared round</td>`;
    return h`<td>${p.disagree} of ${p.rounds} disagree (${pctText(p.disagree_rate)})${p.always_agree ? h` <span class="flag">always agree</span>` : ''}</td>`;
  };
  return h`<div class="scroll"><table>
<thead><tr><th scope="col"></th>${keys.map((k) => h`<th scope="col">${k}</th>`)}</tr></thead>
<tbody>${keys.map((a) => h`<tr><th scope="row">${a}</th>${keys.map((b) => cell(a, b))}</tr>`)}</tbody>
</table></div>`;
}

function evidenceRounds(rows: readonly EvidenceRound[]): Raw {
  return h`<div class="scroll"><table>
<thead><tr><th scope="col">round</th><th scope="col">target</th><th scope="col">no.</th><th scope="col">started</th><th scope="col">the seat</th><th scope="col">round verdict</th></tr></thead>
<tbody>${rows.map(
    (e) =>
      h`<tr><td>#${e.round}${e.dry_run ? ' (dry run)' : ''}</td><td class="title">${e.target}</td><td>${e.round_no}</td><td>${e.started_at.slice(0, 16).replace('T', ' ')}</td><td class="title">${e.said}</td><td>${e.verdict ?? 'not adjudicated'}</td></tr>`,
  )}</tbody></table></div>`;
}

function evidenceFindings(rows: readonly EvidenceFinding[]): Raw {
  if (rows.length === 0) return h`<p class="muted">It raised no finding in the window.</p>`;
  return h`<div class="scroll"><table>
<thead><tr><th scope="col">round</th><th scope="col">finding</th><th scope="col">severity</th><th scope="col">outcome</th><th scope="col">unique</th><th scope="col">where</th><th scope="col">title</th></tr></thead>
<tbody>${rows.map(
    (f) =>
      h`<tr><td>#${f.round}</td><td><code>${f.id}</code></td><td>${f.severity ?? '-'}</td><td>${f.outcome}</td><td>${f.unique ? 'yes' : 'no'}</td><td class="title">${f.path === null ? '-' : h`<code>${f.path}${f.line === null ? '' : `:${f.line}`}</code>`}</td><td class="title">${f.title}</td></tr>`,
  )}</tbody></table></div>`;
}

function recommendation(r: Recommendation): Raw {
  const badge = r.swap_candidate ? h`<span class="flag">swap candidate</span>` : h`<span class="keep">${r.eligible ? 'keep' : 'not enough rounds yet'}</span>`;
  return h`<div class="panel"><h3>Seat <code>${r.seat}</code> ${badge}</h3>
<ul>${r.reasons.map((x) => h`<li>${x}</li>`)}</ul>
${
  r.evidence
    ? h`<details><summary>Rounds it sat in (${r.evidence.rounds.length})</summary>${evidenceRounds(r.evidence.rounds)}</details><details><summary>Findings it raised (${r.evidence.findings.length})</summary>${evidenceFindings(r.evidence.findings)}</details>`
    : ''
}</div>`;
}

export function renderHtml(report: StatsReport): string {
  const w = report.window;
  const c = w.rounds;
  const t = report.thresholds;
  const seatKeys = report.seats.map((s) => s.seat);
  const occupantKeys = report.occupants.map((o) => `${o.occupant.key} #${o.occupant.id}`);
  const body = h`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>Seat scorecard</title>
<style>${new Raw(STYLE)}</style>
</head>
<body>
<div class="page">
<header>
<h1>Seat scorecard</h1>
<p class="muted">${w.since === null ? 'All history' : `Since ${w.since}`}${w.first_round_at !== null ? `: rounds from ${w.first_round_at.slice(0, 10)} to ${(w.last_round_at ?? w.first_round_at).slice(0, 10)}` : ''}. Generated ${report.generated_at}. sabotage-council stats, report version ${report.version}.</p>
${report.notes.map((n) => h`<p class="muted">Note: ${n}</p>`)}
</header>
<main>
<section>
<h2>Rounds</h2>
<p>${c.council} council rounds: ${c.settled} settled, ${c.adjudicated} adjudicated, ${c.failed} failed, ${c.awaiting_adjudication} awaiting adjudication, ${c.running} still running (left out), ${c.dry_run} dry run. ${c.identity} identity rounds (no seats, left out).${w.adjudicator_usd > 0 ? ` Adjudicator: ${money(w.adjudicator_usd)}.` : ''}</p>
${report.filters.seat !== null || report.filters.occupant !== null ? h`<p class="muted">Filtered to ${[report.filters.seat === null ? null : `seat ${report.filters.seat}`, report.filters.occupant === null ? null : `occupant ${report.filters.occupant}`].filter((x) => x !== null).join(', ')}. Every metric still reads every seat's legs.</p>` : ''}
${report.message !== null ? h`<p class="panel">${report.message}</p>` : ''}
</section>
${
  report.message === null
    ? h`<section>
<h2>Recommendations</h2>
<p class="muted">A seat is a swap candidate when, over at least ${t.min_ratified_rounds} adjudicated rounds it ratified in, its unique owed count is 0 and its precision is below ${pctText(t.precision_below)} or its ratified rate is below ${pctText(t.ratified_rate_below)} (${t.source === 'config' ? 'config [stats]' : 'defaults'}). The flag only informs: nothing swaps a seat by itself.</p>
${report.recommendations.map(recommendation)}
</section>
<section>
<h2>Seats</h2>
${report.seats.length > 0 ? metricRows(report.seats.map((s) => ({ head: `seat ${s.seat}`, card: s }))) : h`<p class="muted">None in the window.</p>`}
</section>
<section>
<h2>Occupants</h2>
${report.occupants.length > 0 ? metricRows(report.occupants.map((o) => ({ head: `${o.occupant.key} (#${o.occupant.id}, seats ${o.seats.join(', ')})`, card: o }))) : h`<p class="muted">None in the window.</p>`}
</section>
<section>
<h2>Agreement</h2>
<p class="muted">Pairwise disagreement on NEEDS-WORK vs not (raw verdicts: SHIP and SHIP-WITH-FIXES agree with each other), over the settled rounds where both ratified with a verdict. Two seats that always agree are one seat.</p>
${matrix(report.agreement.seats, seatKeys)}
${report.agreement.occupants.length > 0 ? h`<h3>By occupant</h3>${matrix(report.agreement.occupants, occupantKeys)}` : ''}
</section>`
    : ''
}
${
  report.seat_tests.length > 0
    ? h`<section>
<h2>Seat tests</h2>
<p class="muted">Runs of <code>seats test</code> on the planted-defect fixture. They are never counted in any metric above.</p>
<div class="scroll"><table>
<thead><tr><th scope="col">when</th><th scope="col">occupant</th><th scope="col">ratified</th><th scope="col">verdict</th><th scope="col">defects found</th><th scope="col">cost</th><th scope="col">duration</th></tr></thead>
<tbody>${report.seat_tests.map(
        (s) =>
          h`<tr><td>${s.ts.slice(0, 16).replace('T', ' ')}</td><td class="title"><code>${[s.backend, s.model, s.effort].filter((x) => x !== null).join(':')}</code>${s.seat !== null ? ` (seat ${s.seat})` : ''}</td><td>${s.ratified ? 'yes' : `no (${s.failure_class ?? s.status})`}</td><td>${s.verdict ?? 'none'}</td><td>${s.defects_found.length} of ${s.defects_total}${s.defects_found.length > 0 ? ` (${s.defects_found.join(', ')})` : ''}</td><td>${[s.cost_usd !== null ? money(s.cost_usd) : null, s.credits !== null ? `${s.credits} credits` : null].filter((x) => x !== null).join(', ') || '-'}</td><td>${durationText(s.duration_ms)}</td></tr>`,
      )}</tbody></table></div>
</section>`
    : ''
}
<section>
<h2>Definitions</h2>
<dl>
<dt>Rounds</dt><dd>Council rounds whose legs settled, dry runs included; identity rounds and rounds still running are left out. Finding metrics read only adjudicated rounds.</dd>
<dt>Ratified rate</dt><dd>Rounds with a ratified leg of the seat, over rounds it had a leg in (failed and solo rounds count).</dd>
<dt>Fallback and relaunch</dt><dd>A fallback is a leg with the role fallback; a relaunch is a leg at attempt 2 or later. A fallback leg counts for its seat and for its own occupant.</dd>
<dt>Adopted, refuted, precision</dt><dd>Adopted = owed + follow-up + ruling upheld; refuted = refuted + ruling overturned; precision = adopted / (adopted + refuted). Nits, noted findings and rulings not yet ruled on are in neither.</dd>
<dt>Unique</dt><dd>Raised by this seat alone, whatever severity each seat gave it. Unique HIGH uses the adjudicator's final severity and counts only adopted findings.</dd>
<dt>Drop-one</dt><dd>Blocking findings (owed, or a ruling that holds) it raised alone; rounds whose every blocking finding was its alone and that kept quorum without it would have been SHIP. A round left below quorum without it is counted as quorum lost, never as a flip.</dd>
<dt>Dissent</dt><dd>Its raw verdict, NEEDS-WORK vs not, differed from the two other ratified legs, which agreed (SHIP and SHIP-WITH-FIXES are one position: only NEEDS-WORK blocks). Right: a lone NEEDS-WORK in a round that ended blocked or with one of its own findings owed, or a lone SHIP or SHIP-WITH-FIXES in a round that ended with nothing blocking.</dd>
<dt>Cost</dt><dd>Every leg's cost, failed attempts included; units are never converted. Quota is the CLI's own rate-window snapshot (highest and latest). Durations are nearest-rank percentiles over ratified legs.</dd>
</dl>
</section>
</main>
</div>
</body>
</html>
`;
  return body.html;
}

/**
 * Writes the report with mode 0600, atomically (a temp file in the same directory, then a rename). An existing path
 * that is not a regular file (a symlink, a directory, a device) is refused, never followed or replaced.
 */
export function writeHtmlReport(path: string, report: StatsReport): void {
  const target = resolve(path);
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing !== null && !existing.isFile()) {
    throw new Error(`refusing to write the report over ${target}: it is not a regular file`);
  }
  const html = renderHtml(report);
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeSync(fd, html);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
