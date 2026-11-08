// Mock Fish Audio Drama 3 style TTS server for tests: /health, /v1/models, POST /v1/audio/voices, POST /v1/audio/speech.
// The "voice" is a sine tone whose length follows the number of words (0.36 s per word). No model, no GPU.
import http from 'node:http';

function wav(seconds, freq, sr = 24000) {
  const n = Math.round(seconds * sr), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const env = Math.min(1, i / 400, (n - i) / 400); b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * 9000 * env), 44 + i * 2); }
  return b;
}

export function startMockTts({ failSpeech = 0, secPerWord = 0.36, requireKey = '' } = {}) {
  const stats = { speech: 0, voices: [], bodies: [], keys: [] };
  const voices = new Set();
  const server = http.createServer((req, res) => {
    stats.keys.push(req.headers.authorization || '');
    if (requireKey && req.headers.authorization !== `Bearer ${requireKey}`) { res.writeHead(401); res.end('{"error":"bad key"}'); return; }
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"data":[]}'); return; }
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (req.method === 'POST' && req.url === '/v1/audio/voices') {
        const name = /name="name"\r\n\r\n([^\r]+)/.exec(raw.toString('latin1'))?.[1];
        if (voices.has(name)) { res.writeHead(409); res.end('{"error":"voice already exists"}'); return; }
        voices.add(name); stats.voices.push(name);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
      }
      if (req.method === 'POST' && req.url === '/v1/audio/speech') {
        stats.speech++;
        let body; try { body = JSON.parse(raw.toString('utf8')); } catch { res.writeHead(400); res.end('bad json'); return; }
        stats.bodies.push(body);
        if (!voices.has(body.voice)) { res.writeHead(404); res.end('{"error":"unknown voice"}'); return; }
        if (failSpeech && (failSpeech === true || stats.speech % failSpeech === 0)) { res.writeHead(500); res.end('{"error":"mock failure"}'); return; }
        const words = String(body.input).replace(/^\s*\[[^\]]*\]\s*/, '').split(/\s+/).filter(Boolean).length;
        const out = wav(Math.max(0.5, words * secPerWord), body.voice.endsWith('caster_a') ? 180 : 260);
        res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(out); return;
      }
      res.writeHead(404); res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, stats, close: () => new Promise((r) => server.close(r)) })));
}
