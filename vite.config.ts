import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// The site is served from https://elgeffe.github.io/erfgooiers/. CI sets
// BASE_PATH; locally it falls back to the same production base.
const base = process.env.BASE_PATH || '/erfgooiers/';

export default defineConfig({
  base,
  plugins: [tailwindcss()],
});
