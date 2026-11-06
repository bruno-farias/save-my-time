import { mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('release', { recursive: true });
await rm('release/save-my-time.zip', { force: true });
const result = spawnSync('zip', ['-r', '-q', '../release/save-my-time.zip', '.'], { cwd: 'dist', stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
console.log('Packaged release/save-my-time.zip');
