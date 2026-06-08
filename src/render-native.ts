// CAMINO A — Render nativo del navegador.
//
// Serializa el SVG → Blob → <img> → <canvas> → PNG.
// Usa el motor de render SVG del propio navegador. Rápido y sin dependencias,
// pero el resultado puede variar levemente entre navegadores (hinting/antialias)
// y depende de que las fuentes estén embebidas en el SVG (ver font.ts).

function cargarImagen(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('No se pudo cargar el SVG como imagen.'))
    img.src = url
  })
}

export async function renderNativo(
  svg: string,
  ancho: number,
  alto: number,
): Promise<Blob> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const img = await cargarImagen(url)
    const canvas = document.createElement('canvas')
    canvas.width = ancho
    canvas.height = alto
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('No se pudo obtener el contexto 2D del canvas.')
    ctx.drawImage(img, 0, 0, ancho, alto)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob devolvió null.'))),
        'image/png',
      )
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}
