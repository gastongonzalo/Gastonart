# GastonART

Generador de imágenes con **render en el navegador** (independiente del generador PHP/Imagick actual, que queda intacto como respaldo).

Idioma del proyecto: **español (Argentina)**.

## Estado: Fase 0 — Validación de render

Objetivo de esta fase: comprobar que una plantilla SVG se puede exportar a PNG
**en el navegador** con una fidelidad equivalente a la que produce Imagick en el
servidor — sobre todo en **fuentes** y **SVGs complejos de Illustrator**.

Se comparan **dos** renderizadores lado a lado contra una referencia de Imagick:

| | Camino | Qué es |
|---|---|---|
| **A** | Render nativo | SVG → `<canvas>` → PNG, usando el motor del navegador |
| **B** | `resvg-wasm` | Renderizador Rust→WASM, determinístico y portable (cercano a librsvg) |

## Cómo correrlo

```bash
npm install
npm run dev
```

Se abre solo en el navegador. Sin tus archivos, usa un SVG de muestra.

## Probar con TUS archivos

Copiá a `src/assets/` (ver `src/assets/LEEME.md`):

- tu plantilla `*.svg`
- tu fuente `*.ttf` / `*.otf` / `*.woff2`
- tu `reference.png` exportado de Imagick (mismo tamaño que `anchoExport`)

y ajustá `src/config.ts` (`familiaFuente`, `anchoExport`, ids de placeholders).

## Estructura

```
index.html
src/
  main.ts            orquesta la prueba y la UI de comparación
  render-native.ts   Camino A
  render-resvg.ts    Camino B
  font.ts            embebido de fuentes (base64 / buffers)
  placeholders.ts    inyección de texto en el SVG
  config.ts          parámetros de la prueba
  sample-svg.ts      SVG de muestra integrado
  assets/            ← tus archivos de prueba
```

## Fases siguientes (no construidas todavía)

1. MVP: importar plantilla, detectar placeholders, editar sobre la placa, exportar.
2. Controles de texto en el lugar (tamaño, fuente, color, alineación, interlineado).
3. Manipulación libre (drag & drop, redimensionar, máscaras).
4. Modo diseño tipo Canva (capas, desde cero).
5. PWA (offline + instalable).
