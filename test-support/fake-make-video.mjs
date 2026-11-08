// Stand-in for tools/make-video.mjs in tests (RTS_VIDEO_TOOL): same arguments and @@ protocol, no rendering.
// Behaviour: the file <replay dir>/FAKE_MODE or the environment FAKE_MODE = ok | fail | slow (waits until it is killed) | key (prints the key it was given)
import fs from 'node:fs';
import path from 'node:path';
const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const out = opt('--out'), mf = path.join(a[0], 'FAKE_MODE'), mode = fs.existsSync(mf) ? fs.readFileSync(mf, 'utf8').trim() : process.env.FAKE_MODE || 'ok';
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'args.json'), JSON.stringify({ args: a, key_given: !!process.env.OPENAI_API_KEY }));
console.log('@@check|1|Checking');
if (mode === 'key') console.log('the key is ' + process.env.OPENAI_API_KEY);
if (mode === 'fail') { console.log('@@error Chrome was not found (fake).'); process.exit(1); }
console.log('@@script|20|Writing');
if (mode === 'slow') { process.on('SIGTERM', () => process.exit(143)); setInterval(() => console.log('@@render|40|Rendering'), 200); await new Promise(() => {}); }
console.log('@@render|60|Rendering');
const name = 'fake-' + path.basename(out) + '-yt.mp4';
fs.writeFileSync(path.join(out, name), Buffer.alloc(5000, 7));
fs.writeFileSync(path.join(out, 'fake.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
console.log('@@result ' + JSON.stringify({ outputs: [{ file: name, kind: 'video', preset: 'yt', label: 'YouTube 16:9 (1920x1080)', bytes: 5000 }, { file: 'fake.srt', kind: 'captions', label: 'Captions (.srt)', bytes: 40 }], warnings: ['fake warning'], script: { source: 'template', lines: 3 }, voices: false }));
