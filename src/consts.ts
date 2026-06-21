// Site-wide constants for lakelevelnow.com — live US lake & reservoir water levels.
// Single source of truth for branding, navigation, and monetization wiring.
// Lake registry + live readings live in src/data/ (lakes.json, levels.json).

export const SITE = {
  name: 'LakeLevelNow',
  domain: 'lakelevelnow.com',
  url: 'https://lakelevelnow.com',
  tagline:
    'Live US lake and reservoir water levels — current level, percent full, and trend for lakes across the country, updated from USGS and state feeds.',
  description:
    'See the current water level and percent full for US lakes and reservoirs — Lake Travis, Shasta, Oroville, Lanier, Mead and more — with a live level gauge, 30-day trend, and a plain-English read on whether you can launch a boat. Data from USGS and CDEC, updated regularly.',
  defaultOgImage: '/og-default.png',
  // Optional Google Search Console HTML-tag verification token (paste after 'content=').
  gscVerification: '',
  locale: 'en_US',
  contactEmail: 'hello@lakelevelnow.com',
} as const;

// Recreation-affiliate monetization (the make-it-right plan: recreation affiliate,
// NOT display ads). Sign up for each, paste the tracked link, add /disclosure, redeploy.
// Leaving REPLACE_ME blocks ship — the build's QA gate flags them so they are never silent.
export const AFFILIATES = {
  // FishingBooker: 20–50% of a charter booking. Apply: partners.fishingbooker.com
  fishingbooker: 'REPLACE_ME',
  // Captain Experiences: pays per guided trip. Apply: captainexperiences.com/affiliates
  captainExperiences: 'REPLACE_ME',
  // Boatsetter: ~$16–20 per rental lead. Apply: boatsetter.com/partners
  boatsetter: 'REPLACE_ME',
} as const;

export const AFFILIATE_REPLACE_ME = Object.values(AFFILIATES).some((v) => v === 'REPLACE_ME');

// States covered (the lake registry spans these). Used for the directory + IA.
export const STATES: { code: string; name: string }[] = [
  { code: 'CA', name: 'California' },
  { code: 'TX', name: 'Texas' },
  { code: 'NV', name: 'Nevada' },
  { code: 'UT', name: 'Utah' },
  { code: 'GA', name: 'Georgia' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'MO', name: 'Missouri' },
  { code: 'VA', name: 'Virginia' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'AL', name: 'Alabama' },
];

export const STATE_BY_CODE: Record<string, { code: string; name: string }> = Object.fromEntries(
  STATES.map((s) => [s.code, s])
);

// Freshness window (days). Readings older than this are flagged "may be delayed",
// never silently passed off as current. Must match scripts/fetch-levels.mjs FRESH_DAYS.
export const FRESH_DAYS = 7;
