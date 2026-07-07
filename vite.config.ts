import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// BASE_PATH is injected by CI so each branch can deploy under its own subfolder:
//   main            -> /erfgooiers/
//   feature branch  -> /erfgooiers/branch/<branch-name>/
// Locally it falls back to the production base.
const base = process.env.BASE_PATH || '/erfgooiers/';

export default defineConfig({
  base,
  plugins: [tailwindcss()],
});
