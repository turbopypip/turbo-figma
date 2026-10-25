import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export function pidList(values) {
  const ids = [...new Set(values.map(Number))];
  if (!ids.length || ids.length > 32 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Expected 1–32 positive process IDs');
  return ids;
}
export async function readRss(pids, platform = process.platform) {
  const ids = pidList(pids);
  if (platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64) | ConvertTo-Json -Compress`], { timeout: 5000, maxBuffer: 65536 });
    const values = stdout.trim() ? JSON.parse(stdout) : [];
    return new Map((Array.isArray(values) ? values : [values]).map(p => [p.Id, p.WorkingSet64]));
  }
  if (!['darwin', 'linux'].includes(platform)) throw new Error('RSS observer supports macOS, Linux and Windows only');
  let stdout;
  try { ({ stdout } = await exec('ps', ['-o', 'pid=,rss=', '-p', ids.join(',')], { timeout: 5000, maxBuffer: 65536 })); }
  catch (error) { if (error.code !== 1) throw error; stdout = error.stdout; }
  return new Map(stdout.trim().split('\n').filter(Boolean).map(line => {
    const [pid, kib] = line.trim().split(/\s+/).map(Number);
    if (!ids.includes(pid) || !Number.isFinite(kib) || kib < 0) throw new Error('Invalid RSS sample');
    return [pid, kib * 1024];
  }));
}
export function summarizeSamples(samples, roles) {
  const pids = pidList(roles.map(r => r.pid));
  if (pids.length !== roles.length) throw new Error('A PID must have only one role; worker threads share the MCP PID');
  const byRole = {};
  for (const role of roles) {
    const values = samples.map(s => s.rss[role.pid]).filter(v => Number.isFinite(v));
    byRole[role.name] = { pid: role.pid, samples: values.length, sampledPeakRssBytes: values.length ? Math.max(...values) : null };
  }
  const eligible = roles.filter(r => r.name === 'mcp' || r.name.startsWith('extension-'));
  const totals = samples.filter(s => eligible.every(r => Number.isFinite(s.rss[r.pid])))
    .map(s => eligible.reduce((n, r) => n + s.rss[r.pid], 0));
  const extensionMeasured = eligible.some(r => r.name.startsWith('extension-'));
  return { byRole, sampledMcpPlusSelectedExtensionProcessesBytes: extensionMeasured && totals.length ? Math.max(...totals) : null,
    fullImplementationPeakBytes: null, budgetAccepted: false,
    reason: 'Sampling misses short peaks; selected browser PIDs do not prove complete extension/CDP attribution; end-to-end Windows acceptance is still pending.' };
}
