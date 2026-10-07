# Security policy

IPTV Hub stores upstream provider credentials and faces the internet, so security
reports are taken seriously.

## Supported versions

Only the latest release gets fixes. `iptvhub update` moves an installed server to it.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead:
[report a vulnerability](https://github.com/mohamad-aljeiawi/iptv-hub/security/advisories/new).

Include what an attacker can do, the steps to reproduce it, and the version or commit
you tested. Do not include real provider URLs or account details; the mock server in
`test/mock-xtream.js` is enough to demonstrate almost anything.

## Not vulnerabilities

These are documented consequences of the design. Reports about them will be closed,
though ideas for improving them are welcome as normal issues:

- The 302 redirect exposes the upstream username and password to whoever can see the
  player's traffic. Every Xtream stream URL carries credentials; hiding them would mean
  proxying video, which the project deliberately does not do.
- Player passwords appear in playlist and stream URLs, as the Xtream protocol requires,
  and are stored in plain text so they can be shown to the admin.
- Player paths (`/player_api.php`, `/get.php`, `/xmltv.php`, `/live/`, `/movie/`,
  `/series/`) and the in-browser watch page (`/watch/`, `/w/`) are served over plain
  HTTP on purpose, so ExoPlayer-based players keep working and browsers can follow
  the redirect to the provider. The README explains why. The watch page never sees a
  password or session cookie; it uses a signed token for one item that expires after
  12 hours.
