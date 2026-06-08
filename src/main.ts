import './style.css'
import {
  prepararEditor,
  aplicarCampoDom,
  aplicarFotoDom,
  hayImagen,
  type CampoTexto,
  type MetaCampo,
  type Foto,
  type FrameFoto,
  type Encuadre,
} from './placeholders'
import {
  normalizarFuentesIllustrator,
  faceDesdeNombre,
  interpretarNombreFuente,
  type FontFace,
} from './font'
import { renderResvg } from './render-resvg'

// ---------------------------------------------------------------
//  Assets
// ---------------------------------------------------------------
const plantillas = import.meta.glob('./assets/templates/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const fuentesPack = import.meta.glob('./assets/fonts/*.{ttf,otf,woff,woff2}', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

const rutasPlantilla = Object.keys(plantillas).sort()
const nombreCorto = (r: string) => r.split('/').pop()!.replace(/\.svg$/i, '')

// ---------------------------------------------------------------
//  Estado
// ---------------------------------------------------------------
interface Rect { left: number; top: number; width: number; height: number }
interface Metrica {
  lh: number
  x: string
  y: string | null
  fontSizeUser: number
  weight: string
  family: string
  color: string
  maxWidthUser: number
  boxLines: number
}

let plantillaActual = rutasPlantilla[0]
let facesPack: FontFace[] = []
let valores: Record<string, string> = {}
let foto: Foto | null = null
let frameFoto: FrameFoto | null = null
let encuadre: Encuadre = { zoom: 1, ox: 0, oy: 0 }
let zoomSlider: HTMLInputElement | null = null

let svgEl: SVGSVGElement | null = null
let camposActuales: CampoTexto[] = []
let metaActual: Record<string, MetaCampo> = {}
let metricas: Record<string, Metrica> = {}
let rectsIniciales: Record<string, Rect> = {}
let editorActivo:
  | { nombre: string; ta: HTMLTextAreaElement; valorPrevio: string; tocado: boolean; els: Element[] }
  | null = null

const medidor = document.createElement('canvas').getContext('2d')!

// ---------------------------------------------------------------
//  UI base
// ---------------------------------------------------------------
const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <header class="topbar">
    <strong>GastonART</strong>
    <label>Plantilla
      <select id="sel-plantilla">
        ${rutasPlantilla.map((r) => `<option value="${escAttr(r)}">${escAttr(nombreCorto(r))}</option>`).join('')}
      </select>
    </label>
    <span class="sep"></span>
    <button id="btn-export">Exportar PNG (resvg)</button>
    <span class="estado" id="estado"></span>
  </header>

  <div id="escenario">
    <div id="lienzo"></div>
  </div>
  <input type="file" id="in-foto" accept="image/*" hidden>

  <div id="panel-export" hidden>
    <div class="pe-head">
      <span>PNG exportado (resvg)</span>
      <a id="pe-descargar" download>Descargar</a>
      <button id="pe-cerrar" class="mini">Cerrar</button>
    </div>
    <img id="pe-img" alt="Vista previa del PNG exportado">
  </div>
`

const selPlantilla = document.querySelector<HTMLSelectElement>('#sel-plantilla')!
const lienzo = document.querySelector<HTMLDivElement>('#lienzo')!
const estado = document.querySelector<HTMLSpanElement>('#estado')!
const btnExport = document.querySelector<HTMLButtonElement>('#btn-export')!
const inFoto = document.querySelector<HTMLInputElement>('#in-foto')!
const panelExport = document.querySelector<HTMLDivElement>('#panel-export')!
const peImg = document.querySelector<HTMLImageElement>('#pe-img')!
const peDescargar = document.querySelector<HTMLAnchorElement>('#pe-descargar')!
document.querySelector('#pe-cerrar')!.addEventListener('click', () => { panelExport.hidden = true })

// ---------------------------------------------------------------
//  Fuentes (Poppins) a nivel documento
// ---------------------------------------------------------------
function inyectarFontFaces(): void {
  const reglas = Object.entries(fuentesPack)
    .map(([ruta, url]) => {
      const info = interpretarNombreFuente(ruta.split('/').pop()!.replace(/\.[^.]+$/, ''))
      return `@font-face{font-family:'${info.family}';font-weight:${info.weight};font-style:${info.style};src:url(${url});font-display:swap;}`
    })
    .join('\n')
  const st = document.createElement('style')
  st.textContent = reglas
  document.head.appendChild(st)
}

async function cargarPack(): Promise<void> {
  facesPack = await Promise.all(
    Object.entries(fuentesPack).map(async ([ruta, url]) => {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
      return faceDesdeNombre(ruta.split('/').pop()!, bytes)
    }),
  )
}

// ---------------------------------------------------------------
//  Montaje de la plantilla
// ---------------------------------------------------------------
async function montarPlantilla(): Promise<void> {
  cerrarEditor()
  const prep = prepararEditor(plantillas[plantillaActual])
  camposActuales = prep.campos
  metaActual = prep.meta

  lienzo.innerHTML = normalizarFuentesIllustrator(prep.svg)
  svgEl = lienzo.querySelector('svg')
  if (svgEl) {
    svgEl.removeAttribute('width')
    svgEl.removeAttribute('height')
    svgEl.style.width = '100%'
    svgEl.style.height = 'auto'
    svgEl.style.display = 'block'
  }

  // Marco visible de la foto (máscara de recorte ∩ placa) — base del encuadre.
  frameFoto = frameVisibleUser() ?? prep.frameFoto

  // Foto del usuario (si hay), con su encuadre.
  if (foto && frameFoto) {
    const c = aplicarFotoDom(svgEl!, foto, frameFoto, encuadre)
    encuadre.ox = c.ox
    encuadre.oy = c.oy
  }

  await document.fonts.ready
  calcularMetricas()

  // Aplicar valores ya cargados (normalmente vacío al cambiar de plantilla).
  for (const nombre of Object.keys(valores)) {
    if (valores[nombre] && metricas[nombre]) pintarCampo(nombre)
  }

  construirOverlays()
  estado.textContent = `${camposActuales.length} campo(s) · ${hayImagen(plantillas[plantillaActual]) ? 'foto editable' : 'sin foto'} · pasá el mouse y hacé clic`
}

// Mide, por campo, interlineado, tamaño, color y ANCHO de caja (del relleno).
function calcularMetricas(): void {
  if (!svgEl) return
  metricas = {}
  rectsIniciales = {}
  const base = lienzo.getBoundingClientRect()

  for (const c of camposActuales) {
    const els = Array.from(svgEl.querySelectorAll<SVGTextElement>(`[data-campo="${c.nombre}"]`))
    if (!els.length) continue
    const anchor = els.find((e) => e.hasAttribute('data-anchor')) ?? els[0]
    const cs = getComputedStyle(anchor)

    // Líneas REALES: los <tspan> de cada <text> del campo (o el <text> si no tiene).
    // En noticias el título es un <text> con varios <tspan>; en efeméride son
    // varios <text>. Medir por línea real evita sumar todas las líneas.
    const lineEls: Element[] = []
    for (const te of els) {
      const ts = Array.from(te.querySelectorAll('tspan'))
      if (ts.length) lineEls.push(...ts)
      else lineEls.push(te)
    }
    const conTexto = lineEls.filter((e) => (e.textContent ?? '').trim() !== '')
    const usar = conTexto.length ? conTexto : lineEls
    const anchos = usar.map((e) => {
      try { return (e as unknown as SVGTextContentElement).getComputedTextLength() } catch { return 0 }
    })

    metricas[c.nombre] = {
      lh: metaActual[c.nombre].lh,
      x: metaActual[c.nombre].x,
      y: metaActual[c.nombre].y,
      fontSizeUser: parseFloat(cs.fontSize),
      weight: cs.fontWeight || '400',
      family: cs.fontFamily || "'Poppins'",
      color: cs.fill && cs.fill !== 'none' ? cs.fill : '#111',
      maxWidthUser: Math.max(...anchos, 1),
      boxLines: usar.length,
    }
    const r = rectUnion(els, base)
    if (r) rectsIniciales[c.nombre] = r
  }
}

// ---------------------------------------------------------------
//  Wrap + auto-shrink (≤5%)
// ---------------------------------------------------------------
function envolver(texto: string, m: Metrica, escala: number): string[] {
  const fs = m.fontSizeUser * escala
  medidor.font = `${m.weight} ${fs}px ${m.family}`
  const out: string[] = []
  for (const para of texto.split('\n')) {
    if (para === '') { out.push(''); continue }
    let linea = ''
    for (const palabra of para.split(/ +/)) {
      const prueba = linea ? linea + ' ' + palabra : palabra
      if (medidor.measureText(prueba).width > m.maxWidthUser && linea) {
        out.push(linea)
        linea = palabra
      } else {
        linea = prueba
      }
    }
    out.push(linea)
  }
  return out
}

function ajustar(texto: string, m: Metrica): { lineas: string[]; escala: number } {
  let ultimo = { lineas: envolver(texto, m, 1), escala: 1 }
  for (const escala of [1, 0.975, 0.95]) {
    const lineas = envolver(texto, m, escala)
    if (lineas.length <= m.boxLines) return { lineas, escala }
    ultimo = { lineas, escala }
  }
  return ultimo // no entra ni al 95%: se deja al 95%
}

function pintarCampo(nombre: string): void {
  if (!svgEl) return
  const m = metricas[nombre]
  if (!m) return
  const v = valores[nombre] ?? ''
  if (v === '') {
    aplicarCampoDom(svgEl, nombre, [''], { lh: m.lh, x: m.x, y: m.y, fontSizePx: null })
    return
  }
  const { lineas, escala } = ajustar(v, m)
  aplicarCampoDom(svgEl, nombre, lineas, {
    lh: m.lh * escala,
    x: m.x,
    y: m.y,
    fontSizePx: escala < 1 ? m.fontSizeUser * escala : null,
  })
}

// ---------------------------------------------------------------
//  Overlays
// ---------------------------------------------------------------
function rectUnion(els: ArrayLike<Element>, base: DOMRect): Rect | null {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
  for (const el of Array.from(els)) {
    const cr = el.getBoundingClientRect()
    if (cr.width === 0 && cr.height === 0) continue
    l = Math.min(l, cr.left); t = Math.min(t, cr.top)
    r = Math.max(r, cr.right); b = Math.max(b, cr.bottom)
  }
  if (l === Infinity) return null
  return { left: l - base.left, top: t - base.top, width: r - l, height: b - t }
}

// Marco VISIBLE de la foto en unidades del SVG: bbox de la máscara de recorte
// (clip-path) recortada a la placa. Es lo que la foto debe cubrir y la base
// del encuadre. Si no hay clip, usa toda la placa.
function frameVisibleUser(): FrameFoto | null {
  if (!svgEl) return null
  const img = svgEl.querySelector('[data-foto]')
  if (!img) return null

  const vb = svgEl.viewBox.baseVal
  const vw = vb.width || 1080
  const vh = vb.height || 1350

  let clipEl: Element | null = null
  let el: Element | null = img
  while (el && el !== svgEl) {
    const id = getComputedStyle(el).clipPath.match(/#([^")]+)/)?.[1]
    if (id) { clipEl = svgEl.querySelector('#' + CSS.escape(id)); break }
    el = el.parentElement
  }
  const shape = clipEl?.querySelector('path, rect, polygon, circle, ellipse')

  let bx = 0, by = 0, bw = vw, bh = vh
  if (shape) {
    try { const b = (shape as SVGGraphicsElement).getBBox(); bx = b.x; by = b.y; bw = b.width; bh = b.height } catch { /* sin clip usable */ }
  }
  const x0 = Math.max(0, bx), y0 = Math.max(0, by)
  const x1 = Math.min(vw, bx + bw), y1 = Math.min(vh, by + bh)
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

