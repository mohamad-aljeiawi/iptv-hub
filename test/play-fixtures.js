// Test media and a fake provider for the in-browser playback tests.
//
// The media is generated on the spot with ffmpeg (test patterns and sine tones),
// so nothing copyrighted ever enters the repository. The fake provider answers the
// Xtream API, serves the files with byte ranges, and counts how many connections
// are open per stream at the same time.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

export const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

const V = (size, dur) => ['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25:duration=${dur}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`];
const H264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '25'];

export const MEDIA = {
  'direct.mp4': [...V('320x240', 10), ...H264, '-c:a', 'aac', '-movflags', '+faststart', '-shortest'],
  'remux.mkv': [...V('320x240', 10), ...H264, '-c:a', 'aac', '-shortest'],
  'ac3.mkv': [...V('320x240', 10), ...H264, '-c:a', 'ac3', '-shortest'],
  'hevc.mkv': [...V('1920x1080', 6), '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-c:a', 'aac', '-shortest'],
  'long.mkv': [...V('320x240', 40), ...H264, '-c:a', 'ac3', '-shortest'],
  'live.ts': [...V('320x240', 20), ...H264, '-c:a', 'aac', '-shortest', '-f', 'mpegts'],
};

export function makeMedia(dir) {
  for (const [name, args] of Object.entries(MEDIA)) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, path.join(dir, name)]);
  }
}

export function probeFile(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,height', '-of', 'json', file])).streams;
}

// vod: { streamId: [title, file] }, live: { streamId: [title, file] }.
// Live files are sent at roughly real time and never end on their own, like a
// real channel, until the client goes away.
export function fakeProvider(dir, { vod, live }) {
  const active = new Map(), peak = new Map();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = v => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (u.pathname === '/player_api.php') {
      switch (u.searchParams.get('action')) {
        case null: return json({ user_info: { auth: 1, status: 'Active' } });
        case 'get_vod_streams': return json(Object.entries(vod).map(([id, [name, file]]) =>
          ({ stream_id: +id, name, category_id: '1', container_extension: path.extname(file).slice(1) })));
        case 'get_live_streams': return json(Object.entries(live).map(([id, [name]]) => ({ stream_id: +id, name, category_id: '2' })));
        case 'get_vod_categories': return json([{ category_id: '1', category_name: 'Films' }]);
        case 'get_live_categories': return json([{ category_id: '2', category_name: 'Channels' }]);
        default: return json([]);
      }
    }
    const m = u.pathname.match(/^\/(movie|live)\/[^/]+\/[^/]+\/(\d+)\.\w+$/);
    const entry = m && (m[1] === 'movie' ? vod : live)[m[2]];
    if (!entry) { res.writeHead(404); return res.end(); }
    const key = u.pathname;
    active.set(key, (active.get(key) || 0) + 1);
    peak.set(key, Math.max(peak.get(key) || 0, active.get(key)));
    res.on('close', () => active.set(key, active.get(key) - 1));

    const file = path.join(dir, entry[1]);
    const size = fs.statSync(file).size;
    if (m[1] === 'live') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(32 * 1024);
      let pos = 0;
      const iv = setInterval(() => {
        const n = fs.readSync(fd, buf, 0, buf.length, pos % size);
        pos += n;
        if (!res.write(buf.subarray(0, n))) { /* keep pace; drop nothing */ }
      }, 40);
      res.on('close', () => { clearInterval(iv); fs.closeSync(fd); });
      return;
    }
    const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = r ? +r[1] : 0, end = r && r[2] ? Math.min(+r[2], size - 1) : size - 1;
    res.writeHead(r ? 206 : 200, { 'Content-Type': m[1] === 'movie' && file.endsWith('.mp4') ? 'video/mp4' : 'video/x-matroska',
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(r ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    fs.createReadStream(file, { start, end }).pipe(res);
  });
  return {
    server, active: k => active.get(k) || 0, peak: k => peak.get(k) || 0,
    listen: () => new Promise(ok => server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise(ok => { server.closeAllConnections(); server.close(ok); }),
  };
}
