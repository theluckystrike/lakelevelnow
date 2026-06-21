// SEO helpers: absolute canonical URLs, OpenGraph, and JSON-LD structured data.
import { SITE } from '../consts';

export function absUrl(path = '/'): string {
  let p = path.startsWith('/') ? path : `/${path}`;
  // Match the directory-format build + sitemap (trailing slash on page URLs).
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

// JSON-LD: Organization (sitewide identity).
export function organizationLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE.name,
    url: SITE.url,
    logo: absUrl('/favicon.svg'),
    description: SITE.description,
  };
}

// JSON-LD: WebSite (sitelinks search-box eligibility).
export function websiteLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE.name,
    url: SITE.url,
  };
}

// JSON-LD: FAQPage from Q&A pairs — eligible for rich results.
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

// JSON-LD: BreadcrumbList for programmatic pages.
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

// JSON-LD: a lake/reservoir as a LakeBodyOfWater, with the live observation as a
// quantitative value. Helps search engines surface the current level.
export function lakeLd(opts: {
  name: string;
  path: string;
  state: string;
  river?: string;
  levelFt?: number | null;
  pctFull?: number | null;
  asOf?: string;
}) {
  const body: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'LakeBodyOfWater',
    name: opts.name,
    url: absUrl(opts.path),
    containedInPlace: { '@type': 'AdministrativeArea', name: opts.state },
  };
  if (opts.river) body.description = `Water level for ${opts.name}, on the ${opts.river}, ${opts.state}.`;
  if (opts.levelFt != null) {
    body.subjectOf = {
      '@type': 'Observation',
      observedNode: { '@type': 'LakeBodyOfWater', name: opts.name },
      measurementMethod: 'USGS / CDEC public water-data feed',
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
