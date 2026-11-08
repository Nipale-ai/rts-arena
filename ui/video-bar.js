// Replay page: a "Make video" button in the bottom bar (injected by the arena for replays only).
import { openVideoDialog } from '/ui/video.js';
const m = /\/watch\/r-([A-Za-z0-9._-]+)\//.exec(location.pathname);
const bar = document.getElementById('arena-bar');
if (m && bar) {
  const b = document.createElement('button');
  b.className = 'vbtn-bar'; b.type = 'button'; b.textContent = 'Make video';
  const refresh = async () => {
    try { const j = (await (await fetch(`/api/matches/${m[1]}/video`)).json()).job; b.textContent = j && (j.status === 'running' || j.status === 'queued') ? `Video ${j.percent}%` : j?.status === 'done' ? 'Video ready' : 'Make video'; } catch { /* keep the label */ }
  };
  b.addEventListener('click', () => openVideoDialog(m[1], { onChange: refresh }));
  bar.append(b);
  refresh(); setInterval(refresh, 4000);
}
