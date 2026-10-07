# Licensing notes

IPTV Hub is released under the [MIT License](LICENSE).

## Why MIT

The licence was a free choice, because nothing in the project constrains it:

- **No runtime dependencies.** `package.json` has no `dependencies` or
  `devDependencies` block. The code uses Node.js built-ins only (`node:sqlite`,
  `node:http`, `node:test`, `fetch`). Node.js itself is MIT-licensed, and the SQLite it
  bundles is in the public domain.
- **No derived or vendored code.** Every file in the repository was written for this
  project.
- **No bundled assets.** No fonts, icons, images or datasets ship in the repository.

If a dependency is ever added, check its licence before merging. A GPL or AGPL dependency
would force the whole project onto that licence.

## Third-party resources loaded at runtime

These are not part of the repository and are not redistributed by it, but the web
interface loads them from a third party when a browser opens it.

| Resource | Loaded from | Licence | Copyright |
|---|---|---|---|
| Readex Pro font | Google Fonts (`fonts.googleapis.com`) | SIL Open Font License 1.1 | Copyright 2019 The Readex Pro Project Authors |
| hls.js 1.7.3 (live channels on the watch page, only in browsers without native HLS) | jsDelivr (`cdn.jsdelivr.net`), pinned with a Subresource Integrity hash | Apache License 2.0 | Copyright (c) 2017 Dailymotion |

If you self-host the font instead of loading it from Google Fonts, the OFL requires its
licence text to travel with the font files.

## Content

IPTV Hub contains no channels, streams, playlists or provider accounts. It merges
listings from Xtream Codes accounts that its operator supplies. Whether you may use a
given provider's content is between you and that provider.

The test fixtures use film, series and channel names (*The Matrix*, *Breaking Bad*,
*MBC 1* and others) as sample strings for the name-cleaning tests. No content from any of
them is included.
