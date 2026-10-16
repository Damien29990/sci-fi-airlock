import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the built site works from any folder or sub-path.
  base: './',
  build: {
    chunkSizeWarningLimit: 1000,
  },
});
