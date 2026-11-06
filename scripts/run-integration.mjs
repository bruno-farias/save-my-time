import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnProcess, stopProcess } from './process-tree.mjs';
const port = Number(process.env.SMT_SIMULATION_PORT || 4318);
const base = `http://127.0.0.1:${port}`;
const child = spawnProcess('postman', ['simulation', 'run', 'postman/simulations/providers.sim.yaml', '--port', String(port), '--no-history', '--output', 'ndjson'], { stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', errors = '';
child.stdout.on('data', data => { logs += data; });
child.stderr.on('data', data => { errors += data; });
child.on('error', error => { errors += error.message; });
try {
  let started = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`Simulation exited: ${errors || logs}`);
    if (logs.includes('"listening"')) { started = true; break; }
    await delay(200);
  }
  if (!started) throw new Error(`Postman simulation did not start: ${errors || logs}`);
  const test = spawn('npx', ['vitest', 'run', '--config', 'vitest.integration.config.ts'], { stdio: 'inherit', env: { ...process.env, SMT_SIMULATION_URL: base } });
  const code = await new Promise(resolve => test.on('exit', resolve));
  const events = logs.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const calls = events.filter(event => event.event === 'request' || event.type === 'request');
  const members = new Set(calls.map(event => event.routeKey));
  console.log(`Postman recorded ${calls.length} HTTP requests. Log: test-results/provider-simulation.ndjson`);
  process.exitCode = code === null ? 1 : Number(code);
  if (!calls.length) { console.error('No dependency requests were observed in the simulation log.'); process.exitCode = 1; }
  if (['ollama', 'openai', 'anthropic', 'gemini'].some(provider => !members.has(provider))) { console.error('A provider was missing from the simulation log.'); process.exitCode = 1; }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  await stopProcess(child);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/provider-simulation.ndjson', logs);
  if (errors) await writeFile('test-results/provider-simulation.err', errors);
}
