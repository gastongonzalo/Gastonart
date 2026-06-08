// Acceso a las fuentes INSTALADAS en el sistema, vía Local Font Access API.
//
// Disponible en Chrome/Edge de escritorio (Chromium), bajo permiso del usuario.
// Permite "tomar la fuente del sistema" sin copiar archivos: leemos los bytes
// de la fuente instalada y se los pasamos a los dos renderizadores.
//
// La API es experimental, por eso accedemos vía 'any' (no está en lib.dom).

interface FontDataLike {
  family: string
  fullName: string
  postscriptName: string
  style: string
  blob: () => Promise<Blob>
}

export function soportaLocalFonts(): boolean {
  return 'queryLocalFonts' in window
}

// Devuelve todas las caras (faces) de fuente instaladas. Dispara el permiso.
export async function consultarFuentesSistema(): Promise<FontDataLike[]> {
  const q = (window as unknown as { queryLocalFonts: () => Promise<FontDataLike[]> })
    .queryLocalFonts
  return await q()
}

// Familias únicas, ordenadas (es-AR).
export function familiasUnicas(fuentes: FontDataLike[]): string[] {
  const set = new Set(fuentes.map((f) => f.family))
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'))
}

// Lee los bytes de TODAS las caras de una familia (regular, bold, italic…),
// para que resvg pueda elegir el peso/estilo correcto según pida el SVG.
export async function bytesDeFamilia(
  fuentes: FontDataLike[],
  familia: string,
): Promise<Uint8Array[]> {
  const caras = fuentes.filter((f) => f.family === familia)
  const buffers: Uint8Array[] = []
  for (const cara of caras) {
    const blob = await cara.blob()
    buffers.push(new Uint8Array(await blob.arrayBuffer()))
  }
  return buffers
}

export type { FontDataLike }
