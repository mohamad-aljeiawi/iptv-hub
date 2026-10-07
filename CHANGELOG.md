# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.1] - 2026-10-07

### Fixed

- In-browser playback stopped after a few seconds with "this source could not be
  played" on some providers. Four causes, all fixed:
  - Providers drop long connections at random (measured: after 9 to 51 MB). The relay
    now reconnects from the next byte at once and keeps feeding the same stream, so
    neither ffmpeg nor the browser sees the drop. Still one connection at a time.
  - The relay's 15-second timeout also applied to quiet connections, so a paused
    direct-play video was cut by the server itself. It now covers connecting only.
  - Chrome now claims native HLS, so the player used Chrome's own HLS engine instead
    of hls.js. hls.js is now preferred wherever Media Source Extensions exist, with a
    35-second first-playlist timeout and recovery from media and network errors.
  - ffmpeg's `-readrate` stalled the HLS output while subtitles were extracted from
    the same file. Films are now paced by the relay instead: a 20-second head start,
    then twice the film's average bitrate.

## [2.4.0] - 2026-10-07

### Added

- A full-screen, Netflix-style player: back button and title on top, a control bar
  with 10-second jumps, an in-player episodes drawer (seasons, thumbnails, lengths,
  watched progress), an audio, subtitles, speed and source menu, keyboard shortcuts,
  and controls that fade while playing.
- Next episode: in the last 30 seconds a 5-second countdown card plays the next
  episode, across seasons, without leaving full screen; a replay screen after the
  finale.
- Resume and "Continue watching", kept only in the browser's `localStorage`
  (`player_history_v1`): exact-second resume, the next episode at 00:00 once an
  episode passes 90%, and removal from the home row.
- Deep links `/watch?id=series_456` and `/watch?id=movie_123`, with optional
  `s`, `e` and `t` that override the saved position, and a "Copy share link" button.
- Audio track choice and text subtitles (SRT, ASS, MP4 text) as WebVTT, written by the
  same ffmpeg process, so still one upstream connection. The chosen audio language
  carries over between episodes.
- A details card per title with Resume / Start from beginning and the episode list.

### Fixed

- Session folders left behind by a crash were never cleaned at startup: the pattern
  that recognises them had lost a backslash.

## [2.3.0] - 2026-10-07

### Changed

- In-browser playback now streams through the server with ffmpeg, by the cheapest path
  that works for each stream: the file as it is (MP4 with H.264 and AAC/MP3), a copy
  into HLS (other containers and live channels), an audio-only conversion to AAC (AC3,
  EAC3, DTS), or a re-encode to H.264 capped at 720p (HEVC and other video browsers
  cannot decode). The plain-HTTP watch page from 2.2.0 is gone; the player works inside
  the HTTPS site again.
- The web player has its own controls: the progress bar spans the whole film, and
  seeking past what has been converted restarts the conversion there.
- The Docker image is based on `node:22-trixie-slim` and includes ffmpeg 7.1. Nothing is
  installed on the host. `compose.yml` runs an init process and allows 3 GB of memory.

### Added

- Exactly one upstream connection per browser stream: browsers and ffmpeg read through
  a per-session relay that closes the old connection before opening a new one, so
  providers that allow one connection per account keep working.
- Limits: 5 browser viewers and 3 re-encodes at once (`PLAY_MAX_VIEWERS`,
  `PLAY_MAX_TRANSCODES`, `PLAY_MAX_HEIGHT`). Over the limit, the player points to the
  external-player buttons, which stay under every title.
- ffmpeg is killed as soon as the viewer stops, closes the player or the tab, or misses
  heartbeats for 30 seconds.
- CI runs the whole test suite inside the Docker image, so the playback tests run with a
  real ffmpeg.

### Removed

- The `/watch/` and `/w/` pages and their plain-HTTP exceptions in the nginx, Caddy,
  Apache and Traefik configs.

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

[Unreleased]: https://github.com/mohamad-aljeiawi/iptv-hub/compare/v2.4.1...HEAD
[2.4.1]: https://github.com/mohamad-aljeiawi/iptv-hub/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/mohamad-aljeiawi/iptv-hub/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/mohamad-aljeiawi/iptv-hub/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/mohamad-aljeiawi/iptv-hub/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/mohamad-aljeiawi/iptv-hub/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/mohamad-aljeiawi/iptv-hub/releases/tag/v2.0.0
