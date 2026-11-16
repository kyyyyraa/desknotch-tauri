/**
 * Verifies the extracted frontend: every local reference in index.html must
 * resolve to a file inside the asset directory, and the bridge shim must be
 * the first script the document loads.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const root = process.argv[2];
const ui = join(root, 'ui');
const indexPath = join(ui, 'index.html');

const REQUIRED_SCRIPTS = [
  'dn-conversation.js',
  'dn-extras.js',
  'dn-harness.js',
  'dn-intent.js',
  'dn-router.js',
  'dn-voice.js',
  'dn-voice-boot.js',
  'dn-voice-exec.js',
  'dn-voice-ptt.js',
  'dn-whisper.js',
  'dn-whisper-worker.js',
];

const problems = [];
const notes = [];

const html = readFileSync(indexPath, 'utf8');

// Every local reference the document makes.
const refs = new Set();
for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) refs.add(m[1]);

let external = 0;
for (const ref of refs) {
  if (/^(https?:|data:|blob:|#|mailto:)/.test(ref)) {
    external++;
    continue;
  }
  const target = ref.startsWith('/')
    ? join(ui, ref.slice(1))
    : resolve(dirname(indexPath), ref);
  if (!existsSync(target)) {
    problems.push(`broken reference: ${ref} -> ${target}`);
  } else {
    notes.push(`ok  ${ref} (${statSync(target).size} bytes)`);
  }
}

// The shim has to run before anything else.
const scriptTags = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
const firstScript = scriptTags[0] ?? '';
if (!/tauri-bridge-shim\.js/.test(firstScript)) {
  problems.push(`bridge shim is not the first script tag: ${firstScript}`);
} else {
  notes.push('ok  tauri-bridge-shim.js is the first script in <head>');
}
if (/tauri-bridge-shim\.js/.test(html) === false) {
  problems.push('bridge shim is not referenced at all');
}

// Every script the frontend needs has to be both on disk and linked.
for (const script of REQUIRED_SCRIPTS) {
  const onDisk = join(ui, script);
  if (!existsSync(onDisk)) {
    problems.push(`missing script on disk: ${script}`);
    continue;
  }
  if (!html.includes(script)) {
    problems.push(`script present but not linked in index.html: ${script}`);
    continue;
  }
  notes.push(`ok  ${script} (${statSync(onDisk).size} bytes)`);
}

// Static asset roots that have to survive the extraction.
for (const dir of ['_next/static/chunks', '_next/static/media', 'images']) {
  const target = join(ui, dir);
  if (!existsSync(target)) {
    problems.push(`missing asset directory: ${dir}`);
    continue;
  }
  const count = readdirSync(target).length;
  notes.push(`ok  ${dir} (${count} entries)`);
}

// The build id in the document has to match the directory on disk.
const buildId = html.match(/"buildId":"([^"]+)"/)?.[1];
if (buildId) {
  const manifest = join(ui, '_next/static', buildId, '_buildManifest.js');
  if (!existsSync(manifest)) {
    problems.push(`build id ${buildId} has no matching static directory`);
  } else {
    notes.push(`ok  build id ${buildId}`);
  }
}

console.log(notes.join('\n'));
console.log('');
if (problems.length) {
  console.log('PROBLEMS:');
  for (const p of problems) console.log('  !! ' + p);
  process.exit(1);
}
console.log(`All checks passed (${notes.length} verified, ${external} external references ignored).`);
