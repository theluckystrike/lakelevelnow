import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';

// lakelevelnow.com — static, SEO-first, live-data-first site on Cloudflare Workers.
// Static output (default) = fastest LCP, best Core Web Vitals, most crawlable.
// The weekly pipeline (scripts/fetch-levels.mjs) regenerates live USGS/CDEC readings
// into src/data/, the build renders them, and a GitHub Action deploys + pings IndexNow.
export default defineConfig({
  site: 'https://lakelevelnow.com',
  trailingSlash: 'ignore',
  build: {
    format: 'directory', // /lake/foo/ -> /lake/foo/index.html (clean URLs)
  },
  prefetch: {
    prefetchAll: true, // prefetch visible links -> faster nav, better CWV
    defaultStrategy: 'viewport',
  },
  integrations: [
    sitemap({
      // /almanac/thanks/ is a post-purchase page whose URL carries a live Stripe session
      // id. It must never be indexed; it also carries noindex, and this is the second lock.
      filter: (page) => !page.includes('/404') && !page.includes('/almanac/thanks'),
      changefreq: 'weekly',
      priority: 0.7,
    }),
    mdx(),
  ],
});
