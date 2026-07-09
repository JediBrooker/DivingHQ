import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    vue(),
    // Pre-compile vue-i18n message JSON into render functions at
    // build time. Without this plugin, vue-i18n falls back to
    // `new Function(...)` to compile messages at runtime, which
    // violates our `script-src 'self'` CSP and leaves the SPA as
    // a blank page in production. This transforms every
    // src/locales/*.json import into a pre-baked module so no eval
    // ever runs in the browser.
    VueI18nPlugin({
      include: resolve(__dirname, 'src/locales/**'),
      // Force the runtime-only vue-i18n build via the plugin's
      // alias and pre-compile every src/locales/*.json into a
      // ready-to-execute message function. Needed for our
      // strict CSP, since the default build inlines a JIT compiler
      // that uses `new Function`, which is blocked.
      runtimeOnly: true,
      compositionOnly: true,
      strictMessage: false,
      escapeHtml: false,
    }),
  ],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-vue': ['vue', 'vue-router', 'pinia'],
          'vendor-i18n': ['vue-i18n'],
          'vendor-socket': ['socket.io-client'],
        },
      },
    },
  },
})
