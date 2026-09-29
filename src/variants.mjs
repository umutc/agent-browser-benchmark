import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
export const WORKDIR = join(ROOT, 'workdir');
export const ORCA_WORKTREE = `path:${ROOT}`;

const PLAYWRIGHT_MCP_CLI =
  process.env.PW_MCP_CLI || '/Users/umutc/.npm/_npx/9833c18b2d85bc59/node_modules/@playwright/mcp/cli.js';

const ORCA_BROWSER_COMMANDS = [
  'goto', 'back', 'reload', 'snapshot', 'screenshot', 'full-screenshot', 'pdf', 'click', 'fill', 'type',
  'select', 'check', 'scroll', 'hover', 'focus', 'keypress', 'upload', 'wait', 'eval', 'tab', 'cookie',
  'capture', 'console', 'network', 'exec', 'inserttext', 'drag', 'dblclick',
];

let orcaGuide = null;
function orcaSystemPrompt() {
  if (orcaGuide === null) {
    const reference = execFileSync('orca', ['skills', 'get', 'orca-cli', '--reference', 'references/browser.md'], {
      encoding: 'utf8',
    });
    orcaGuide = [
      "You control a web browser (Orca's built-in browser) with the `orca` command-line tool, run through the Bash tool.",
      'Commands target the browser of the Orca workspace for the current directory. Always add --json.',
      'Only `orca` browser commands are allowed; other shell commands are denied.',
      '',
      reference.replaceAll('ORCA ', 'orca '),
    ].join('\n');
  }
  return orcaGuide;
}

// Every variant runs with the same model, effort, prompt and isolation flags; only the
// browser surface changes. Read is available everywhere so screenshots saved to disk and
// downloaded files can be inspected.
export const VARIANTS = {
  'claude-in-chrome': {
    engine: 'Chrome (user profile)',
    surface: 'Claude in Chrome extension (MCP)',
    mcpServers: () => ({}),
    flags: ['--chrome'],
    tools: ['Read'],
    allowedTools: ['mcp__claude-in-chrome__*', 'Read'],
    permissionMode: 'bypassPermissions',
    infraErrors: /Browser extension is not connected|No Chrome extension connected/i,
  },
  'safari-mcp': {
    engine: 'Safari (WebKit)',
    surface: 'safaridriver --mcp',
    mcpServers: () => ({ safari: { command: 'node', args: [join(ROOT, 'src/safari-proxy.mjs')] } }),
    flags: ['--no-chrome'],
    tools: ['Read'],
    allowedTools: ['mcp__safari__*', 'Read'],
    permissionMode: 'bypassPermissions',
    infraErrors: /remote automation is (turned off|not enabled)|Allow remote automation/i,
  },
  'pw-chrome': {
    engine: 'Chrome (Playwright, isolated profile)',
    surface: '@playwright/mcp',
    mcpServers: (runDir) => {
      const configPath = join(runDir, 'playwright.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          browser: {
            browserName: 'chromium',
            isolated: true,
            launchOptions: { channel: 'chrome', headless: false, args: ['--start-maximized'] },
            contextOptions: { viewport: null },
          },
          outputDir: join(runDir, 'playwright'),
        }),
      );
      return { playwright: { command: 'node', args: [PLAYWRIGHT_MCP_CLI, '--config', configPath] } };
    },
    flags: ['--no-chrome'],
    tools: ['Read'],
    allowedTools: ['mcp__playwright__*', 'Read'],
    permissionMode: 'bypassPermissions',
    infraErrors: /is not installed|Failed to launch/i,
  },
  'pw-webkit': {
    engine: 'WebKit (Playwright build)',
    surface: '@playwright/mcp',
    mcpServers: (runDir) => ({
      playwright: {
        command: 'node',
        args: [
          PLAYWRIGHT_MCP_CLI, '--browser', 'webkit', '--isolated', '--viewport-size', '1728x890',
          '--output-dir', join(runDir, 'playwright'),
        ],
      },
    }),
    flags: ['--no-chrome'],
    tools: ['Read'],
    allowedTools: ['mcp__playwright__*', 'Read'],
    permissionMode: 'bypassPermissions',
    infraErrors: /is not installed|Failed to launch/i,
  },
  'orca-browser': {
    engine: 'Chromium (Orca/Electron)',
    surface: 'orca CLI through Bash',
    mcpServers: () => ({}),
    flags: ['--no-chrome'],
    tools: ['Bash', 'Read'],
    allowedTools: [...ORCA_BROWSER_COMMANDS.map((c) => `Bash(orca ${c}:*)`), 'Read'],
    permissionMode: 'dontAsk',
    appendSystemPrompt: orcaSystemPrompt,
    infraErrors: /Orca is not running|browser_host_unavailable/i,
  },
};

export function selectVariants(selector) {
  if (selector === 'all') return Object.keys(VARIANTS);
  const names = selector.split(',').map((s) => s.trim());
  for (const name of names) if (!VARIANTS[name]) throw new Error(`unknown variant: ${name}`);
  return names;
}

export function claudeArgs({ variantName, prompt, schema, runDir, model, effort }) {
  const variant = VARIANTS[variantName];
  const mcpConfigPath = join(runDir, 'mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: variant.mcpServers(runDir) }));
  return [
    '-p', prompt,
    '--model', model,
    '--effort', effort,
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPath,
    '--no-session-persistence',
    '--output-format', 'stream-json',
    '--verbose',
    '--json-schema', JSON.stringify(schema),
    '--permission-mode', variant.permissionMode,
    ...variant.flags,
    ...(variant.appendSystemPrompt ? ['--append-system-prompt', variant.appendSystemPrompt()] : []),
    '--tools', ...variant.tools,
    '--allowedTools', ...variant.allowedTools,
  ];
}