// El mismo marco visible, pero en píxeles del lienzo (para el overlay/hit).
function rectFotoVisible(_img: Element, base: DOMRect): Rect | null {
  if (!svgEl || !frameFoto) return null
  const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
  const svgRect = svgEl.getBoundingClientRect()
  return {
    left: svgRect.left - base.left + frameFoto.x * k,
    top: svgRect.top - base.top + frameFoto.y * k,
    width: frameFoto.w * k,
    height: frameFoto.h * k,
  }
}

function construirOverlays(): void {
  if (!svgEl) return
  lienzo.querySelectorAll('.hit, .foto-tools').forEach((n) => n.remove())
  zoomSlider = null
  const base = lienzo.getBoundingClientRect()

  // Foto primero (queda DEBAJO de los textos).
  const img = svgEl.querySelector('[data-foto]')
  if (img) {
    const r = rectFotoVisible(img, base)
    if (r) {
      const hit = crearHit(r, 'foto', () => { if (!foto) inFoto.click() })
      hit.classList.add('hit-foto')
      hit.title = foto ? 'Arrastrá para encuadrar · rueda para zoom' : 'Subir foto'
      lienzo.appendChild(hit)
      if (foto && frameFoto) {
        habilitarPanZoom(hit)
        construirFotoTools()
      }
    }
  }

  for (const c of camposActuales) {
    let r = rectUnion(svgEl.querySelectorAll(`[data-campo="${c.nombre}"]`), base)
    if (!r || r.height < 10) r = rectsIniciales[c.nombre] ?? r
    if (!r) continue
    const hit = crearHit(r, c.nombre, () => abrirEditor(c.nombre))
    hit.title = `Editar: ${c.nombre}`
    lienzo.appendChild(hit)
  }
}

