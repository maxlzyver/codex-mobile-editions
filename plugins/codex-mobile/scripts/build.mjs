import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await mkdir(path.join(root, 'dist'), { recursive: true });
const server = await build({ absWorkingDir: root, metafile: true, entryPoints: [path.join(root, 'lib/server.mjs')], outfile: path.join(root, 'dist/server.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', minify: true, legalComments: 'eof', banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
const ui = await build({ absWorkingDir: root, metafile: true, entryPoints: [path.join(root, 'ui/app.js')], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true, legalComments: 'eof', write: false });
const template = (await readFile(path.join(root, 'ui/template.html'), 'utf8'))
  .replace('/*__SPONSOR_IMAGE__*/', 'data:image/jpeg;base64,' + (await readFile(path.join(root, 'assets/support-wechat.jpg'))).toString('base64'))
  .replace('/*__APP_ICON__*/', 'data:image/png;base64,' + (await readFile(path.join(root, 'assets/app-icon.png'))).toString('base64'));
await writeFile(path.join(root, 'ui/app.html'), template.replace('/*__APP_SCRIPT__*/', () => ui.outputFiles[0].text.replaceAll('</script', '<\\/script')));
await mkdir(path.join(root, 'licenses'), { recursive: true });
const packages = new Map();
for (const input of [...Object.keys(server.metafile.inputs), ...Object.keys(ui.metafile.inputs)]) {
  const normalized = input.replaceAll('\\', '/');
  const matches = [...normalized.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
  if (!matches.length) continue;
  const match = matches.at(-1), directory = path.resolve(root, normalized.slice(0, match.index + match[0].length));
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  packages.set(`${pkg.name}@${pkg.version}`, { ...pkg, directory });
}
const notices = ['# Third-party notices', '', 'The bundled MCP server and embedded page include the components below. These entries are generated from the actual build inputs; their full license and notice files are shipped in `licenses/`.', ''];
for (const [identity, pkg] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const files = (await readdir(pkg.directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(name));
  if (!files.length) throw new Error(`Missing license for bundled component ${identity}`);
  const targets = [];
  for (const file of files) {
    const target = `${pkg.name.replaceAll('@', '').replaceAll('/', '-')}-${file}.txt`;
    await copyFile(path.join(pkg.directory, file), path.join(root, 'licenses', target)); targets.push(`\`licenses/${target}\``);
  }
  notices.push(`- ${identity} (${pkg.license || 'see license text'}) — ${targets.join(', ')}`);
}
notices.push('', 'Node.js and cloudflared are provided by the separate Editions complete installation and retain its existing license notices.', '');
await writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), notices.join('\n'));
console.log('Built bundled MCP server and embedded MCP Apps page.');
