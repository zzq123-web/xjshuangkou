import { stripTypeScriptTypes } from 'node:module';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const projectRoot = process.cwd();
const sourceRoot = resolve(projectRoot, 'src');
const outputRoot = resolve(projectRoot, 'dist');
let built = 0;

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await visit(sourceRoot);
const serverOutput = resolve(outputRoot, 'server');
await mkdir(serverOutput, { recursive: true });
await cp(resolve(outputRoot, 'game'), resolve(serverOutput, 'game'), { recursive: true });
await cp(resolve(outputRoot, 'ui'), resolve(serverOutput, 'ui'), { recursive: true });
const page = await readFile(resolve(projectRoot, 'index.html'), 'utf8');
await writeFile(resolve(serverOutput, 'page.js'), `export default ${JSON.stringify(page)};\n`, 'utf8');
const assets = {};
await collectAssets(outputRoot);
await writeFile(resolve(serverOutput, 'assets.js'), `export const assets = ${JSON.stringify(assets)};\n`, 'utf8');
const workerSource = await readFile(resolve(serverOutput, 'worker.js'), 'utf8');
await writeFile(resolve(serverOutput, 'index.js'), workerSource.replaceAll("'../game/", "'./game/"), 'utf8');
await rm(resolve(serverOutput, 'worker.js'));
await mkdir(resolve(outputRoot, '.openai'), { recursive: true });
await writeFile(resolve(outputRoot, '.openai/hosting.json'), await readFile(resolve(projectRoot, '.openai/hosting.json'), 'utf8'), 'utf8');
process.stdout.write(`Built ${built} TypeScript modules into dist/.\n`);

async function collectAssets(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (directory === serverOutput && entry.isDirectory()) continue;
    const filePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'server' && entry.name !== '.openai') await collectAssets(filePath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js') || directory.startsWith(serverOutput)) continue;
    const assetPath = relative(outputRoot, filePath).split(sep).join('/');
    assets[`dist/${assetPath}`] = await readFile(filePath, 'utf8');
  }
}

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const sourcePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(sourcePath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
    const relativePath = relative(sourceRoot, sourcePath).split(sep).join('/').replace(/\.ts$/, '.js');
    const outputPath = resolve(outputRoot, relativePath);
    const source = await readFile(sourcePath, 'utf8');
    const javascript = stripTypeScriptTypes(source, { mode: 'strip' });
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, javascript, 'utf8');
    built += 1;
  }
}