function crearHit(r: Rect, etiqueta: string, onClick: () => void): HTMLDivElement {
  const div = document.createElement('div')
  div.className = 'hit'
  div.dataset.etq = etiqueta
  Object.assign(div.style, {
    left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px',
  })
  div.addEventListener('click', onClick)
  return div
}

// Arrastrar para reencuadrar la foto + rueda para zoom.
function habilitarPanZoom(hit: HTMLDivElement): void {
  hit.style.cursor = 'grab'
  hit.addEventListener('pointerdown', (e) => {
    if (!foto || !frameFoto || !svgEl) return
    e.preventDefault()
    hit.setPointerCapture(e.pointerId)
    hit.style.cursor = 'grabbing'
    const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
    let sx = e.clientX, sy = e.clientY
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / k
      const dy = (ev.clientY - sy) / k
      sx = ev.clientX; sy = ev.clientY
      encuadre.ox += dx; encuadre.oy += dy
      const c = aplicarFotoDom(svgEl!, foto!, frameFoto!, encuadre)
      encuadre.ox = c.ox; encuadre.oy = c.oy
    }
    const onUp = () => {
      hit.removeEventListener('pointermove', onMove)
      hit.style.cursor = 'grab'
    }
    hit.addEventListener('pointermove', onMove)
    hit.addEventListener('pointerup', onUp, { once: true })
    hit.addEventListener('pointercancel', onUp, { once: true })
  })
  hit.addEventListener('wheel', (e) => {
    if (!foto || !frameFoto || !svgEl) return
    e.preventDefault()
    const f = e.deltaY < 0 ? 1.08 : 1 / 1.08
    encuadre.zoom = Math.min(5, Math.max(1, encuadre.zoom * f))
    const c = aplicarFotoDom(svgEl, foto, frameFoto, encuadre)
    encuadre.ox = c.ox; encuadre.oy = c.oy
    if (zoomSlider) zoomSlider.value = String(encuadre.zoom)
  }, { passive: false })
}

