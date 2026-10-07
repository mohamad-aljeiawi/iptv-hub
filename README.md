# IPTV Hub

A virtual Xtream Codes server. Point it at several IPTV providers you already pay for, and
your players see **one** catalogue with no duplicates. Every stream request is answered
with a 302 redirect to the upstream provider, so video never passes through your server.

[![Tests](https://github.com/mohamad-aljeiawi/iptv-hub/actions/workflows/test.yml/badge.svg)](https://github.com/mohamad-aljeiawi/iptv-hub/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 22.16](https://img.shields.io/badge/node-%3E%3D22.16-339933.svg)](https://nodejs.org/)

```bash
# Install on a Linux server with a subdomain pointed at it
git clone https://github.com/mohamad-aljeiawi/iptv-hub.git /opt/iptv-hub && cd /opt/iptv-hub
sudo ./install.sh --domain iptv.example.com --email you@example.com

# Or just try it locally: no dependencies, nothing to npm install
npm run dev     # the app on :8080 plus two mock Xtream providers to add
```

Then add a playlist of type **Xtream Codes** in TiviMate, IPTV Smarters or any other
Xtream player, using your site's URL and a user you created. What the player gets back:

```console
$ curl -sI http://127.0.0.1:8080/live/joe/secret/1.ts
HTTP/1.1 302 Found
Location: http://127.0.0.1:19001/live/alice/a-secret/1.ts
Cache-Control: no-store
```

`joe` is a local user. `alice` is the upstream account behind it, picked from whichever
provider is healthy and fastest right now. (Real output, against the two mock providers
that `npm run dev` starts.)

<!--
  Screenshot of the web interface goes here, e.g.:
  ![IPTV Hub search](docs/screenshot.png)
-->

> The web interface is in Arabic, because it is built for an Arabic-speaking audience.
> Everything else (code, comments, docs, logs, CLI) is English.

## What it does

**Four providers, 179,848 links, 119,858 items.** That is a real catalogue: 19,285
channels, 70,024 movies and 30,549 series after merging. 31,706 of those items are
carried by more than one provider, and each shows up once, with its sources ranked.

**Names are cleaned before they are compared.** Providers glue country codes, quality
tags and decoration onto every title. Without cleaning, these are three different movies:

| Provider A | Provider B | IPTV Hub |
|---|---|---|
| `EN - The Matrix (1999) 1080p` | `[AR] the matrix 1999 4K` | `The Matrix (1999)`, 2 sources |
| `[AR] MBC 1 FHD` | `[AR] MBC 1 FHD` | `MBC 1`, 2 sources |
| `\|AR\| قنوات عربية` (category) | `AR - قنوات عربيه` | one category |

TMDB ids are used first when a provider supplies them, then the clean name plus year.
Arabic is folded too: diacritics, tatweel, the forms of alef, yeh and teh marbuta, and
Eastern Arabic digits all compare equal.

**Search answers in about 2 ms.** Median 1.7 ms, worst 21 ms, over twelve uncached
queries against the 119,858-item catalogue above (Intel i7-13700F). Prefix match first,
then SQLite FTS5 trigrams, then a typo-tolerant fallback: `intersteller` finds
*Interstellar* and `brekin bad` finds *Breaking Bad*, each with a "did you mean".

**Failover without the player knowing.** Every item has several sources, ordered with
healthy servers first, then fastest to respond.

- **Channels:** if a stream drops and the player reconnects within 20 seconds, the next source is used.
- **Movies:** a movie stays on the same server while seeking; the source only changes if playback fails from the start.
- **Episodes:** merged across all servers, so an episode missing from one server is fetched from another.
- **Dead servers:** health-checked every 5 minutes and excluded until they come back.

**Close to zero bandwidth.** The server handles metadata and redirects only. With the
119,858-item catalogue above loaded and every player listing pre-built, the process sits
at about 210 MB of RAM.

**Zero npm dependencies.** Node.js built-ins only (`node:sqlite`, `node:test`, `fetch`).

## What it does not do

- **It ships no content.** No channels, no playlists, no provider accounts. It only
  merges Xtream accounts you already have.
- **It does not restream or transcode.** Players connect straight to the upstream
  provider. If you need the video to go through your server (to hide upstream
  credentials, or to share one upstream connection among several viewers), you want a
  restreaming proxy such as [Threadfin](https://github.com/Threadfin/Threadfin) instead.
- **It does not record.** No DVR and no catch-up; `tv_archive` is always reported as 0.
- **It is not a reseller panel.** Local users have a username, password, device count
  and expiry date. There are no credits, no sub-resellers and no billing.
- **It does not run serverless.** Vercel and similar platforms will not work, because
  the project needs a persistent database and background jobs.

## How it works

```
 providers                  IPTV Hub                                players
 ---------                  --------                                -------
 Xtream A --+   sync     +--------------------------+  player_api.php
 Xtream B --+---------->  | normalize -> merge ->    | <------------ TiviMate
 Xtream C --+  metadata | SQLite + FTS5 catalogue  |  get.php       Smarters
            ^   only    +--------------------------+  xmltv.php     VLC ...
            |                        |
            |       /live/u/p/42.ts  |  302 Location: upstream URL
            +------------------------+-------------------------------->
                       video goes straight from provider to player
```

Sync pulls categories and stream lists (never video) every 6 hours, cleans every name,
and merges entries into items that each carry a list of sources. When a player asks for
a stream, IPTV Hub picks a source and answers with a 302 to the upstream URL. The
[project layout](#project-layout) below maps each step to its module.

## One-command install on a server

There are two installers. Both put nginx in front with a Let's Encrypt certificate and
keep the player paths on plain HTTP:

- **`install.sh`** runs the app directly on Node.js under systemd. Use it on a plain
  Ubuntu or Debian server. Described below.
- **`deploy.sh`** runs the app in Docker. Use it on a server that already uses Docker
  and nginx. See [Deploy with Docker](#deploy-with-docker).

Works on a server that already hosts other sites and services, and touches none
of their configuration.

```bash
git clone https://github.com/mohamad-aljeiawi/iptv-hub.git /opt/iptv-hub && cd /opt/iptv-hub
sudo ./install.sh --domain iptv.example.com --email you@example.com
```

What the script does:

| Step | Details |
|---|---|
| Pre-flight checks | OS, Node version, any web server already on 80/443, and DNS for the subdomain. Prints a report and stops with the exact DNS record to add if it does not resolve to this server |
| Automatic free port | The first unused port between `18000` and `18999`, confirmed with `ss -ltn` and by grepping nginx and systemd configs, then stored in `.env` so it never changes |
| Localhost binding | The app listens on `127.0.0.1`, never `0.0.0.0`, so no firewall port has to be opened |
| Domain and certificate | **nginx present:** one standalone `/etc/nginx/sites-available/iptv-hub.conf` plus `nginx -t` before reloading, deleted automatically if the test fails. **No web server:** installs Caddy with automatic certificates. **Apache or Traefik:** prints a ready-to-copy config and changes nothing |
| Persistent service | An `iptvhub` system user with no privileges and no login shell, systemd with `Restart=always`, `MemoryMax=1G` and `ProtectSystem=strict` |
| Data separated from code | The database lives in `/var/lib/iptv-hub/`, outside the code directory, so updates cannot touch it |
| Backups | Daily via `VACUUM INTO`, keeping the last 7 copies |

Running the script a second time is safe: nothing is duplicated and no data is lost.

Officially supported: Ubuntu 22.04, Ubuntu 24.04 and Debian 12. If Node.js 22.16 or newer
is missing, the script offers to install Node 22 from NodeSource.

Extra options: `--port` to force a port, `--no-ssl` to skip the certificate,
`--skip-dns` behind Cloudflare, `--yes` to answer yes to everything.

### Management

```bash
iptvhub status        # status, port, domain, server and item counts
iptvhub logs          # follow the live log
iptvhub restart
iptvhub update        # pull the latest version and restart (backs up first)
iptvhub backup        # back up now
iptvhub admin-pass    # show or change the admin password
iptvhub uninstall     # clean removal, asks whether to keep the database
```

### Deploy with Docker

On a server with Docker, the Compose plugin and nginx. The same command does the first
deployment and every update, and only asks for the domain and an email for Let's
Encrypt (both remembered for the next run):

```bash
curl -fsSL https://raw.githubusercontent.com/mohamad-aljeiawi/iptv-hub/main/deploy.sh -o deploy.sh
sudo bash deploy.sh                       # first deployment
sudo bash /opt/iptv-hub/deploy.sh         # every update after that
sudo bash /opt/iptv-hub/deploy.sh --backup
```

| Step | Details |
|---|---|
| Code | Clones into `/opt/iptv-hub`, then fast-forwards on later runs. Local edits stop the update instead of being overwritten |
| DNS check | Stops with the exact A record to add if the domain does not point at this server, and rejects an AAAA record that points elsewhere |
| Container | `docker compose up -d --build`, published on `127.0.0.1` only (Docker bypasses UFW, so nothing is exposed directly). The database lives in the `iptv-hub-data` volume |
| nginx | The same standalone site file as `install.sh`, tested with `nginx -t` and rolled back if the test fails |
| Certificate | `certbot certonly --webroot`, requested once. A renewal hook reloads nginx, certbot's timer is enabled, and a renewal dry run proves it works |
| Backups | Before every update, and daily via a systemd timer, to `/var/backups/iptv-hub` (last 7 kept) |

Moving an existing installation? Copy its database to `/root/iptv-hub-import.db` before
the first run. It is imported once into the empty volume, and the admin password and
providers come with it.

`compose.yml` also works on its own: `docker compose up -d --build`, then point any
reverse proxy at `127.0.0.1:18000`.

### Why player paths are not forced to HTTPS

`/player_api.php`, `/get.php`, `/xmltv.php`, `/live/`, `/movie/` and `/series/`
stay served over plain HTTP. Some players, ExoPlayer-based ones especially, refuse
cross-protocol redirects: if the playlist URL is `https` and the upstream stream is
`http`, playback stops. The web interface itself redirects to HTTPS as normal. That is
why TiviMate works on both `http://iptv.example.com` and `https://iptv.example.com`.

## Running locally

Requires Node.js 22.16 or newer. Earlier 22.x releases either lack `node:sqlite` without
a flag or were built without FTS5, and the app will not start on them.

```bash
cp .env.example .env      # optional
npm start                 # or: node --no-warnings src/index.js
```

The admin password is printed to the terminal. Open `http://localhost:8080`,
log in as `admin`, then add your providers and users from the settings tab.

**No server of your own?** `cloudflared tunnel --url http://localhost:8080` gives you a
temporary public URL immediately. Video does not pass through Cloudflare, because it is
redirected straight to the upstream provider.

## Connecting a player (TiviMate / IPTV Smarters / ...)

Add a playlist of type **Xtream Codes**:

- **URL:** your site, e.g. `https://iptv.example.com` or `http://192.168.1.10:8080`
- **Username and password:** a user you created in the users tab, or the admin account

The M3U link in the "player" tab works too. EPG is served from `/xmltv.php`.

## Settings

All optional and documented in [`.env.example`](.env.example):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listening port. The installer picks one from 18000-18999 |
| `HOST` | `127.0.0.1` | Listening address. Keep it on localhost behind a proxy |
| `ADMIN_TOKEN` | generated | Admin password. Empty means one is generated once and stored in the database |
| `PUBLIC_URL` | from proxy headers | Base URL for player links and the M3U playlist |
| `DB` | `./catalog.db` | Database path |
| `SYNC_HOURS` | `6` | How often each provider's catalogue is re-fetched |
| `HEALTH_MIN` | `5` | How often providers are health-checked (drives failover) |
| `UA` | `Mozilla/5.0` | User-Agent sent upstream |

The real `.env` holds your admin password and is never committed.

## Known limitations

| Limitation | Workaround |
|---|---|
| The 302 `Location` contains the upstream username and password, so anyone who can see the player's traffic can read them | Only give accounts to people you trust. Hiding them requires a restreaming proxy, which IPTV Hub deliberately is not |
| Local user passwords are stored in plain text and shown to the admin in the users tab. The Xtream protocol puts them in every playlist and stream URL anyway | Give each player account its own password, never one reused elsewhere |
| A local user's device count is reported to players but not enforced | Each provider's own `max_connections` still applies upstream |
| The "did you mean" fallback can pick an unrelated word when nothing really matches. On the 119,858-item catalogue, `بي ان سبورت` was "corrected" to `بي ان سوره`, because the providers only spell that channel in Latin script | Search for the spelling the provider uses (`bein`) |
| EPG comes from the provider that carries the most channels, so channels that exist only on another provider may have no guide | None yet |
| The browser player has no HLS library: live channels play only where the browser plays HLS natively, and an HTTPS page cannot load HTTP streams | Use the "open in device player", VLC download or copy-link buttons |
| The installer targets apt-based systems (Ubuntu 22.04/24.04, Debian 12) | On other distributions, run `npm start` under your own service manager and proxy |

## Development

```bash
npm run dev     # auto-reload plus two mock Xtream servers ready to add
npm test        # name cleaning, merging, search and 302 redirect tests
npm run mocks   # just the mock servers
```

The tests use throwaway databases and local mock servers. They need no network access
and no provider account.

### Project layout

```
src/
  index.js      entry point only: wires routers and schedules jobs
  config.js     reads .env and settings
  db.js         database, numbered migrations, accounts and sessions
  normalize.js  name cleaning and de-duplication keys (pure module)
  sync.js       syncing with upstream servers and health checks
  search.js     search engine
  resolve.js    source selection, failover and 302 URL building
  xtream.js     the Xtream API for players
  api.js        web UI and admin API
  http.js       HTTP helpers, router and response cache
public/         the web interface (one HTML file, no build step)
scripts/        install.sh, the iptvhub CLI, nginx/caddy/systemd templates
deploy.sh       Docker deployment (with Dockerfile and compose.yml)
test/           mock-xtream.js plus node:test suites
```

Module dependencies flow one way, with no cycles:
`config -> db -> normalize/http -> sync -> resolve -> xtream -> api -> index`.

### Migrations

Numbered inside `src/db.js` and applied automatically at startup based on
`PRAGMA user_version`. To change the schema, append a new function to the end of
the array and never edit an existing one, so no update can break existing data.

## Notes

- **Login protection:** `limit_req` in nginx plus an in-app limit (5 failed attempts per minute per IP) that works behind any proxy.
- **Connection limits:** connections are counted against the upstream accounts, so each provider's `max_connections` still applies.

## Contributing

Bug reports and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first,
especially the list of things that will be declined. Run `npm test` before opening a pull
request. Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## License

[MIT](LICENSE). The reasoning, and the one third-party asset the interface loads, are in
[NOTICE.md](NOTICE.md).
