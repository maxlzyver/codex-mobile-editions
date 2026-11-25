import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
const sdkTools = process.env.CODEX_ANDROID_BUILD_TOOLS || path.join(sdk, 'build-tools', '36.0.0');
const android = process.env.CODEX_ANDROID_PLATFORM || path.join(sdk, 'platforms', 'android-36', 'android.jar');
const zxing = process.env.CODEX_ANDROID_ZXING_JAR;
const keystore = process.env.CODEX_ANDROID_KEYSTORE;
const alias = process.env.CODEX_ANDROID_KEY_ALIAS || 'codex-mobile';
const unsigned = process.argv.includes('--unsigned');
const manifest = path.join(root, 'src', 'AndroidManifest.xml');
const version = /android:versionName="([^"]+)"/.exec(await readFile(manifest, 'utf8'))?.[1];
const output = path.resolve(process.argv.slice(2).find(arg => arg !== '--unsigned') ||
    path.join(root, 'build', `codex-mobile-android-${version}${unsigned ? '-unsigned' : ''}.apk`));
if (!zxing) throw new Error('Set CODEX_ANDROID_ZXING_JAR to ZXing Core 3.5.3.');
if (!unsigned && (!keystore || !process.env.CODEX_ANDROID_STOREPASS)) {
  throw new Error('Set CODEX_ANDROID_KEYSTORE and CODEX_ANDROID_STOREPASS for an installable APK.');
}
const scratch = await mkdtemp(path.join(os.tmpdir(), 'codex-android-'));
const exe = name => process.platform === 'win32' ? name + '.exe' : name;
const tool = name => path.join(sdkTools, exe(name));
const java = name => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', exe(name)) : name;
function run(command, args) {
  execFileSync(command, args, { cwd: scratch, stdio: 'inherit', windowsHide: true });
}

async function javaFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await javaFiles(filename));
    else if (entry.isFile() && entry.name.endsWith('.java')) files.push(filename);
  }
  return files;
}

try {
  const resources = path.join(scratch, 'resources.zip'), generated = path.join(scratch, 'generated');
  const classes = path.join(scratch, 'classes'), dex = path.join(scratch, 'dex');
  const rawApk = path.join(scratch, 'raw.apk'), alignedApk = path.join(scratch, 'aligned.apk');
  await Promise.all([generated, classes, dex, path.dirname(output)].map(dir => mkdir(dir, { recursive: true })));
  run(tool('aapt2'), ['compile', '--dir', path.join(root, 'src', 'res'), '-o', resources]);
  run(tool('aapt2'), ['link', '-I', android, '--manifest', manifest, '--java', generated, '-o', rawApk, resources]);
  run(java('javac'), ['-encoding', 'UTF-8', '--release', '8', '-classpath', [android, zxing].join(path.delimiter),
    '-d', classes, ...await javaFiles(path.join(root, 'src', 'main', 'java')), ...await javaFiles(generated)]);
  const program = path.join(scratch, 'program.jar');
  run(java('jar'), ['cf', program, '-C', classes, '.']);
  run(java('java'), ['-cp', path.join(sdkTools, 'lib', 'd8.jar'), 'com.android.tools.r8.D8', '--release',
    '--min-api', '26', '--lib', android, '--output', dex, program, zxing]);
  run(java('jar'), ['uf', rawApk, '-C', dex, 'classes.dex']);
  run(tool('zipalign'), ['-p', '-f', '4', rawApk, alignedApk]);
  if (unsigned) await copyFile(alignedApk, output);
  else {
    const signer = path.join(sdkTools, 'lib', 'apksigner.jar');
    run(java('java'), ['-jar', signer, 'sign', '--ks', keystore, '--ks-key-alias', alias,
      '--ks-pass', 'env:CODEX_ANDROID_STOREPASS', '--out', output, alignedApk]);
    run(java('java'), ['-jar', signer, 'verify', '--verbose', output]);
  }
  console.log(output);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