// Mini-barra de la foto: cambiar y zoom.
function construirFotoTools(): void {
  const tools = document.createElement('div')
  tools.className = 'foto-tools'
  tools.innerHTML =
    `<button class="ft-cambiar mini">Cambiar foto</button>` +
    `<label class="ft-zoom">Zoom <input type="range" min="1" max="5" step="0.01" value="${encuadre.zoom}"></label>`
  tools.querySelector('.ft-cambiar')!.addEventListener('click', () => inFoto.click())
  const slider = tools.querySelector('input')!
  slider.addEventListener('input', () => {
    if (!foto || !frameFoto || !svgEl) return
    encuadre.zoom = parseFloat(slider.value)
    const c = aplicarFotoDom(svgEl, foto, frameFoto, encuadre)
    encuadre.ox = c.ox; encuadre.oy = c.oy
  })
  zoomSlider = slider
  lienzo.appendChild(tools)
}

// ---------------------------------------------------------------
//  Editor en vivo (sin recuadro: el texto cambia sobre la imagen)
// ---------------------------------------------------------------
function abrirEditor(nombre: string): void {
  if (!svgEl) return
  cerrarEditor()
  const m = metricas[nombre]
  if (!m) return
  const base = lienzo.getBoundingClientRect()
  const r = rectUnion(svgEl.querySelectorAll(`[data-campo="${nombre}"]`), base) ?? rectsIniciales[nombre]
  if (!r) return
  const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
  const valorPrevio = valores[nombre] ?? ''

  // Ocultamos el texto del SVG mientras se edita; el textarea (mismo color,
  // fuente y posición) lo reemplaza visualmente → el cursor queda alineado.
  const els = Array.from(svgEl.querySelectorAll(`[data-campo="${nombre}"]`))
  for (const el of els) (el as SVGElement).style.opacity = '0'

  const ta = document.createElement('textarea')
  ta.className = 'editor-text'
  ta.value = valorPrevio
  ta.spellcheck = false
  Object.assign(ta.style, {
    left: r.left + 'px',
    top: r.top - 1 + 'px',
    width: Math.max(m.maxWidthUser * k, 60) + 'px',
    fontSize: m.fontSizeUser * k + 'px',
    fontWeight: m.weight,
    fontFamily: m.family,
    lineHeight: m.lh * k + 'px',
    color: m.color,
    caretColor: m.color,
  })
  lienzo.appendChild(ta)
  autoCrecer(ta)
  ta.focus()
  ta.setSelectionRange(ta.value.length, ta.value.length)

  editorActivo = { nombre, ta, valorPrevio, tocado: false, els }
  ta.addEventListener('input', () => {
    editorActivo!.tocado = true
    valores[nombre] = ta.value
    autoCrecer(ta)
  })
  ta.addEventListener('blur', commitEditor)
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelarEditor() }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur() }
  })
}

