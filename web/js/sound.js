// 효과음: 음원 파일 없이 Web Audio 로 합성합니다(저작권·외부 CDN 문제 없음).
let ctx = null;

export function audio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// 브라우저는 사용자가 한 번 화면을 만져야 소리를 허용합니다. 첫 터치에 미리 열어 둡니다.
export function unlockOnGesture() {
  const go = () => { audio(); window.removeEventListener('pointerdown', go, true); };
  window.addEventListener('pointerdown', go, true);
}

export const soundReady = () => !!ctx && ctx.state === 'running';

function env(g, t, a, d, peak = 0.5) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

function tone(freq, t, dur, type = 'sine', peak = 0.4) {
  const c = audio(), o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  env(g, t, 0.01, dur, peak);
  o.connect(g).connect(c.destination);
  o.start(t); o.stop(t + dur + 0.05);
}

let noiseBuf = null;
function noise(t, dur, filterType, freq, peak = 0.4) {
  const c = audio();
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  s.buffer = noiseBuf; f.type = filterType; f.frequency.value = freq;
  env(g, t, 0.003, dur, peak);
  s.connect(f).connect(g).connect(c.destination);
  s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
}

const SOUNDS = {
  correct: { label: '정답', play: (t) => { tone(880, t, 0.18, 'sine', 0.45); tone(1320, t + 0.14, 0.35, 'sine', 0.45); } },
  wrong: { label: '오답', play: (t) => { tone(233, t, 0.22, 'square', 0.18); tone(185, t + 0.2, 0.4, 'square', 0.18); } },
  clap: { label: '박수', play: (t) => { for (let i = 0; i < 26; i++) noise(t + i * 0.055 + Math.random() * 0.03, 0.06, 'bandpass', 1500 + Math.random() * 900, 0.5); } },
  focus: { label: '집중', play: (t) => { [1047, 1319, 1568].forEach((f, i) => tone(f, t + i * 0.22, 0.6, 'triangle', 0.35)); } },
  bell: { label: '종소리', play: (t) => { [[660, 0.4], [1320, 0.2], [1980, 0.12], [2640, 0.06]].forEach(([f, a]) => tone(f, t, 2.2, 'sine', a)); } },
  drum: { label: '두구두구', play: (t) => { for (let i = 0; i < 20; i++) noise(t + i * 0.06, 0.05, 'lowpass', 400, 0.6); noise(t + 1.25, 0.4, 'lowpass', 200, 0.9); tone(110, t + 1.25, 0.4, 'sine', 0.5); } },
  fanfare: { label: '팡파레', play: (t) => { [523, 659, 784].forEach((f, i) => tone(f, t + i * 0.12, 0.25, 'sawtooth', 0.12)); tone(1047, t + 0.38, 0.8, 'sawtooth', 0.14); tone(784, t + 0.38, 0.8, 'triangle', 0.2); } },
  alarm: { label: '끝', play: (t) => { for (let i = 0; i < 3; i++) { tone(988, t + i * 0.45, 0.18, 'square', 0.15); tone(988, t + i * 0.45 + 0.2, 0.18, 'square', 0.15); } } },
};

export const SOUND_LIST = Object.entries(SOUNDS).map(([id, s]) => ({ id, label: s.label }));

export function play(id) {
  const s = SOUNDS[id];
  if (!s) return false;
  const c = audio();
  s.play(c.currentTime + 0.02);
  return c.state === 'running';
}
