import { defineConfig, loadEnv } from 'vite'
import { createHash } from 'node:crypto'
import { validateApiOrigin } from './src/lib/native-boundary.mjs'
import vue from '@vitejs/plugin-vue'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import { resolve } from 'path'

export default defineConfig(({ mode }) => {
  const native = mode === 'native'
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const origin = native ? validateApiOrigin(env.VITE_NATIVE_API_ORIGIN) : null
  return {
  plugins: [
    ...(native ? [{
      name: 'native-shell',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replace('/src/main.js', '/src/native-main.js'),
      },
    }, {
      name: 'native-content-security-policy',
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          const hashes = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
            .filter((match) => match[1].trim())
            .map((match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`)
          const policy = `default-src 'self'; script-src 'self' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' ${origin} ${origin.replace('https:', 'wss:')}; object-src 'none'; base-uri 'self'; form-action 'self'`
          return { html, tags: [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }] }
        },
      },
    }] : []),
    // Every component is <script setup>, so the Options API runtime is
    // dead weight in vendor-vue. A component that uses data()/methods
    // would silently do nothing with this off.
    vue({ features: { optionsAPI: false } }),
    // Pre-compile the src/locales/*.json messages to an AST at build time.
    // The default vue-i18n build compiles them in the browser with
    // `new Function`, which our `script-src 'self'` CSP blocks (blank page
    // in production). Since the runtime never compiles a message, the
    // compiler itself goes too (dropMessageCompiler). The catch: any
    // message that doesn't come through this plugin, like t(key, 'default
    // text'), useI18n({ messages }) or a mergeLocaleMessage with plain
    // strings, has nothing to compile it and breaks at render.
    VueI18nPlugin({
      include: resolve(__dirname, 'src/locales/**'),
      runtimeOnly: true,
      compositionOnly: true,
      dropMessageCompiler: true,
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
    outDir: native ? 'dist-native' : 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-vue': ['vue', 'vue-router', 'pinia'],
          'vendor-i18n': ['vue-i18n'],
          'vendor-socket': ['socket.io-client'],
          // The English messages are the fallback every locale leans on, so
          // they're loaded up front, but as their own chunk (preloaded in
          // parallel, cached apart from the app code). Kept in the entry
          // they were most of it, and every release that added UI text
          // looked like a code-weight regression to check:size.
          'locale-en': [resolve(__dirname, 'src/locales/en.json')],
        },
      },
    },
  },
  }
})
