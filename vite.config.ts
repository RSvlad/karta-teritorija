import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// base './' keeps asset URLs valid under a custom domain and under /<repo>/.
export default defineConfig({
  base: './',
  plugins: [preact()],
  test: { include: ['src/**/*.test.ts'] },
});
