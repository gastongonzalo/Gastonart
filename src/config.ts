// ============================================================
//  CONFIGURACIÓN — FASE 0
// ============================================================

export const CONFIG = {
  // Ancho de exportación en píxeles.
  //   > 0  → fuerza ese ancho (alto se calcula por aspect ratio).
  //   = 0  → usa el ancho intrínseco del SVG (pixel-exacto al diseño).
  // Poné el mismo valor que usa tu Imagick para comparar pixel a pixel.
  anchoExport: 1080,
} as const
