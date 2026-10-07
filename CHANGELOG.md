# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.2.0] - 2026-10-07

### Added

- In-browser playback on HTTPS sites, without relaying video. "Play in the browser"
  opens a plain-HTTP watch page whose video gets the same 302 players get, so the
  stream goes straight from the provider to the browser. The page is reached with a
  signed token for one item (valid 12 hours, revoked with the user) instead of a
  password or cookie. It fails over between sources, and plays live channels with
  hls.js in browsers without native HLS.

### Changed

- nginx, Caddy, Apache and Traefik configs keep `/watch/` and `/w/` on plain HTTP,
  like the player paths. `deploy.sh` and `install.sh` rewrite the site file on their
  next run.

## [2.1.0] - 2026-10-07

### Added

- Docker support: a `Dockerfile` and `compose.yml`. The container listens on
  `127.0.0.1` only and keeps its database in a named volume.
- `deploy.sh`: deploys and updates the Docker setup behind nginx with a Let's Encrypt
  certificate. Asks only for the domain and email, checks DNS first, rolls back a
  rejected nginx config, verifies certificate renewal, backs up before every update and
  daily, and can import an existing database on the first run.

### Security

- The in-app login limit could be bypassed behind nginx by sending a different
  `X-Forwarded-For` value with each attempt, because it trusted the first entry, which
  the client controls. It now uses the address the proxy itself appended, and ignores
  the header on direct connections. nginx's own `limit_req` was not affected.

## [2.0.0] - 2026-10-07

First public release. The earlier, private version was a single `server.js`; this
release splits it into modules and adds an installer.

### Added

- One Xtream Codes API (`player_api.php`, `get.php`, `xmltv.php`) in front of any number
  of upstream providers, with listings merged into a single catalogue.
- De-duplication by TMDB id, then by a cleaned name plus year. Country prefixes, quality
  tags, decorative dividers, Arabic diacritics and letter variants are folded before
  names are compared. Similar categories from different providers merge into one.
- Every stream request is answered with a 302 redirect to an upstream source, so video
  never passes through the server.
- Automatic failover: healthy and fast sources first, a reconnect within 20 seconds
  moves a channel to the next source, and dead providers are excluded until their health
  check passes again.
- Episodes merged across providers, so an episode missing on one is served from another.
- Local player accounts with a device count and an optional expiry date.
- Arabic web interface with instant search (prefix, FTS5 trigram and typo-tolerant),
  an in-browser player with source switching, and links for external players.
- `install.sh`: one-command install on Ubuntu 22.04/24.04 and Debian 12. Pre-flight
  report, automatic free port, localhost binding, nginx or Caddy site with a
  certificate, a hardened systemd service, and daily backups. Safe to run again.
- `iptvhub` management command: `status`, `logs`, `restart`, `update`, `backup`,
  `admin-pass`, `uninstall`.
- In-app login rate limit (5 failed attempts per minute per IP) alongside nginx
  `limit_req`.
- Numbered database migrations, applied at startup.
- `npm run dev` with two mock Xtream providers, and a `node:test` suite covering name
  cleaning, merging, search and redirects.

### Fixed

- The minimum Node.js version is now 22.16. Earlier 22.x releases were advertised but
  could not run the app: before 22.13 `node:sqlite` needs a flag, and before 22.16 the
  bundled SQLite has no FTS5.

[Unreleased]: https://github.com/mohamad-aljeiawi/iptv-hub/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/mohamad-aljeiawi/iptv-hub/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/mohamad-aljeiawi/iptv-hub/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/mohamad-aljeiawi/iptv-hub/releases/tag/v2.0.0
