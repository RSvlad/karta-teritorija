import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

// base './' keeps asset URLs valid under a custom domain and under /<repo>/.
export default defineConfig({
  base: './',
  plugins: [
    preact(),
    VitePWA({
      // The new service worker takes over on the next load; no update prompt is needed in the UI.
      registerType: 'autoUpdate',
      manifest: {
        id: './',
        name: 'Територије',
        short_name: 'Територије',
        lang: 'sr',
        start_url: './',
        scope: './',
        display: 'standalone',
        theme_color: '#1f5fbf',
        background_color: '#fafafa',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell only (incl. the lazy MapLibre chunk). The city data below is cached at runtime instead,
        // because public/data/ is generated per deploy and only cities the user opened should be stored.
        globPatterns: ['**/*.{js,mjs,css,html,png,webmanifest}'],
        globIgnores: ['data/**'],
        runtimeCaching: [
          {
            // data/<city>.json, data/cities.json, data/<city>.territories.geojson:
            // online -> always the fresh file (stored for later); offline or slow -> the stored copy.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && /\/data\/[^/]+\.(json|geojson)$/.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'moj-paroh-data',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 40 },
            },
          },
          {
            // Map style and tiles already viewed stay available offline.
            urlPattern: ({ url }) => url.origin === 'https://tiles.openfreemap.org',
            handler: 'CacheFirst',
            options: {
              cacheName: 'moj-paroh-map',
              expiration: { maxEntries: 300, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  test: { include: ['src/**/*.test.ts'] },
});
