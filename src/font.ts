// Manejo de fuentes: derivación de peso/estilo, @font-face para el render
// nativo, normalización de nombres estilo Illustrator y forzado de familia.

export interface FontFace {
  bytes: Uint8Array
  family: string
  weight: number
  style: 'normal' | 'italic'
  formato: string
}

// --- utilidades base ---

export function bytesABase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function detectarFormatoCss(bytes: Uint8Array): string {
  const [a, b, c, d] = bytes
  if (a === 0x77 && b === 0x4f && c === 0x46 && d === 0x32) return 'woff2'
  if (a === 0x77 && b === 0x4f && c === 0x46 && d === 0x46) return 'woff'
  if (a === 0x4f && b === 0x54 && c === 0x54 && d === 0x4f) return 'opentype'
  return 'truetype'
}

// Mapa de sufijos de peso (en minúscula) -> font-weight numérico.
const PESOS: Record<string, number> = {
  thin: 100, hairline: 100,
  extralight: 200, ultralight: 200,
  light: 300,
  regular: 400, normal: 400, book: 400,
  medium: 500,
  semibold: 600, demibold: 600,
  bold: 700,
  extrabold: 800, ultrabold: 800,
  black: 900, heavy: 900,
}

// Interpreta un nombre tipo "Poppins-SemiBold" / "Poppins-BoldItalic" / "Poppins".
// Devuelve la familia base, el peso y el estilo.
export function interpretarNombreFuente(nombre: string): {
  family: string
  weight: number
  style: 'normal' | 'italic'
} {
  const limpio = nombre.trim().replace(/['"]/g, '')
  const guion = limpio.indexOf('-')
  if (guion === -1) return { family: limpio, weight: 400, style: 'normal' }

  const family = limpio.slice(0, guion)
  const desc = limpio.slice(guion + 1)
  // Separar camelCase: "SemiBold" -> "Semi Bold"
  const tokens = desc
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)

  let weight = 400
  let style: 'normal' | 'italic' = 'normal'
  // Reconstruir tokens compuestos como "semibold" si vinieron juntos.
  const unido = tokens.join('')
  for (const [clave, w] of Object.entries(PESOS)) {
    if (tokens.includes(clave) || unido.includes(clave)) weight = w
  }
  if (tokens.includes('italic') || tokens.includes('oblique') || unido.includes('italic')) {
    style = 'italic'
  }
  return { family, weight, style }
}

// Construye un FontFace a partir del nombre de archivo (ej. "Poppins-Bold.ttf").
export function faceDesdeNombre(nombreArchivo: string, bytes: Uint8Array): FontFace {
  const base = nombreArchivo.replace(/\.[^.]+$/, '')
  const info = interpretarNombreFuente(base)
  return { bytes, formato: detectarFormatoCss(bytes), ...info }
}

// Genera un bloque <style> con un @font-face por cada cara. Para el render NATIVO.
export function construirEstiloFontFaces(faces: FontFace[]): string {
  const reglas = faces
    .map(
      (f) => `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:${f.style};` +
        `src:url(data:font/${f.formato};base64,${bytesABase64(f.bytes)}) format('${f.formato}');}`,
    )
    .join('\n')
  return `<style>\n${reglas}\n</style>`
}

// Inyecta los @font-face en el SVG (solo para el camino nativo).
export function embeberFacesEnSvg(svg: string, faces: FontFace[]): string {
  if (!faces.length) return svg
  return svg.replace(/(<svg\b[^>]*>)/, `$1${construirEstiloFontFaces(faces)}`)
}

// Normaliza nombres de fuente estilo Illustrator a familia + font-weight/style.
// Ej.: "font-family: Poppins-Bold, Poppins" -> "font-family:'Poppins';font-weight:700"
// Opera por string (rápido) y cubre tanto CSS (font-family:) como atributos.
export function normalizarFuentesIllustrator(svg: string): string {
  // Forma CSS / style inline:  font-family: X, Y
  let out = svg.replace(/font-family\s*:\s*([^;}"']+)/gi, (_m, valor: string) => {
    const primero = valor.split(',')[0].trim()
    const info = interpretarNombreFuente(primero)
    const italic = info.style === 'italic' ? ';font-style:italic' : ''
    return `font-family:'${info.family}';font-weight:${info.weight}${italic}`
  })

  // Forma atributo de presentación:  font-family="X"
  out = out.replace(/font-family\s*=\s*"([^"]+)"/gi, (_m, valor: string) => {
    const primero = valor.split(',')[0].trim()
    const info = interpretarNombreFuente(primero)
    const italic = info.style === 'italic' ? ` font-style="italic"` : ''
    return `font-family="${info.family}" font-weight="${info.weight}"${italic}`
  })

  return out
}

// Fuerza una familia en TODO el texto del SVG (herramienta de experimentación,
// p. ej. para probar otra fuente del sistema en toda la placa).
export function forzarFamiliaEnSvg(svg: string, familia: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const err = doc.querySelector('parsererror')
  if (err) throw new Error('El SVG no se pudo parsear: ' + err.textContent)

  const style = doc.createElementNS('http://www.w3.org/2000/svg', 'style')
  style.textContent = `text, tspan { font-family: '${familia}' !important; }`
  doc.documentElement.insertBefore(style, doc.documentElement.firstChild)

  for (const el of Array.from(doc.querySelectorAll('text, tspan'))) {
    el.setAttribute('font-family', familia)
    const inline = el.getAttribute('style')
    if (inline && /font-family/i.test(inline)) {
      const limpio = inline.split(';').filter((d) => !/^\s*font-family\s*:/i.test(d)).join(';')
      if (limpio.trim()) el.setAttribute('style', limpio)
      else el.removeAttribute('style')
    }
  }
  return new XMLSerializer().serializeToString(doc)
}
