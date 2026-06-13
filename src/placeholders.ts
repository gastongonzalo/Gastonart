// Detección y reemplazo de placeholders (texto multilínea + imagen).
//
// CONVENCIÓN REAL (plantillas de Illustrator del usuario):
//   - Cada línea de texto es un <text> separado, con su transform/posición.
//   - Un campo va desde el <text> con '{' hasta el <text> con '}'.
//     Las líneas intermedias no tienen llaves.
//   - La palabra de relleno (TÍTULO, BAJADA, FECHA…) identifica el campo.
//   - Imagen: un único <image> recortado por una clase CSS (clip-path).

const SVGNS = 'http://www.w3.org/2000/svg'
const XLINK = 'http://www.w3.org/1999/xlink'

export interface CampoTexto {
  nombre: string
  etiqueta: string
}

export interface Foto {
  dataUrl: string
  w: number
  h: number
}

function parsear(svg: string): Document {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const err = doc.querySelector('parsererror')
  if (err) throw new Error('El SVG no se pudo parsear: ' + err.textContent)
  return doc
}

function normalizarClave(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

interface GrupoCampo {
  els: Element[]
  nombre: string
  etiqueta: string
}

function mapearCampos(doc: Document): GrupoCampo[] {
  const texts = Array.from(doc.querySelectorAll('text'))
  const grupos: GrupoCampo[] = []
  const usados = new Map<string, number>()

  const cerrar = (els: Element[], texto: string) => {
    const inner = texto.replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim()
    const primera = inner.split(' ')[0] || 'campo'
    let nombre = normalizarClave(primera) || 'campo'
    const n = (usados.get(nombre) ?? 0) + 1
    usados.set(nombre, n)
    if (n > 1) nombre = `${nombre}_${n}`
    const etiqueta = inner.length > 40 ? inner.slice(0, 40) + '…' : inner
    grupos.push({ els, nombre, etiqueta })
  }

  let els: Element[] | null = null
  let texto = ''
  for (const el of texts) {
    const t = el.textContent ?? ''
    if (els) {
      els.push(el)
      texto += ' ' + t
      if (t.includes('}')) {
        cerrar(els, texto)
        els = null
        texto = ''
      }
    } else if (t.includes('{')) {
      els = [el]
      texto = t
      if (t.includes('}')) {
        cerrar(els, texto)
        els = null
        texto = ''
      }
    }
  }
  if (els) cerrar(els, texto)
  return grupos
}

export function listarCamposTexto(svg: string): CampoTexto[] {
  return mapearCampos(parsear(svg)).map(({ nombre, etiqueta }) => ({ nombre, etiqueta }))
}

export function hayImagen(svg: string): boolean {
  return !!parsear(svg).querySelector('image')
}

export interface MetaCampo {
  lh: number // interlineado (px en unidades del SVG)
  x: string // x del primer tspan
  y: string | null // y del primer tspan
}

export interface FrameFoto { x: number; y: number; w: number; h: number }
export interface Encuadre { zoom: number; ox: number; oy: number }

// Prepara el SVG para edición en vivo: marca cada <text> de cada campo con
// data-campo (y el ancla con data-anchor), marca la imagen con data-foto y
// devuelve metadatos por campo + el marco (rect colocado) de la imagen original.
export function prepararEditor(svg: string): {
  svg: string
  campos: CampoTexto[]
  meta: Record<string, MetaCampo>
  frameFoto: FrameFoto | null
} {
  const doc = parsear(svg)
  const styleText = Array.from(doc.querySelectorAll('style'))
    .map((s) => s.textContent ?? '')
    .join('\n')

  const grupos = mapearCampos(doc)
  const meta: Record<string, MetaCampo> = {}

  for (const grupo of grupos) {
    const anchor = grupo.els[0]
    const ft = anchor.querySelector('tspan')
    meta[grupo.nombre] = {
      lh: lineHeightDeGrupo(grupo.els, styleText),
      x: ft?.getAttribute('x') ?? '0',
      y: ft?.getAttribute('y') ?? null,
    }
    for (const el of grupo.els) el.setAttribute('data-campo', grupo.nombre)
    anchor.setAttribute('data-anchor', '1')
  }

  let frameFoto: FrameFoto | null = null
  const img = doc.querySelector('image')
  if (img) {
    img.setAttribute('data-foto', '1')
    const W = parseFloat(img.getAttribute('width') ?? '0')
    const H = parseFloat(img.getAttribute('height') ?? '0')
    const pos = transformXY(img) ?? { x: 0, y: 0 }
    const s = escalaDe(img)
    frameFoto = { x: pos.x, y: pos.y, w: W * s, h: H * s }
  }

  const campos = grupos.map(({ nombre, etiqueta }) => ({ nombre, etiqueta }))
  return { svg: new XMLSerializer().serializeToString(doc), campos, meta, frameFoto }
}

// Aplica la foto del usuario al <image> del SVG vivo, con zoom y desplazamiento
// (encuadre), siempre cubriendo el marco. Devuelve el desplazamiento ya recortado
// a los límites válidos (para que el estado no se desborde).
export function aplicarFotoDom(
  root: Element,
  foto: Foto,
  frame: FrameFoto,
  enc: Encuadre,
): { ox: number; oy: number } {
  const img = root.querySelector('[data-foto]') as SVGElement | null
  if (!img) return { ox: enc.ox, oy: enc.oy }

  const cover = Math.max(frame.w / foto.w, frame.h / foto.h)
  const scale = cover * Math.max(1, enc.zoom)
  const pw = foto.w * scale
  const ph = foto.h * scale
  const baseNx = frame.x + (frame.w - pw) / 2
  const baseNy = frame.y + (frame.h - ph) / 2

  let nx = baseNx + enc.ox
  let ny = baseNy + enc.oy
  nx = Math.min(frame.x, Math.max(frame.x + frame.w - pw, nx))
  ny = Math.min(frame.y, Math.max(frame.y + frame.h - ph, ny))

  img.setAttribute('width', String(foto.w))
  img.setAttribute('height', String(foto.h))
  img.setAttribute('transform', `translate(${nx} ${ny}) scale(${scale})`)
  img.setAttribute('href', foto.dataUrl)
  img.setAttributeNS(XLINK, 'xlink:href', foto.dataUrl)

  return { ox: nx - baseNx, oy: ny - baseNy }
}

export interface OpcionesPintado {
  lh: number
  x: string
  y: string | null
  fontSizePx?: number | null // si se setea, sobreescribe el tamaño (para shrink/manual)
  weight?: string
  italic?: boolean
  family?: string
  anchor?: 'start' | 'middle' | 'end' // alineación (text-anchor)
}

// Edita un campo en un SVG ya montado en el DOM (edición en vivo).
// Recibe las líneas YA divididas/envueltas; reconstruye el ancla con un
// <tspan> por línea y borra las líneas sobrantes del relleno original.
export function aplicarCampoDom(
  root: Element,
  nombre: string,
  lineas: string[],
  opts: OpcionesPintado,
): void {
  const els = Array.from(root.querySelectorAll(`[data-campo="${nombre}"]`))
  if (!els.length) return
  const anchor = (els.find((e) => e.hasAttribute('data-anchor')) ?? els[0]) as SVGElement
  for (const el of els) if (el !== anchor) el.remove()

  while (anchor.firstChild) anchor.removeChild(anchor.firstChild)

  if (opts.fontSizePx) anchor.style.fontSize = opts.fontSizePx + 'px'
  else anchor.style.removeProperty('font-size')
  if (opts.weight) anchor.style.fontWeight = opts.weight
  anchor.style.fontStyle = opts.italic ? 'italic' : 'normal'
  if (opts.family) anchor.style.fontFamily = opts.family
  if (opts.anchor) anchor.style.textAnchor = opts.anchor

  const doc = anchor.ownerDocument
  const ls = lineas.length ? lineas : ['']
  ls.forEach((linea, i) => {
    const ts = doc.createElementNS(SVGNS, 'tspan')
    ts.setAttribute('x', opts.x)
    if (i === 0) {
      if (opts.y != null) ts.setAttribute('y', opts.y)
    } else {
      ts.setAttribute('dy', String(opts.lh))
    }
    ts.textContent = linea
    anchor.appendChild(ts)
  })
}

// --- helpers de geometría / estilo ---

function transformXY(el: Element): { x: number; y: number } | null {
  const t = el.getAttribute('transform') ?? ''
  const m = t.match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)/)
  if (m) return { x: +m[1], y: +m[2] }
  const mm = t.match(/matrix\(\s*([-\d.]+)(?:[\s,]+[-\d.]+){3}[\s,]+([-\d.]+)[\s,]+([-\d.]+)/)
  if (mm) return { x: +mm[2], y: +mm[3] }
  return null
}

