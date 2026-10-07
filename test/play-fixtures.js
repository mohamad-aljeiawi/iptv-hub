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
  // Two audio tracks (English AAC by default, Arabic AC3) and two text subtitles
  // (SRT English, ASS Arabic). The subtitle files are written by makeMedia.
  'multi.mkv': [...V('320x240', 12), '-f', 'lavfi', '-i', 'sine=frequency=660:duration=12', '-i', '{dir}/en.srt', '-i', '{dir}/ar.ass',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-map', '4:s', ...H264, '-c:a:0', 'aac', '-c:a:1', 'ac3', '-c:s', 'copy',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=ara', '-metadata:s:a:1', 'title=Arabic',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=ara', '-disposition:a:0', 'default', '-disposition:a:1', '0', '-shortest'],
};

const SRT = '1\n00:00:01,000 --> 00:00:04,000\nHello from the first subtitle\n\n2\n00:00:06,000 --> 00:00:09,000\nA second line\n';
const ASS = ['[Script Info]', 'ScriptType: v4.00+', '', '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1', '',
  '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:02.00,0:00:05.00,Default,,0,0,0,,مرحبا من الترجمة', ''].join('\n');

export function makeMedia(dir) {
  fs.writeFileSync(path.join(dir, 'en.srt'), SRT);
  fs.writeFileSync(path.join(dir, 'ar.ass'), ASS);
  for (const [name, args] of Object.entries(MEDIA)) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args.map(a => a.replace('{dir}', dir)), path.join(dir, name)]);
  }
}

export function probeFile(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,height', '-of', 'json', file])).streams;
}

// vod: { streamId: [title, file] }, live: { streamId: [title, file] },
// series: { seriesId: [title, { season: [file, ...] }] }.
// dropEvery: cut every stream connection after that many bytes, like providers that
// drop long connections at random.
// Live files are sent at roughly real time and never end on their own, like a
// real channel, until the client goes away.
export function fakeProvider(dir, { vod, live, series = {}, dropEvery = 0 }) {
  // Episode id = series id * 1000 + season * 100 + episode number.
  const episodes = new Map();
  for (const [sid, [, seasons]] of Object.entries(series))
    for (const [season, files] of Object.entries(seasons))
      files.forEach((file, i) => episodes.set(String(+sid * 1000 + +season * 100 + i + 1), [file, +season, i + 1, sid]));
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
        case 'get_series_categories': return json([{ category_id: '3', category_name: 'Shows' }]);
        case 'get_series': return json(Object.entries(series).map(([id, [name]]) => ({ series_id: +id, name, category_id: '3' })));
        case 'get_series_info': {
          const sid = u.searchParams.get('series_id'), out = {};
          for (const [id, [file, season, num, owner]] of episodes) if (owner === sid)
            (out[season] ||= []).push({ id, episode_num: num, season, title: `Episode ${num}`, container_extension: path.extname(file).slice(1),
              info: { duration_secs: Math.round(+JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path.join(dir, file)])).format.duration) } });
          return json({ seasons: Object.keys(out).map(n => ({ season_number: +n })), info: { name: series[sid]?.[0] }, episodes: out });
        }
        default: return json([]);
      }
    }
    const m = u.pathname.match(/^\/(movie|live|series)\/[^/]+\/[^/]+\/(\d+)\.\w+$/);
    const entry = m && (m[1] === 'movie' ? vod[m[2]] : m[1] === 'live' ? live[m[2]] : episodes.has(m[2]) ? [null, episodes.get(m[2])[0]] : null);
    if (!entry) { res.writeHead(404); return res.end(); }
    const key = u.pathname;
    active.set(key, (active.get(key) || 0) + 1);
    peak.set(key, Math.max(peak.get(key) || 0, active.get(key)));
    res.on('close', () => active.set(key, active.get(key) - 1));
    let sent = 0;
    const cut = n => { sent += n; if (dropEvery && sent >= dropEvery) { res.socket.destroy(); return true; } return false; };

    const file = path.join(dir, entry[1]);
    const size = fs.statSync(file).size;
    if (m[1] === 'live') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(32 * 1024);
      let pos = 0;
      const iv = setInterval(() => {
        const n = fs.readSync(fd, buf, 0, buf.length, pos % size);
        pos += n;
        if (res.destroyed) return;
        res.write(buf.subarray(0, n));
        cut(n);
      }, 40);
      res.on('close', () => { clearInterval(iv); fs.closeSync(fd); });
      return;
    }
    const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = r ? +r[1] : 0, end = r && r[2] ? Math.min(+r[2], size - 1) : size - 1;
    res.writeHead(r ? 206 : 200, { 'Content-Type': m[1] === 'movie' && file.endsWith('.mp4') ? 'video/mp4' : 'video/x-matroska',
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(r ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    const rs = fs.createReadStream(file, { start, end, highWaterMark: 16 * 1024 });
    rs.on('data', chunk => { if (res.destroyed) return rs.destroy(); res.write(chunk); if (cut(chunk.length)) rs.destroy(); });
    rs.on('end', () => res.end());
  });
  return {
    server, active: k => active.get(k) || 0, peak: k => peak.get(k) || 0,
    listen: () => new Promise(ok => server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise(ok => { server.closeAllConnections(); server.close(ok); }),
  };
}
