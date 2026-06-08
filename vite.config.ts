import { defineConfig } from 'vite'

// Configuración mínima para Fase 0.
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
})
