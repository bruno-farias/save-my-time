import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { validateLanguage } from '../src/locales/validation.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, 'src/locales/languages');
async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => entry.isDirectory() ? sources(resolve(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [resolve(directory, entry.name)] : []));
  return files.flat();
}
const messages = new Set();
for (const file of await sources(resolve(root, 'src'))) {
  const ast = parse(await readFile(file, 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    const call = node.type === 'CallExpression' && node.callee?.type === 'Identifier' && ['t', 'mark'].includes(node.callee.name);
    // Extraction runs in the content script without the UI or its dictionaries.
    // Its errors are translated by the panel after the extraction result arrives.
    const extractionError = file.endsWith('/lib/extract.ts') && node.type === 'NewExpression' && node.callee?.name === 'Error';
    if ((call || extractionError) && node.arguments[0]?.type === 'StringLiteral') messages.add(node.arguments[0].value);
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child);
  }
  visit(ast);
}
const english = Object.fromEntries([...messages].sort().map(message => [message, message]));
const englishPath = resolve(directory, 'en.json');
const source = JSON.parse(await readFile(englishPath, 'utf8'));
if (process.argv.includes('--sync')) {
  await writeFile(englishPath, JSON.stringify({ ...source, messages: english }, null, 2) + '\n');
  console.log(`Updated en.json: ${messages.size} source messages. Existing translations were kept.`);
} else {
  const issues = [];
  if (JSON.stringify(source.messages) !== JSON.stringify(english)) issues.push('en.json is out of date. Run npm run locales:sync after changing UI strings.');
  if (source.code !== 'en' || !source.interface) issues.push('English must remain available as the interface fallback.');
  let total = 0, interfaces = 0;
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.json')).sort()) {
    try {
      const language = JSON.parse(await readFile(resolve(directory, file), 'utf8'));
      for (const problem of validateLanguage(language, file.slice(0, -5), english)) issues.push(`${file}: ${problem}`);
      ++total;
      if (language.interface) { ++interfaces; console.log(`${language.code}: ${Object.keys(language.messages).length}/${messages.size} interface messages`); }
    } catch (error) { issues.push(`${relative(root, resolve(directory, file))}: ${error.message}`); }
  }
  if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
  else console.log(`Validated ${total} AI output languages and ${interfaces} interface languages.`);
}
