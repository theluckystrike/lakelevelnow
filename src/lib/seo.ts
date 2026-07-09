// SEO + GEO helpers: canonical URLs, OpenGraph, JSON-LD structured data.
// Enriched per the GEO sprint: Organization.knowsAbout, source isBasedOn chain,
// and speakable targeting for Quotable Authority Sentences (class="qas").
import { SITE, AUTHOR } from '../consts';

export function absUrl(path = '/'): string {
  let p = path.startsWith('/') ? path : `/${path}`;
  if (p !== '/' && !/[#?]/.test(p) && !/\.[a-z0-9]+$/i.test(p) && !p.endsWith('/')) {
    p = `${p}/`;
  }
  return new URL(p, SITE.url).href;
}

export interface SeoInput {
  title: string;
  description: string;
  path?: string;
  ogImage?: string;
  noindex?: boolean;
}

export function buildMeta({ title, description, path = '/', ogImage, noindex }: SeoInput) {
  const canonical = absUrl(path);
  const image = ogImage ? absUrl(ogImage) : absUrl(SITE.defaultOgImage);
  const fullTitle = title.includes(SITE.name) ? title : `${title} | ${SITE.name}`;
  return { fullTitle, description, canonical, image, noindex };
}

// The verifiable source chain. isBasedOn tells AI engines our readings trace to a
// primary public feed — the GEO differentiator vs unverified competitor claims.
const SOURCE_USGS = { '@type': 'CreativeWork', name: 'USGS Water Services', url: 'https://waterservices.usgs.gov/' };
const SOURCE_CDEC = { '@type': 'CreativeWork', name: 'California Data Exchange (CDEC)', url: 'https://cdec.water.ca.gov/' };
const SOURCE_USBR = { '@type': 'CreativeWork', name: 'U.S. Bureau of Reclamation Lower Colorado River Operations', url: 'https://www.usbr.gov/lc/region/g4000/riverops/webreports/hourlyweb.json' };
export function sourceFor(feed?: string | null) {
  const f = (feed || '').toLowerCase();
  if (f === 'cdec') return SOURCE_CDEC;
  if (f === 'usbr') return SOURCE_USBR;
  if (f === 'usgs') return SOURCE_USGS;
  return null;
}

// JSON-LD: Organization — knowsAbout declares topical authority to AI engines.
export function organizationLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE.name,
    url: SITE.url,
    logo: absUrl('/favicon.svg'),
    description: SITE.description,
    knowsAbout: [
      'lake water levels',
      'reservoir percent full',
      'USGS water data',
      'CDEC reservoir storage',
      'boat ramp and launch conditions',
      'drought reservoir levels',
    ],
  };
}

export function websiteLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE.name,
    url: SITE.url,
  };
}

// JSON-LD: the named Person behind the site's readings (H3 authorship signal). Identity
// matches the /about page — surfaced as a visible byline on data pages too.
export function authorLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: AUTHOR.name,
    jobTitle: AUTHOR.role,
    url: absUrl(AUTHOR.url),
    description: `${AUTHOR.name}, ${AUTHOR.blurb}. Pulls every LakeLevelNow reading from the same USGS, CDEC, and USBR feeds the operators report to.`,
    knowsAbout: [
      'lake water levels',
      'USGS water data',
      'CDEC reservoir storage',
      'reservoir operations',
    ],
    sameAs: AUTHOR.sameAs,
  };
}

export function faqLd(pairs: { q: string; a: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: pairs.map((p) => ({
      '@type': 'Question',
      name: p.q,
      acceptedAnswer: { '@type': 'Answer', text: p.a },
    })),
  };
}

export function breadcrumbLd(items: { name: string; path: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: absUrl(it.path),
    })),
  };
}

// Speakable: marks the quotable authority sentence (class="qas") + h1 as the part
// of the page voice assistants / AI engines should extract.
export function speakableLd(path: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    url: absUrl(path),
    speakable: { '@type': 'SpeakableSpecification', cssSelector: ['h1', '.qas'] },
  };
}

// JSON-LD: a lake as LakeBodyOfWater, with the live reading as an Observation and
// the source chain via isBasedOn.
export function lakeLd(opts: {
  name: string;
  path: string;
  state: string;
  river?: string;
  levelFt?: number | null;
  pctFull?: number | null;
  asOf?: string;
  feed?: string | null;
}) {
  const body: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'LakeBodyOfWater',
    name: opts.name,
    url: absUrl(opts.path),
    containedInPlace: { '@type': 'AdministrativeArea', name: opts.state },
  };
  if (opts.river) body.description = `Water level for ${opts.name}, on the ${opts.river}, ${opts.state}.`;
  const src = sourceFor(opts.feed);
  if (src) body.isBasedOn = [src];
  if (opts.levelFt != null) {
    body.subjectOf = {
      '@type': 'Observation',
      observedNode: { '@type': 'LakeBodyOfWater', name: opts.name },
      measurementMethod: opts.feed ? `${opts.feed} public water-data feed` : 'public water-data feed',
      observationDate: opts.asOf,
      variableMeasured: {
        '@type': 'PropertyValue',
        name: opts.pctFull != null ? 'Percent full' : 'Water level (ft)',
        value: opts.pctFull != null ? opts.pctFull : opts.levelFt,
        unitText: opts.pctFull != null ? 'percent' : 'feet above mean sea level',
      },
    };
  }
  return body;
}
