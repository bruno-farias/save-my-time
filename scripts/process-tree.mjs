import { spawn } from 'node:child_process';

export function spawnProcess(command, args, options = {}) {
  // CLI launchers may leave descendants holding their output pipes open.
  // A separate process group lets cleanup stop the entire tree on POSIX.
  return spawn(command, args, { ...options, detached: process.platform !== 'win32' });
}

export async function stopProcess(child, graceMs = 2000) {
  const exited = child.exitCode !== null || child.signalCode !== null;
  if (!child.pid || (exited && !child.stdout?.readable && !child.stderr?.readable)) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  const signalTree = signal => {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await new Promise((resolve, reject) => { killer.once('error', reject); killer.once('exit', resolve); });
  } else {
    signalTree('SIGTERM');
  }
  let timer;
  try {
    const stopped = await Promise.race([
      closed.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), graceMs); })
    ]);
    if (!stopped) {
      if (process.platform !== 'win32') signalTree('SIGKILL');
      else child.kill();
      await closed;
    }
  } finally { clearTimeout(timer); }
}
