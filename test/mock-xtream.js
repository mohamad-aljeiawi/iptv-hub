// A fake Xtream server for development and tests. It streams no video; it only has
// to answer the way a real panel does.
// Used by: npm test and npm run dev
import http from 'node:http';

export const DEFAULTS = {
  live: [
    { stream_id: 1, name: '[AR] MBC 1 FHD', category_id: '10', epg_channel_id: 'mbc1', stream_icon: '' },
    { stream_id: 2, name: 'AR: بي ان سبورت 1 HD', category_id: '10', epg_channel_id: 'bein1', stream_icon: '' },
  ],
  vod: [
    { stream_id: 11, name: 'EN - The Matrix (1999) 1080p', category_id: '20', container_extension: 'mkv', tmdb: '603', rating: '8.7' },
    { stream_id: 12, name: 'Inception 2010 4K', category_id: '20', container_extension: 'mp4', tmdb: '27205', rating: '8.4' },
  ],
  series: [
    { series_id: 21, name: '[AR] Breaking Bad (2008)', category_id: '30', cover: '', tmdb: '1396' },
  ],
  cats: { live: [{ category_id: '10', category_name: '|AR| قنوات عربية' }], vod: [{ category_id: '20', category_name: 'EN Movies' }], series: [{ category_id: '30', category_name: 'Series AR' }] },
  episodes: { 1: [{ id: '901', episode_num: 1, title: 'Pilot', container_extension: 'mkv', season: 1 }] },
};

// data: overrides on top of DEFAULTS. auth:false makes the server reject logins,
// which is how failover is exercised.
export function mockXtream({ name = 'mock', data = {}, auth = true } = {}) {
  const d = { ...DEFAULTS, ...data, cats: { ...DEFAULTS.cats, ...(data.cats || {}) } };
  const hits = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(u.pathname + u.search);
    const json = v => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (u.pathname === '/player_api.php') {
      if (!auth) return json({ user_info: { auth: 0 } });
      switch (u.searchParams.get('action')) {
        case null: case '': return json({ user_info: { auth: 1, status: 'Active', exp_date: '9999999999', max_connections: '2' },
          server_info: { url: 'localhost' } });
        case 'get_live_categories': return json(d.cats.live);
        case 'get_vod_categories': return json(d.cats.vod);
        case 'get_series_categories': return json(d.cats.series);
        case 'get_live_streams': return json(d.live);
        case 'get_vod_streams': return json(d.vod);
        case 'get_series': return json(d.series);
        case 'get_series_info': return json({ seasons: [], info: { plot: `plot from ${name}` }, episodes: d.episodes });
        case 'get_vod_info': return json({ info: { plot: `movie plot from ${name}` }, movie_data: {} });
        default: return json([]);
      }
    }
    // Playback URLs: nothing is streamed, we just confirm the request arrived.
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.end('stream:' + name);
  });
  return {
    name, server, hits,
    async listen() {
      await new Promise(ok => server.listen(0, '127.0.0.1', ok));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close: () => new Promise(ok => server.close(ok)),
  };
}

// Run directly (node test/mock-xtream.js) to get two servers for development.
if (process.argv[1]?.endsWith('mock-xtream.js')) {
  const ports = (process.env.MOCK_PORTS || '19001,19002').split(',').map(Number);
  for (const [i, port] of ports.entries()) {
    const m = mockXtream({ name: 'mock' + (i + 1) });
    m.server.listen(port, '127.0.0.1', () =>
      console.log(`Mock Xtream server #${i + 1}: http://127.0.0.1:${port}  (username: test / password: test)`));
  }
}
