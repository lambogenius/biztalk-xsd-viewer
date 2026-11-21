import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['tests/schema.test.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: '.test-temp/schema.test.cjs' });
const result = spawnSync(process.execPath, ['--test', '.test-temp/schema.test.cjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
