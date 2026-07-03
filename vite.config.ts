import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// 'assetsInlineLimit: 0' evita que Vite convierta el .wasm o las fuentes
// en data-URLs, para que se sirvan como archivos reales (más fiel y depurable).
export default defineConfig({
  base: './',
  build: {
    assetsInlineLimit: 0,
  },
  server: {
    open: true,
  },
  plugins: [
    // PWA instalable (PC y celular) con funcionamiento offline.
    // El paquete NO incluye plantillas: se cargan después de instalar y
    // persisten en IndexedDB del navegador.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script', // registra el service worker sin tocar main.ts
      includeAssets: ['icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'GastonART',
        short_name: 'GastonART',
        description: 'Editor de placas e imágenes para redes, con render en el navegador.',
        lang: 'es-AR',
        display: 'standalone',
        start_url: './',
        scope: './',
        theme_color: '#0d99ff',
        background_color: '#f4f6f8',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precachear TODO el build (incluye wasm de resvg y las fuentes
        // empaquetadas) para que el editor y el export funcionen offline.
        // OJO: incluye 'mjs' — el worker de pdf.js se emite como .mjs; sin él en
        // el precache, importar un PDF con la app offline fallaba.
        globPatterns: ['**/*.{js,mjs,css,html,wasm,ttf,otf,woff,woff2,png,svg,webmanifest}'],
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
        // Los servicios online (Iconify, Openverse, Google Fonts, quitar fondo)
        // requieren red igual; no se cachean.
      },
    }),
  ],
})
