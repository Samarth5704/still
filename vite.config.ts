import { defineConfig } from 'vitest/config'

export default defineConfig({
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
