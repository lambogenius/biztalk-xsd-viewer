import { build, context } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await mkdir('releases', { recursive: true });
const options = { entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', target: 'node20', external: ['vscode'], outfile: 'dist/extension.js', sourcemap: true, logLevel: 'info' };
if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
