import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runTests } from '@vscode/test-electron';
await build({ entryPoints: ['tests/extension-host.ts'], bundle: true, platform: 'node', target: 'node20', external: ['vscode'], outfile: '.test-temp/extension-host.cjs' });
const candidates = [process.env.VSCODE_EXECUTABLE, join(process.env.LOCALAPPDATA || '', 'Programs/Microsoft VS Code/Code.exe'), 'C:/Program Files/Microsoft VS Code/Code.exe'].filter(Boolean);
const executable = candidates.find(existsSync);
if (!executable) throw new Error('Set VSCODE_EXECUTABLE to an installed VS Code executable.');
delete process.env.ELECTRON_RUN_AS_NODE;
await runTests({
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: resolve('.'),
  extensionTestsPath: resolve('.test-temp/extension-host.cjs'),
  launchArgs: ['--user-data-dir', resolve('.test-temp/vscode-user'), '--extensions-dir', resolve('.test-temp/vscode-extensions'), '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-updates', '--disable-telemetry', '--disable-gpu', '--no-sandbox', '--new-window', resolve('examples')]
});
