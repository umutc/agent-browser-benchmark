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

export function browserProcesses() {
  const out = run('ps', ['-axo', 'pid=,command=']);
  const found = [];
  for (const line of out.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    for (const [kind, pattern] of Object.entries(LEFTOVER_PATTERNS)) {
      if (pattern.test(match[2])) found.push({ pid: Number(match[1]), kind });
    }
  }
  return found;
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

export async function cleanupRun({ runId, processesBefore, chromeWindowsBefore, workdir, orcaWorktree }) {
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const beforePids = new Set(processesBefore.map((p) => p.pid));
  const leftovers = browserProcesses().filter((p) => !beforePids.has(p.pid));
  for (const process_ of leftovers) {
    try {
      process.kill(process_.pid, 'SIGTERM');
    } catch {}
  }
  return {
    killedProcesses: leftovers.map((p) => p.kind),
    chromeTabsClosed: closeChromeTabs(runId, chromeWindowsBefore),
    orcaTabsClosed: orcaWorktree ? closeOrcaTabs(runId, orcaWorktree) : 0,
    filesRemoved: removeRunFiles(runId, [join(homedir(), 'Downloads'), workdir]),
  };
}
