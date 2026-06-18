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

// Familias cuyo nombre interno (el que necesita resvg) lleva espacios y no
// coincide con el del archivo. Se mapea para que el render coincida.
const FAMILIA_INTERNA: Record<string, string> = {
  BebasNeue: 'Bebas Neue',
  AbrilFatface: 'Abril Fatface',
  ArchivoBlack: 'Archivo Black',
  PlayfairDisplay: 'Playfair Display',
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
  if (guion === -1) return { family: FAMILIA_INTERNA[limpio] ?? limpio, weight: 400, style: 'normal' }

  const familiaBase = limpio.slice(0, guion)
  const family = FAMILIA_INTERNA[familiaBase] ?? familiaBase
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
  // Probar las claves más específicas primero (semibold antes que bold) y cortar
  // en la primera coincidencia: si no, "bold" pisaría a "semibold"/"extrabold".
  for (const clave of Object.keys(PESOS).sort((a, b) => b.length - a.length)) {
    if (tokens.includes(clave) || unido.includes(clave)) { weight = PESOS[clave]; break }
  }
  if (tokens.includes('italic') || tokens.includes('oblique') || unido.includes('italic')) {
    style = 'italic'
  }
  return { family, weight, style }
}

// Lee el nombre de familia INTERNO de una fuente TTF/OTF (tabla 'name').
// Necesario para que resvg matchee fuentes importadas. woff/woff2 → null (comprimido).
export function familiaInternaDeFont(bytes: Uint8Array): string | null {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const tag0 = dv.getUint32(0)
    if (!(tag0 === 0x00010000 || tag0 === 0x4f54544f || tag0 === 0x74727565)) return null
    const numTables = dv.getUint16(4)
    let nameOff = 0
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16
      if (dv.getUint32(rec) === 0x6e616d65) { nameOff = dv.getUint32(rec + 8); break } // 'name'
    }
    if (!nameOff) return null
    const count = dv.getUint16(nameOff + 2)
    const strOff = dv.getUint16(nameOff + 4)
    const cands: Record<number, string> = {}
    for (let i = 0; i < count; i++) {
      const rec = nameOff + 6 + i * 12
      const plat = dv.getUint16(rec)
      const nameID = dv.getUint16(rec + 6)
      const len = dv.getUint16(rec + 8)
      const off = dv.getUint16(rec + 10)
      if (nameID !== 1 && nameID !== 16) continue
      const sp = nameOff + strOff + off
      let s = ''
      if (plat === 3 || plat === 0) { for (let j = 0; j < len; j += 2) s += String.fromCharCode(dv.getUint16(sp + j)) }
      else { for (let j = 0; j < len; j++) s += String.fromCharCode(dv.getUint8(sp + j)) }
      if (s && !cands[nameID]) cands[nameID] = s
    }
    return (cands[16] || cands[1] || '').trim() || null
  } catch { return null }
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
