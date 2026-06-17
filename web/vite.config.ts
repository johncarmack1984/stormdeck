import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** The deployed version: the nearest `vX.Y.Z` release tag, plus `-N-g<sha>`
 * when the build is N commits past it (so the live label is commit-exact
 * between releases) and `-dirty` for an uncommitted local build. Falls back
 * to the short SHA before the first tag, or VITE_APP_VERSION / 'dev' when git
 * is unavailable. CI must fetch tags (deploy-web uses fetch-depth: 0). */
function appVersion(): string {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION;
  try {
    return execSync('git describe --tags --always --dirty', {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // GitHub Pages serves project sites under /<repo>/; CI sets BASE_PATH.
  base: process.env.BASE_PATH ?? '/',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Baked in at build time; surfaced in the panel + a console banner so you
  // can confirm what's live (see src/version.ts).
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
});
