import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';

const reportPath = 'reports/mutation/mutation.json';
await rm(reportPath, { force: true });
const child = spawn(process.execPath, ['node_modules/@stryker-mutator/core/bin/stryker.js', 'run', ...process.argv.slice(2)], { stdio: 'inherit' });
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1));
});
if (code !== 0) process.exit(code);

// Stryker excludes runner crashes from its score. A green percentage must not
// conceal mutants the runner could not execute.
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const mutants = Object.values(report.files).flatMap(file => file.mutants);
const crashes = mutants.filter(mutant => mutant.status === 'RuntimeError');
if (crashes.length) {
  console.error(`${crashes.length} mutations failed because the test runner errored. Review reports/mutation/mutation.html before accepting the score.`);
  process.exitCode = 1;
} else if (!mutants.some(mutant => ['Killed', 'Survived', 'Timeout'].includes(mutant.status))) {
  console.error('No mutations were executed. Check the mutate paths before accepting this run.');
  process.exitCode = 1;
} else {
  console.log('Mutation run completed without test-runner errors.');
}