function autoCrecer(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto'
  ta.style.height = ta.scrollHeight + 'px'
}

function commitEditor(): void {
  if (!editorActivo) return
  const { nombre, ta, tocado, els } = editorActivo
  editorActivo = null
  for (const el of els) (el as SVGElement).style.opacity = '' // restaurar SVG
  if (tocado) {
    valores[nombre] = ta.value
    ta.remove()
    pintarCampo(nombre)
  } else {
    ta.remove()
  }
  construirOverlays()
}

function cancelarEditor(): void {
  if (!editorActivo) return
  const { nombre, ta, valorPrevio, tocado, els } = editorActivo
  editorActivo = null
  ta.remove()
  for (const el of els) (el as SVGElement).style.opacity = ''
  if (tocado) {
    valores[nombre] = valorPrevio
    pintarCampo(nombre)
  }
  construirOverlays()
}

function cerrarEditor(): void {
  if (editorActivo) commitEditor()
}

// ---------------------------------------------------------------
//  Foto
// ---------------------------------------------------------------
inFoto.addEventListener('change', async () => {
  const file = inFoto.files?.[0]
  if (!file) return
  try {
    foto = await leerFoto(file)
    encuadre = { zoom: 1, ox: 0, oy: 0 } // foto nueva: encuadre por defecto (cover centrado)
    await montarPlantilla()
  } catch (err) {
    estado.textContent = '❌ ' + (err instanceof Error ? err.message : String(err))
  }
  inFoto.value = ''
})

// Lee la foto y la RE-CODIFICA a JPEG con un canvas. Esto garantiza que resvg
// pueda decodificarla (no soporta WEBP/HEIC), corrige la orientación EXIF
// (el navegador ya la dibuja derecha) y limita el tamaño para performance.
const MAX_LADO_FOTO = 2000

function leerFoto(file: File): Promise<Foto> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'))
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const escala = Math.min(1, MAX_LADO_FOTO / Math.max(img.naturalWidth, img.naturalHeight))
        const w = Math.max(1, Math.round(img.naturalWidth * escala))
        const h = Math.max(1, Math.round(img.naturalHeight * escala))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return reject(new Error('No se pudo crear el canvas.'))
        ctx.drawImage(img, 0, 0, w, h)
        try {
          const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
          resolve({ dataUrl, w, h })
        } catch (e) {
          reject(new Error('No se pudo recodificar la imagen: ' + (e as Error).message))
        }
      }
      img.onerror = () => reject(new Error('No se pudo decodificar la imagen (formato no soportado por el navegador).'))
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

// ---------------------------------------------------------------
//  Exportar (resvg)
// ---------------------------------------------------------------
btnExport.addEventListener('click', async () => {
  try {
    cerrarEditor()
    if (!svgEl) return
    estado.textContent = 'Exportando…'
    // Exportamos EXACTAMENTE el SVG vivo (ya tiene wrap + shrink + foto aplicados),
    // así el PNG es idéntico a lo que se ve en el editor.
    const svg = new XMLSerializer().serializeToString(svgEl)
    const blob = await renderResvg(svg, facesPack.map((f) => f.bytes), 1080)
    const url = URL.createObjectURL(blob)
    peImg.src = url
    peDescargar.href = url
    peDescargar.setAttribute('download', `${nombreCorto(plantillaActual)}.png`)
    panelExport.hidden = false
    estado.textContent = 'PNG exportado.'
  } catch (err) {
    estado.textContent = '❌ ' + (err instanceof Error ? err.message : String(err))
    console.error(err)
  }
})

// ---------------------------------------------------------------
//  Eventos varios
// ---------------------------------------------------------------
selPlantilla.addEventListener('change', () => {
  plantillaActual = selPlantilla.value
  valores = {}
  foto = null
  void montarPlantilla()
})

let tResize: number | undefined
window.addEventListener('resize', () => {
  clearTimeout(tResize)
  tResize = window.setTimeout(() => construirOverlays(), 150)
})

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

// ---------------------------------------------------------------
//  Arranque
// ---------------------------------------------------------------
inyectarFontFaces()
await cargarPack()
await montarPlantilla()
