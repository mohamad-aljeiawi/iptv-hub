# Project rules for IPTV Hub

## Language: English only

**Everything in this repository is written in English.** No exceptions for:

- source comments and identifiers
- documentation (`README.md`, `.env.example`, templates, this file)
- git commit messages, branch names, PR descriptions
- log output (`console.log`, `console.error`, journald messages)
- installer and CLI output (`scripts/install.sh`, `scripts/iptvhub`)
- test names and assertion messages

The **only** permitted non-English text is end-user-facing UI copy that is already
localised for the product's audience:

- `public/index.html`, the Arabic web interface
- the HTTP response strings that this interface renders (e.g. login errors in
  `src/api.js`) and the `UNCAT_NAME` category label shown inside players

If you add a new user-facing message, keep it next to the existing ones and write
an English comment explaining what it is. Everything else: English.

## Project conventions

- **No external dependencies.** Node 22.16+ built-ins only (`node:sqlite`,
  `node:test`, `fetch`). Do not add a `dependencies` block to `package.json`.
- **Module dependencies flow one way**, no cycles:
  `config -> db -> normalize/http -> sync -> resolve -> xtream/play -> api -> index`.
  `http.js` must not import a feature module; use the `onClear()` hook instead.
- **Migrations are append-only.** Add a new function at the end of `MIGRATIONS`
  in `src/db.js`; never edit an existing one.
- **Never commit `.env`**, databases, or backups (see `.gitignore`).
- Run `npm test` before committing.
