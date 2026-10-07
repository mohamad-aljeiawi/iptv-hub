# Contributing to IPTV Hub

IPTV Hub is small on purpose: about 1,000 lines of server code, one HTML file, and no
npm dependencies. Keeping it good mostly means keeping it that small.

## Getting set up

You need Node.js 22.16 or newer. Earlier 22.x releases either lack `node:sqlite` without
a flag or were built without FTS5, and both the app and the tests fail on them.

```bash
git clone https://github.com/mohamad-aljeiawi/iptv-hub.git
cd iptv-hub
npm run dev      # app on http://localhost:8080 plus two mock providers
```

Without a `.env` file, dev mode uses `dev.db` and the admin password `dev`.

There is nothing to install. `npm run dev` prints the URLs of two mock Xtream servers
(username `test`, password `test`); add them from the settings tab to get a working
catalogue without a real provider account.

```bash
npm test
```

The tests create throwaway databases and start local mock servers. They need no network
access and no provider account.

## Before you open a pull request

- `npm test` passes.
- If you touched `scripts/install.sh` or `scripts/iptvhub`, run
  `shellcheck --severity=warning install.sh deploy.sh scripts/install.sh scripts/iptvhub`. CI runs
  the same command.
- If you changed behaviour a player or an operator can see, add a line under
  `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

## What is most useful

The [known limitations](README.md#known-limitations) table in the README is the roadmap.
The entries with the most leverage:

- **Enforcing a local user's device count.** It is stored and reported to players but
  never checked. Doing this without proxying video means counting redirects per user
  within a time window, which is approximate; a good design here matters more than code.
- **EPG for channels that only one provider carries.** Today the guide comes from the
  provider with the most channels.
- **A less eager "did you mean".** On a large catalogue the fuzzy fallback can "correct"
  a query into an unrelated word. Tests in `test/search.test.js` with real-world names
  that currently misbehave are welcome even without a fix.

New provider naming quirks are always useful too. If a provider writes names in a way
that defeats de-duplication, add the raw names to `test/normalize.test.js` and fix
`src/normalize.js`.

## Things that will be declined

- **Restreaming, transcoding or proxying video.** The 302 redirect is the design: it is
  why the server needs almost no bandwidth and runs next to other services. A pull
  request that routes video through the server changes what the project is.
- **npm dependencies.** Node's built-ins cover HTTP, SQLite, tests and `fetch`. A
  dependency has to replace something genuinely hard to write, and so far nothing has.
- **A build step for the web interface.** `public/index.html` is served as it is.
- **Reseller panel features** such as credits, sub-resellers or billing.
- **Bundled playlists, provider lists or sample content** of any kind.
- **Forcing player paths to HTTPS.** ExoPlayer-based players refuse a redirect from an
  `https` playlist to an `http` stream. The README explains this; the nginx and Caddy
  templates keep those paths on plain HTTP on purpose.

## Ground rules

- **English only**, except the user-facing Arabic copy in `public/index.html`, the HTTP
  error strings that interface renders (in `src/api.js`), and the `UNCAT_NAME` category
  label. Comments, identifiers, logs, CLI output, commit messages and docs are English.
  A new user-facing message goes next to the existing ones, with an English comment
  saying what it is.
- **Module dependencies flow one way**, with no cycles:
  `config -> db -> normalize/http -> sync -> resolve -> xtream/watch -> api -> index`.
  `http.js` must not import a feature module; use the `onClear()` hook instead.
- **Migrations are append-only.** Add a new function at the end of `MIGRATIONS` in
  `src/db.js`. Never edit one that has shipped, because existing databases have already
  run it.
- **Never commit a database, a backup or `.env`.** A `catalog.db` holds the upstream
  provider usernames and passwords in plain text. `.gitignore` covers these; do not work
  around it.
- **Test data stays invented or generic.** Use made-up accounts and the mock server in
  `test/mock-xtream.js`. Never paste a real provider URL, account or exported playlist
  into a test, an issue or a pull request.

## Licence

By contributing you agree that your work is licensed under the [MIT License](LICENSE).
