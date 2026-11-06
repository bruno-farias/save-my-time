import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnProcess, stopProcess } from '../scripts/process-tree.mjs';

for (const ignoreTermination of [false, true]) {
  test(`stops a mock launcher and its descendant holding the output pipe (ignore TERM: ${ignoreTermination})`, { timeout: 10000 }, async () => {
    const descendant = `${ignoreTermination ? "process.on('SIGTERM', () => {});" : ''}process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    const launcher = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] });
      ${ignoreTermination ? "process.on('SIGTERM', () => process.exit(0));" : ''}
      setInterval(() => {}, 1000);
    `;
    const child = spawnProcess(process.execPath, ['-e', launcher], { stdio: ['ignore', 'pipe', 'pipe'] });
    let closed = false;
    child.once('close', () => { closed = true; });
    try {
      const [ready] = await once(child.stdout, 'data');
      assert.equal(ready.toString(), 'ready');
      await stopProcess(child, 100);
      assert.equal(closed, true, 'all descendants must release the inherited output pipe');
      assert.equal(child.stdout.readable, false);
      await stopProcess(child, 100); // Cleanup is safe to call again.
    } finally { if (!closed) await stopProcess(child, 100); }
  });
}
