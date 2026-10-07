// Name cleaning — the core of de-duplication.
// Pure module with no imports: everything here is directly testable
// (see test/normalize.test.js).
//
// The Arabic characters below are data, not prose: they are the letters this
// normaliser folds together.

const QUALITY = String.raw`\b(?:8k|4k|uhd|fhd|hd|sd|hevc|h\.?26[45]|(?:2160|1080|720|480)[pi]?|hdr|60fps|50fps)\b`;
const QUALITY_ONE = new RegExp(QUALITY, 'i');
const QUALITY_ALL = new RegExp(QUALITY, 'gi');

// Country and language codes that most providers glue to the front of a name.
const CODES = 'ar|en|fr|de|tr|us|uk|gb|in|es|it|nl|pt|br|ksa|sa|uae|ae|eg|ma|dz|tn|iq|jo|sy|lb|kw|qa|bh|om|ps|ye|ly|pk|ir|kr|jp|ca|au|mx|ru|pl|se|no|dk|fi|gr|al|ku|kurd|vip|multi|8k|4k|uhd|fhd|hd';
const PREFIX = new RegExp(String.raw`^\s*[\[(|┃▎]?\s*(?:${CODES})\s*(?:[\])|:┃▎]|-)\s*`, 'i');
const TAG = new RegExp(String.raw`[\[(|]\s*(?:${CODES})\s*[\])|]`, 'gi');
const BARE_AR = new RegExp(String.raw`^\s*(?:${CODES})\s+(?=\p{Script=Arabic})`, 'iu');
const DIVIDER = /^[\s#*=\-_~.•●★|┃▎━─═]+$|[#=━─═*]{3,}/;

// Every non-spacing combining mark: Latin diacritics, Arabic harakat, the
// superscript alef. Written as a property escape rather than a code-point range
// because combining marks are invisible in an editor.
const MARKS = /\p{Mn}/gu;
// Tatweel (kashida), the stretching character inserted inside Arabic words.
const TATWEEL = /ـ/g;

// Fold a name to a comparable key: lowercase, no diacritics, unified
// alef/yeh/teh-marbuta, western digits, no punctuation.
export function normText(s) {
  return String(s).toLowerCase().normalize('NFKD')
    .replace(MARKS, '').replace(TATWEEL, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function stripPrefixes(s) {
  s = s.replace(TAG, ' ');
  for (let i = 0; i < 2; i++) s = s.replace(/^[\s\-:_.]+/, '').replace(PREFIX, '').replace(BARE_AR, '');
  return s.replace(/[[\]()|┃▎]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s\-:]+|[\s\-:]+$/g, '').trim();
}

// Split a raw name into: clean title + comparable key + year + quality.
export function parseName(raw, type) {
  if (!raw || DIVIDER.test(raw)) return null;
  let s = String(raw).normalize('NFKC');
  const quality = (s.match(QUALITY_ONE) || [])[0]?.toUpperCase() || null;
  s = s.replace(QUALITY_ALL, ' ').replace(/\s+/g, ' ').trim();
  let year = null;
  if (type !== 'live') {
    const m = s.match(/[([]\s*((?:19|20)\d{2})\s*[)\]]|[\s-]((?:19|20)\d{2})\s*$/);
    if (m) { year = m[1] || m[2]; s = s.replace(m[0], ' '); }
  }
  const title = stripPrefixes(s);
  const norm = normText(title);
  return norm ? { title, norm, year, quality } : null;
}

export function parseCategory(raw) {
  if (!raw) return null;
  const title = stripPrefixes(String(raw).normalize('NFKC').replace(/[#=━─═*]{2,}/g, ' '));
  const norm = normText(title);
  return norm ? { title, norm } : null;
}

// Merge key across servers: TMDB id when available, otherwise clean name + year.
export const nameKeyOf = (type, norm, year) => (type === 'live' ? `live:${norm}` : `${type}:${norm}:${year || ''}`);
export const tmdbKeyOf = (type, tmdb) => (tmdb && type !== 'live' ? `${type}:t${tmdb}` : null);

export const isDivider = raw => !raw || DIVIDER.test(String(raw));
