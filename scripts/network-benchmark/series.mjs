import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

export function statistics(values) {
  const valid = values.filter(v => typeof v === 'number' && Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const n = valid.length;
  return { samples: n, missing: values.length - n, median: n ? (valid[Math.floor((n - 1) / 2)] + valid[Math.floor(n / 2)]) / 2 : null,
    p95: n ? valid[Math.ceil(n * .95) - 1] : null, max: n ? valid[n - 1] : null };
}
export function summarizeReports(reports) {
  const names = [...new Set(reports.flatMap(r => (r.stages ?? []).map(s => s.name).filter(Boolean)))].filter(n => !n.startsWith('warmup'));
  return { successfulRuns: reports.filter(r => r.success).length,
    stages: Object.fromEntries(names.map(name => [name, Object.fromEntries(['durationMs', 'cpuUserMs', 'cpuSystemMs'].map(key => [key,
      statistics(reports.flatMap(r => r.success ? ((r.stages ?? []).some(s => s.name === name) ? r.stages.filter(s => s.name === name).map(s => s[key]) : [null]) : [null]))]))])),
    sampledImplementationPeakBytes: statistics(reports.map(r => r.success ? r.accounting?.sampledImplementationPeakBytes : null)),
    fullImplementationBudgetAccepted: false };
}
async function metadata() {
  const git = async args => { try { return (await exec('git', args, { cwd: root })).stdout.trim(); } catch { return null; } };
  const files = (await git(['ls-files', 'src', 'extension', 'package.json', 'package-lock.json']))?.split('\n').filter(Boolean) ?? [];
  const hash = createHash('sha256');
  for (const file of files.sort()) { hash.update(file + '\0'); hash.update(await readFile(path.join(root, file))); }
  return { revision: await git(['rev-parse', 'HEAD']), dirty: !!(await git(['status', '--porcelain'])), productionSha256: hash.digest('hex'),
    node: process.version, platform: process.platform, arch: process.arch, os: os.release(), cpu: os.cpus()[0]?.model, ramBytes: os.totalmem(),
    packageLockSha256: createHash('sha256').update(await readFile(path.join(root, 'package-lock.json'))).digest('hex') };
}
export async function dispatchSeries(harness) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--series') && !argv.includes('--implementation') && !argv.includes('--drivers')) return;
  const rest = []; let runs = 30, implementation = 'node', registry;
  for (let i = 0; i < argv.length; i++) {
    if (['--series', '--implementation', '--drivers'].includes(argv[i])) {
      const flag = argv[i], value = argv[++i];
      if (!value || value.startsWith('--')) throw Error(`Missing value for ${flag}`);
      if (flag === '--series') runs = Number(value);
      if (flag === '--implementation') implementation = value;
      if (flag === '--drivers') registry = value;
    } else rest.push(argv[i]);
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > 1000) throw Error('--series must be 1..1000');
  const ids = implementation.split(',');
  if (new Set(ids).size !== ids.length) throw Error('Duplicate implementation');
  if (rest.includes('--live') && ids.length > 1) throw Error('Cross-implementation live comparison requires separately frozen identical captures; use replay');
  const drivers = registry ? JSON.parse(await readFile(path.resolve(registry), 'utf8')) : {};
  for (const id of ids) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw Error('Invalid implementation ID');
    if (id !== 'node') {
      const d = drivers[id];
      if (!d || !path.isAbsolute(d.command ?? '') || !Array.isArray(d.args) || !d.args.every(a => typeof a === 'string') ||
          !d.version || !d.revision || !Array.isArray(d.buildFlags)) throw Error(`Implementation ${id} unavailable: supply --drivers with command, args, version, revision and buildFlags`);
    }
  }
  const parent = path.join(root, '.cache/figma-network/benchmarks'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'series-'));
  const environment = await metadata(), raw = [], reports = Object.fromEntries(ids.map(id => [id, []]));
  const save = (name, value) => writeFile(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  // Rotate execution order to reduce systematic first/last implementation bias.
  for (let run = 0; run < runs; run++) for (const id of [...ids.slice(run % ids.length), ...ids.slice(0, run % ids.length)]) {
    const request = { version: 1, harness, run, arguments: rest, modes: { cold: 'fresh-process', warm: 'same-process-retained-selection', osCache: 'uncontrolled', forcedGc: false } };
    const requestFile = path.join(directory, `${id}-${run}-request.json`); await save(path.basename(requestFile), request);
    const d = drivers[id];
    let entry, sourceReport;
    try {
      let execution;
      try { execution = await exec(id === 'node' ? process.execPath : d.command,
        id === 'node' ? [path.join(root, `scripts/measure-network-${harness}.mjs`), ...rest] : [...d.args, '--benchmark-request', requestFile],
        { cwd: root, timeout: 600000, maxBuffer: 4 * 1024 * 1024 }); }
      catch (error) {
        // Preserve a structured failure report, including budget failures, when the driver produced one.
        try { const out = JSON.parse(error.stdout?.trim()); if (path.isAbsolute(out.report ?? '')) { sourceReport = out.report; await save(`${id}-${run}-report.json`, JSON.parse(await readFile(out.report, 'utf8'))); } } catch {}
        throw error;
      }
      const output = JSON.parse(execution.stdout.trim());
      if (!output.report || !path.isAbsolute(output.report)) throw Error('Driver must return an absolute report path');
      sourceReport = output.report;
      const report = JSON.parse(await readFile(output.report, 'utf8'));
      await save(`${id}-${run}-report.json`, report);
      if (report.success !== true || !report.fixture?.sha256 || !Array.isArray(report.stages) || !report.query || !report.mode) throw Error('Invalid driver report: success, fixture.sha256, query, mode, stages required');
      const comparable = JSON.stringify({ fixture: report.fixture.sha256, query: report.query, mode: report.mode, warmup: report.warmup, warmRequests: report.warmRequests });
      const first = raw.find(r => r.comparable);
      if (first && first.comparable !== comparable) throw Error('Different fixture/query/mode/warm protocol: comparison refused');
      reports[id].push(report); entry = { implementation: id, run, success: true, sourceReport: output.report, comparable };
    } catch (error) {
      // Driver stdout/stderr may contain private captures or credentials; do not copy them.
      entry = { implementation: id, run, success: false, sourceReport, error: error.code ? `Driver failed (${error.code})` : error.message };
      reports[id].push({ success: false });
    }
    raw.push(entry); await save('runs.json', raw);
    console.error(`${harness} ${id} ${run + 1}/${runs}: ${entry.success ? 'ok' : entry.error}`);
  }
  const report = { version: 1, date: new Date().toISOString(), runId: path.basename(directory), harness, environment,
    implementations: Object.fromEntries(ids.map(id => [id, id === 'node' ? { version: process.version, revision: environment.revision, productionSha256: environment.productionSha256, label: 'current working tree; not automatically N0' } : drivers[id]])),
    arguments: rest, runs, success: raw.every(r => r.success), results: Object.fromEntries(ids.map(id => [id, summarizeReports(reports[id])])), raw,
    limitations: ['p95 uses nearest rank; small samples are smoke tests.', 'Warm samples within a process are correlated; raw reports preserve run grouping.', 'Missing metrics remain null; no full 500 MB budget acceptance.', 'Observer/fixture generation excluded from implementation RSS; observer has its own metrics.', 'Fresh process does not flush OS caches. No forced GC. Functional parity must be checked separately with the frozen corpus.'] };
  await save('report.json', report);
  console.log(JSON.stringify({ success: report.success, report: path.join(directory, 'report.json') }));
  process.exit(report.success ? 0 : 1);
}
