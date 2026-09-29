import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Browser processes a run can leave behind. The user's own Chrome and Safari never match:
// Playwright's Chrome runs with --remote-debugging-pipe and Safari MCP sessions with --automation.
const LEFTOVER_PATTERNS = {
  safariAutomation: /Safari\.app\/Contents\/MacOS\/Safari .*--automation/,
  playwrightChrome: /MacOS\/Google Chrome .*--remote-debugging-pipe/,
  playwrightWebkit: /ms-playwright\/webkit-\d+\/(pw_run\.sh|Playwright\.app\/Contents\/MacOS\/Playwright)/,
};

function run(command, args, timeout = 15000) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return error.stdout || '';
  }
}

export function processTable() {
  const rows = [];
  for (const line of run('ps', ['-axo', 'pid=,ppid=,command=']).split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return rows;
}

function kindOf(command) {
  return Object.entries(LEFTOVER_PATTERNS).find(([, pattern]) => pattern.test(command))?.[0] ?? null;
}

// Browser processes that descend from the given root (the run's claude process). Called
// while the run is alive, because orphans are re-parented to launchd once claude exits.
export function trackDescendantBrowsers(rootPid, tracked) {
  const table = processTable();
  const children = new Map();
  for (const row of table) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const stack = [rootPid];
  while (stack.length) {
    for (const child of children.get(stack.pop()) || []) {
      const kind = kindOf(child.command);
      if (kind) tracked.set(child.pid, { kind, command: child.command });
      stack.push(child.pid);
    }
  }
}

// Safari MCP windows belong to a Safari process that launchd starts, so it is not a
// descendant of claude. The only link is timing: a new --automation Safari during a
// safari-mcp run.
export function safariAutomationPids() {
  return processTable().filter((row) => kindOf(row.command) === 'safariAutomation').map((row) => row.pid);
}

const chromeRunning = () => run('pgrep', ['-x', 'Google Chrome']).trim().length > 0;

export function chromeWindowIds() {
  if (!chromeRunning()) return [];
  const out = run('osascript', ['-e', 'tell application "Google Chrome" to get id of every window']);
  return out.split(',').map((s) => s.trim()).filter(Boolean);
}

function closeChromeTabs(runId, windowsBefore) {
  if (!chromeRunning()) return 0;
  const before = `{${windowsBefore.map((id) => `"${id}"`).join(',')}}`;
  const script = `
    set closed to 0
    set beforeIds to ${before}
    tell application "Google Chrome"
      repeat with w in (every window)
        repeat with i from (count of tabs of w) to 1 by -1
          set t to tab i of w
          if URL of t contains "${runId}.localhost" then
            close t
            set closed to closed + 1
          end if
        end repeat
      end repeat
      repeat with w in (every window)
        set wid to (id of w) as text
        if beforeIds does not contain wid then
          if (count of tabs of w) is 1 and URL of tab 1 of w starts with "chrome://newtab" then
            close w
            set closed to closed + 1
          end if
        end if
      end repeat
    end tell
    return closed`;
  return Number(run('osascript', ['-e', script]).trim()) || 0;
}

function closeOrcaTabs(runId, worktreeSelector) {
  const out = run('orca', ['tab', 'list', '--worktree', worktreeSelector, '--json']);
  let tabs = [];
  try {
    tabs = JSON.parse(out).result?.tabs ?? [];
  } catch {}
  const mine = tabs.filter((tab) => (tab.url || '').includes(`${runId}.localhost`)).sort((a, b) => b.index - a.index);
  for (const tab of mine) run('orca', ['tab', 'close', '--worktree', worktreeSelector, '--index', String(tab.index), '--json']);
  return mine.length;
}

function removeRunFiles(runId, directories) {
  let removed = 0;
  for (const directory of directories) {
    let names = [];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.includes(runId)) continue;
      rmSync(join(directory, name), { force: true, recursive: true });
      removed += 1;
    }
  }
  return removed;
}

export async function cleanupRun({ runId, variant, tracked, safariBefore, chromeWindowsBefore, workdir, orcaWorktree }) {
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const alive = new Map(processTable().map((row) => [row.pid, row.command]));
  const killed = [];
  for (const [pid, info] of tracked) {
    if (alive.get(pid) !== info.command) continue;
    try {
      process.kill(pid, 'SIGTERM');
      killed.push(info.kind);
    } catch {}
  }
  if (variant === 'safari-mcp') {
    for (const pid of safariAutomationPids().filter((pid) => !safariBefore.includes(pid))) {
      try {
        process.kill(pid, 'SIGTERM');
        killed.push('safariAutomation');
      } catch {}
    }
  }
  return {
    killedProcesses: killed,
    chromeTabsClosed: variant === 'claude-in-chrome' ? closeChromeTabs(runId, chromeWindowsBefore) : 0,
    orcaTabsClosed: orcaWorktree ? closeOrcaTabs(runId, orcaWorktree) : 0,
    filesRemoved: removeRunFiles(runId, [join(homedir(), 'Downloads'), workdir]),
  };
}
