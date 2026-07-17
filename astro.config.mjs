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
      filter: (page) => !page.includes('/404'),
      changefreq: 'weekly',
      priority: 0.7,
      // Static pages served from public/ are outside Astro's route set, so the
      // sitemap integration can't see them — list them here or they never get crawled.
      customPages: ['https://lakelevelnow.com/lake/lake-powell/depth/'],
    }),
    mdx(),
  ],
});
