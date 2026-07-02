// CAMINO B — resvg-wasm.
//
// Renderizador de SVG escrito en Rust, compilado a WASM. Es DETERMINÍSTICO:
// da el mismo resultado en cualquier navegador y en el celular, y por dentro
// es muy parecido a librsvg (lo que Imagick usa para SVG). Le pasamos los
// bytes de la fuente de forma explícita; no depende del sistema.

import { initWasm, Resvg } from '@resvg/resvg-wasm'
// Vite resuelve esto a la URL del .wasm empaquetado.
import wasmUrl from '@resvg/resvg-wasm/index_bg.wasm?url'

let listo: Promise<void> | null = null

// Inicializa el WASM una sola vez. Si la carga FALLA (corte de red bajando el
// .wasm), se descarta la promesa cacheada para que el próximo export reintente
// en vez de fallar para siempre hasta recargar la página.
function asegurarResvg(): Promise<void> {
  if (!listo) {
    listo = initWasm(fetch(wasmUrl)).catch((e) => { listo = null; throw e })
  }
  return listo
}

export async function renderResvg(
  svg: string,
  fuentes: Uint8Array[],
  ancho: number,
): Promise<Blob> {
  await asegurarResvg()

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: ancho },
    font: {
      fontBuffers: fuentes,
      // No usamos fuentes del sistema: queremos render reproducible y portable.
      loadSystemFonts: false,
    },
  })

  const imagen = resvg.render()
  const png = imagen.asPng()
  // Cast: resvg devuelve Uint8Array<ArrayBufferLike>; Blob espera BlobPart.
  return new Blob([png as BlobPart], { type: 'image/png' })
}
