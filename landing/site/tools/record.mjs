// Records the desktop scroll-through as an MP4, frame by frame.
// The page runs in ?capture mode: time, scroll and pointer are driven from here,
// so the output is smooth regardless of how fast the machine renders.
//
//   npm run build && npm run preview      (in another shell)
//   node tools/record.mjs                 -> ../recordings/plinth-desktop-scroll.mp4
//   node tools/record.mjs --stills        -> ../recordings/stills/*.png (quick review)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const URL = process.env.URL || 'http://localhost:4173/?capture';
const W = 1920, H = 1080, FPS = 30;
const OUT_DIR = path.resolve(import.meta.dirname, '../../recordings');
const STILLS = process.argv.includes('--stills');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// piecewise scroll path: [time, y] keyframes, eased between each pair
function track(keys) {
  return (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [t1, v1] = keys[i], [t0, v0] = keys[i - 1];
      if (t <= t1) return v0 + (v1 - v0) * easeInOut((t - t0) / (t1 - t0));
    }
    return keys[keys.length - 1][1];
  };
}

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('console', (m) => m.type() === 'error' && console.log('[page]', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__capture);
await page.evaluate(() => window.__capture.ready);

// section geometry in page px
const g = await page.evaluate(() => {
  const top = (s) => document.querySelector(s).getBoundingClientRect().top + scrollY;
  const h = (s) => document.querySelector(s).getBoundingClientRect().height;
  return {
    vh: innerHeight,
    process: top('.process'), processH: h('.process'),
    statement: top('.statement'), statementH: h('.statement'),
    models: top('.models'), list: top('.models__list'),
    join: top('.join'), max: document.documentElement.scrollHeight - innerHeight,
    rows: [...document.querySelectorAll('.models__list li')].map((li) => li.getBoundingClientRect().top + scrollY + li.offsetHeight / 2),
    button: (() => { const r = document.querySelector('.join__form button').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })(),
  };
});
const P = (p) => g.process + p * (g.processH - g.vh);
const S = (s) => g.statement + s * (g.statementH - g.vh);

const scrollY = track([
  [0, 0], [7.0, 0],
  [10.2, P(0)], [13.2, P(0.13)], [13.8, P(0.14)],
  [15.6, P(0.25)], [16.4, P(0.25)],
  [17.6, P(0.34)], [19.4, P(0.47)], [20.2, P(0.5)],
  [22.0, P(0.67)], [22.6, P(0.69)],
  [24.4, P(0.8)], [27.2, P(1)], [27.8, P(1)],
  [29.2, S(0)], [34.0, S(1)],
  [36.8, g.models - g.vh * 0.02], [38.4, g.models - g.vh * 0.02],
  [40.6, g.list - g.vh * 0.3], [44.8, g.list - g.vh * 0.3],
  [48.4, g.max], [56, g.max],
]);
const LIST_Y = g.list - g.vh * 0.3;
const EMAIL = 'hello@studio.kr';
// pointer: over the figure in the hero, over the model rows later, hidden otherwise
function pointer(t) {
  if (t >= 4.6 && t < 7.8) {
    const k = (t - 4.6) / 3.2;
    return [1330 - 420 * easeInOut(Math.min(1, k * 1.6)) + Math.sin(k * 9) * 40, 640 - 250 * k + Math.cos(k * 7) * 30];
  }
  if (t >= 41.0 && t < 45.2) {
    const row = t < 43.2 ? 1 : 3;
    return [1240 + (t - 41) * 26, g.rows[row] - LIST_Y];
  }
  if (t >= 51.0 && t < 56) {
    const k = easeInOut(Math.min(1, (t - 51.0) / 1.2));
    return [1500 + (g.button[0] - 1500) * k, 900 + (g.button[1] - 900) * k];
  }
  return null;
}
const hoverRow = (t) => (t >= 41.4 && t < 43.2 ? 2 : t >= 43.2 && t < 45.2 ? 4 : 0);

async function frame(t) {
  const p = pointer(t);
  await page.evaluate(
    ([t, y, px, py, row, typed, sent]) => {
      document.querySelectorAll('.models__list li').forEach((li, i) => li.classList.toggle('is-hover', i + 1 === row));
      document.querySelector('.cursor').classList.toggle('is-link', row > 0 || (t > 51.9 && t < 53.2));
      const input = document.querySelector('#email');
      if (typed !== null) input.value = typed;
      if (sent && !input.dataset.sent) {
        input.dataset.sent = '1';
        input.form.requestSubmit();
      }
      return window.__capture.frame(t, y, px, py);
    },
    [t, scrollY(t), p?.[0] ?? null, p?.[1] ?? null, hoverRow(t),
      t < 49.6 ? '' : t >= 52.6 ? null : EMAIL.slice(0, Math.floor((t - 49.6) * 14)), t >= 52.6],
  );
}

if (STILLS) {
  const dir = process.env.STILLS_DIR || path.join(OUT_DIR, 'stills');
  fs.mkdirSync(dir, { recursive: true });
  const shots = (process.env.SHOTS || '4,8.6,10.4,11.8,13.6,16,18.4,21,26,30.6,32.6,38,50').split(',').map(Number);
  let t = 0;
  for (const s of shots) {
    for (; t < s; t += 0.1) await frame(t); // walk time forward so time-based state is right
    t = s;
    await frame(s);
    await page.screenshot({ path: path.join(dir, `t${String(s).padStart(5, '0')}.png`) });
    console.log('still', s);
  }
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dur = 56;
  const n = Math.round(dur * FPS);
  const out = path.join(OUT_DIR, 'plinth-desktop-scroll.mp4');
  const ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await frame(i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 94 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 30 === 0) console.log(`frame ${i}/${n}  ${((Date.now() - t0) / 1000 / (i + 1)).toFixed(2)}s/frame`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log('wrote', out);
}
await browser.close();
