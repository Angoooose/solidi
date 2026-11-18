// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';
import { cn } from 'cn/vite';

// https://astro.build/config
export default defineConfig({
  output: "server",
  integrations: [react()],
  adapter: cloudflare(),

  vite: {
    plugins: [
      tailwindcss(),
      // Compiles class-merge tables fitted to our sources and @theme (src/lib/cn-tables.mjs),
      // so the browser gets ~8 KB of merge rules instead of cn's full set.
      cn({ content: ['src/**/*.{ts,tsx,astro}'], css: 'src/styles/global.css', out: 'src/lib/cn-tables.mjs' }),
    ]
  }
});