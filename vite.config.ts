import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// Project site served at https://elgeffe.github.io/erfgooiers/
export default defineConfig({
  base: '/erfgooiers/',
  plugins: [tailwindcss()],
});
