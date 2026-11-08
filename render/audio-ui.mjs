// Spectator sound control: "Sound on" (needs a click: browser autoplay rule), mute (key M) and three volume sliders.
export function mountAudioUI(audio, root) {
  if (!root) return;
  const slider = (name, label) => `<label title="${label} volume">${label}<input type="range" min="0" max="100" step="1" data-v="${name}"></label>`;
  root.classList.add('off');
  root.innerHTML = `<button class="start" title="Browsers only allow sound after a click">Sound on</button><button class="mute" title="Mute (M)">Mute</button>${slider('master', 'Vol')}${slider('music', 'Music')}${slider('sfx', 'SFX')}`;
  const start = root.querySelector('.start'), mute = root.querySelector('.mute');
  const sync = () => {
    const st = audio.status();
    root.classList.toggle('off', st.state === 'off' || st.state === 'unsupported');
    start.style.display = st.state === 'off' ? '' : st.state === 'unsupported' ? '' : 'none';
    if (st.state === 'unsupported') start.textContent = 'No audio'; else if (st.state === 'loading') start.textContent = 'Loading...';
    mute.textContent = st.muted ? 'Unmute' : 'Mute'; mute.classList.toggle('on', st.muted);
    for (const i of root.querySelectorAll('input[data-v]')) if (document.activeElement !== i) i.value = Math.round(st.vol[i.dataset.v] * 100);
    if (st.state !== 'off' && st.state !== 'unsupported') root.classList.remove('off');
  };
  root.classList.remove('off'); // the start button is visible before the first click
  start.addEventListener('click', () => audio.unlock());
  mute.addEventListener('click', () => audio.toggleMute());
  root.addEventListener('input', (e) => { const n = e.target.dataset?.v; if (n) audio.setVolume(n, e.target.value / 100); });
  audio.on(sync); sync();
  // any first click on the page may also start sound if the viewer pressed M or touched a slider
  window.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'm' && audio.state === 'off') audio.unlock(); });
}