function escalaDe(el: Element): number {
  const t = el.getAttribute('transform') ?? ''
  const s = t.match(/scale\(\s*([-\d.]+)/)
  if (s) return +s[1]
  const mm = t.match(/matrix\(\s*([-\d.]+)/)
  if (mm) return +mm[1]
  return 1
}

// font-size de una clase CSS (para estimar interlineado en campos de 1 línea).
function fontSizeDeClase(styleText: string, cls: string): number | null {
  if (!cls) return null
  const re = new RegExp('\\.' + cls + '\\b[^{}]*\\{([^}]*)\\}', 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(styleText)) !== null) {
    const fs = m[1].match(/font-size\s*:\s*([\d.]+)/i)
    if (fs) return +fs[1]
  }
  return null
}

function lineHeightDeGrupo(els: Element[], styleText: string): number {
  // Caso A: varias <text> (cada línea es su propio elemento, ej. efeméride).
  if (els.length >= 2) {
    const a = transformXY(els[0])
    const b = transformXY(els[1])
    if (a && b) return Math.abs(b.y - a.y)
  }
  // Caso B: un solo <text> con varios <tspan> (ej. título de noticias).
  const tspans = els[0].querySelectorAll('tspan')
  if (tspans.length >= 2) {
    const y0 = parseFloat(tspans[0].getAttribute('y') ?? 'NaN')
    const y1 = parseFloat(tspans[1].getAttribute('y') ?? 'NaN')
    if (!Number.isNaN(y0) && !Number.isNaN(y1) && y1 !== y0) return Math.abs(y1 - y0)
    const dy1 = parseFloat(tspans[1].getAttribute('dy') ?? 'NaN')
    if (!Number.isNaN(dy1) && dy1 !== 0) return Math.abs(dy1)
  }
  // Fallback: ratio típico para campos de 1 línea.
  const cls = (els[0].getAttribute('class') ?? '').split(/\s+/)[0]
  const fs = fontSizeDeClase(styleText, cls)
  return Math.round((fs ?? 48) * 1.5)
}

// Reescribe un grupo como un <text> con un <tspan> por línea del valor.
function aplicarMultilinea(doc: Document, grupo: GrupoCampo, valor: string, styleText: string): void {
  const lineas = valor.split('\n')
  const anchor = grupo.els[0]
  const primerTspan = anchor.querySelector('tspan')
  const x = primerTspan?.getAttribute('x') ?? '0'
  const y = primerTspan?.getAttribute('y')
  const lh = lineHeightDeGrupo(grupo.els, styleText)

  while (anchor.firstChild) anchor.removeChild(anchor.firstChild)

  lineas.forEach((linea, i) => {
    const ts = doc.createElementNS(SVGNS, 'tspan')
    ts.setAttribute('x', x)
    if (i === 0) {
      if (y != null) ts.setAttribute('y', y)
    } else {
      ts.setAttribute('dy', String(lh))
    }
    ts.textContent = linea
    anchor.appendChild(ts)
  })

  for (let i = 1; i < grupo.els.length; i++) grupo.els[i].remove()
}

// Reemplaza la (única) imagen de la plantilla, encajándola en modo "cover"
// dentro del mismo rectángulo que ocupaba la original (respeta el recorte CSS).
function reemplazarImagen(doc: Document, foto: Foto): void {
  const img = doc.querySelector('image')
  if (!img) return

  const W = parseFloat(img.getAttribute('width') ?? '0')
  const H = parseFloat(img.getAttribute('height') ?? '0')
  const pos = transformXY(img) ?? { x: 0, y: 0 }
  const s = escalaDe(img)
  const placedW = W * s
  const placedH = H * s

  const cover = Math.max(placedW / foto.w, placedH / foto.h)
  const nx = pos.x + (placedW - foto.w * cover) / 2
  const ny = pos.y + (placedH - foto.h * cover) / 2

  img.setAttribute('width', String(foto.w))
  img.setAttribute('height', String(foto.h))
  img.setAttribute('transform', `translate(${nx} ${ny}) scale(${cover})`)
  img.setAttribute('href', foto.dataUrl)
  img.setAttributeNS(XLINK, 'xlink:href', foto.dataUrl)
}

// Compone la plantilla: aplica textos (multilínea) y/o foto en UNA pasada.
// Los campos sin valor quedan con su {RELLENO}.
export function componer(
  svg: string,
  valores: Record<string, string>,
  foto: Foto | null,
): string {
  const hayTexto = Object.values(valores).some((v) => v && v.trim() !== '')
  if (!hayTexto && !foto) return svg

  const doc = parsear(svg)
  const styleText = Array.from(doc.querySelectorAll('style'))
    .map((s) => s.textContent ?? '')
    .join('\n')

  if (hayTexto) {
    for (const grupo of mapearCampos(doc)) {
      const valor = valores[grupo.nombre]
      if (valor == null || valor.trim() === '') continue
      aplicarMultilinea(doc, grupo, valor, styleText)
    }
  }

  if (foto) reemplazarImagen(doc, foto)

  return new XMLSerializer().serializeToString(doc)
}
