import { defineConfig } from 'vitest/config'

export default defineConfig({
  /*
   * Relative, so the same build works from a project page at /still/ and from
   * a local `vite preview` at the root. The app routes on the hash, so nothing
   * here depends on knowing the deployed path.
   */
  base: './',
  build: {
    rollupOptions: {
      // shader.html is a second entry point: a development tool that ships, but
      // that the app never links to. Phase 8 adds the deploy allowlist that
      // keeps anything else from reaching a public URL by accident.
      input: {
        main: 'index.html',
        shader: 'shader.html',
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
