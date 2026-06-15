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

const iconosPack = import.meta.glob('./assets/iconos/*.svg', {
  query: '?raw',
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
  italic?: boolean // sólo para medición
}

// Overrides de estilo por campo (aplicados por la barra de controles de texto).
interface EstiloCampo {
  fontSize?: number
  bold?: boolean
  italic?: boolean
  align?: 'start' | 'middle' | 'end'
  family?: string
  color?: string
}

let plantillaActual = rutasPlantilla[0]
let facesPack: FontFace[] = []
let valores: Record<string, string> = {}
let estilos: Record<string, EstiloCampo> = {}
let bloqueado: Record<string, boolean> = {} // textos de plantilla nacen bloqueados (no se mueven)
let cajaAlto: Record<string, number> = {} // alto de la caja (user units). Definido ⇒ caja activa (recorta)
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

const SVGNS = 'http://www.w3.org/2000/svg'
const XLINK = 'http://www.w3.org/1999/xlink'

// Medidor de texto basado en SVG (mismo motor que el render → ancho consistente
// con getComputedTextLength del lienzo y con resvg). Fallback a canvas por las dudas.
const medidorCanvas = document.createElement('canvas').getContext('2d')!
const svgMedidor = document.createElementNS(SVGNS, 'svg')
svgMedidor.setAttribute('width', '10')
svgMedidor.setAttribute('height', '10')
svgMedidor.style.cssText = 'position:absolute;left:-99999px;top:-99999px;visibility:hidden;'
const textoMedidor = document.createElementNS(SVGNS, 'text')
svgMedidor.appendChild(textoMedidor)
document.body.appendChild(svgMedidor)

// Ancho (en unidades del SVG) de un texto con la métrica de un campo.
function medirAncho(texto: string, m: Metrica, escala: number): number {
  const fs = m.fontSizeUser * escala
  textoMedidor.style.fontFamily = m.family
  textoMedidor.style.fontWeight = m.weight
  textoMedidor.style.fontStyle = m.italic ? 'italic' : 'normal'
  textoMedidor.style.fontSize = fs + 'px'
  textoMedidor.textContent = texto
  try {
    const w = textoMedidor.getComputedTextLength()
    if (w > 0) return w
  } catch { /* usar canvas */ }
  medidorCanvas.font = `${m.italic ? 'italic ' : ''}${m.weight} ${fs}px ${m.family}`
  return medidorCanvas.measureText(texto).width
}

// Familias de fuente disponibles (de los archivos empaquetados), ordenadas.
function familiasDisponibles(): string[] {
  const s = new Set(facesPack.map((f) => f.family))
  return Array.from(s).sort((a, b) => a.localeCompare(b))
}

// Estilo efectivo de un campo = base (métrica) + overrides del usuario.
function estiloEfectivo(nombre: string): {
  fontSize: number; weight: string; italic: boolean; family: string; align: 'start' | 'middle' | 'end'; color: string; manual: boolean
} {
  const m = metricas[nombre]
  const e = estilos[nombre] ?? {}
  return {
    fontSize: e.fontSize ?? m.fontSizeUser,
    weight: e.bold ? '700' : m.weight,
    italic: !!e.italic,
    family: (e.family ?? m.family).replace(/['"]/g, '').split(',')[0].trim(),
    align: e.align ?? 'start',
    color: e.color ?? m.color,
    manual: e.fontSize != null,
  }
}

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
    <button id="btn-add-texto" class="mini">+ Texto</button>
    <button id="btn-add-img" class="mini">+ Imagen</button>
    <span class="add-wrap">
      <button id="btn-add-figura" class="mini">+ Figura ▾</button>
      <div id="menu-figura" class="menu-pop" hidden>
        <button data-fig="rect" title="Rectángulo">▭</button>
        <button data-fig="redondeado" title="Rectángulo redondeado">▢</button>
        <button data-fig="circulo" title="Círculo">●</button>
        <button data-fig="triangulo" title="Triángulo">▲</button>
        <button data-fig="linea" title="Línea">／</button>
        <button data-fig="flecha" title="Flecha">➜</button>
      </div>
    </span>
    <span class="add-wrap">
      <button id="btn-add-icono" class="mini">+ Ícono ▾</button>
      <div id="menu-icono" class="menu-pop menu-iconos" hidden></div>
    </span>
    <span class="sep"></span>
    <button id="btn-export">Exportar PNG (resvg)</button>
    <span class="estado" id="estado"></span>
  </header>

  <div id="barra-texto" hidden>
    <span class="bt-label">Texto</span>
    <button data-bt="size-" title="Achicar">A−</button>
    <span id="bt-size" class="bt-val">–</span>
    <button data-bt="size+" title="Agrandar">A+</button>
    <span class="bt-sep"></span>
    <button data-bt="al:start" title="Alinear a la izquierda">⯇</button>
    <button data-bt="al:middle" title="Centrar">≡</button>
    <button data-bt="al:end" title="Alinear a la derecha">⯈</button>
    <span class="bt-sep"></span>
    <button data-bt="bold" id="bt-bold" title="Negrita"><b>N</b></button>
    <button data-bt="italic" id="bt-italic" title="Cursiva"><i>C</i></button>
    <span class="bt-sep"></span>
    <label class="bt-color" title="Color"><input type="color" id="bt-color"></label>
    <span class="bt-sep"></span>
    <select id="bt-family" title="Tipografía"></select>
  </div>

  <div id="escenario">
    <div id="lienzo"></div>
  </div>
  <input type="file" id="in-foto" accept="image/*" hidden>
  <input type="file" id="in-img-nueva" accept="image/*" hidden>

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
const inImgNueva = document.querySelector<HTMLInputElement>('#in-img-nueva')!
const barraTexto = document.querySelector<HTMLDivElement>('#barra-texto')!
const btSize = document.querySelector<HTMLSpanElement>('#bt-size')!
const btBold = document.querySelector<HTMLButtonElement>('#bt-bold')!
const btItalic = document.querySelector<HTMLButtonElement>('#bt-italic')!
const btFamily = document.querySelector<HTMLSelectElement>('#bt-family')!
const btColor = document.querySelector<HTMLInputElement>('#bt-color')!
document.querySelector('#pe-cerrar')!.addEventListener('click', () => { panelExport.hidden = true })
document.querySelector('#btn-add-texto')!.addEventListener('click', () => agregarTexto())
document.querySelector('#btn-add-img')!.addEventListener('click', () => inImgNueva.click())
const menuFigura = document.querySelector<HTMLDivElement>('#menu-figura')!
document.querySelector('#btn-add-figura')!.addEventListener('click', (e) => {
  e.stopPropagation()
  menuFigura.hidden = !menuFigura.hidden
})
menuFigura.querySelectorAll<HTMLButtonElement>('button[data-fig]').forEach((b) => {
  b.addEventListener('click', () => { insertarFigura(b.dataset.fig!); menuFigura.hidden = true })
})

const menuIcono = document.querySelector<HTMLDivElement>('#menu-icono')!
for (const raw of Object.values(iconosPack)) {
  const b = document.createElement('button')
  b.innerHTML = raw
  const svgIco = b.querySelector('svg')
  if (svgIco) { svgIco.setAttribute('width', '22'); svgIco.setAttribute('height', '22') }
  b.addEventListener('click', () => { insertarIcono(raw); menuIcono.hidden = true })
  menuIcono.appendChild(b)
}
document.querySelector('#btn-add-icono')!.addEventListener('click', (e) => {
  e.stopPropagation()
  menuIcono.hidden = !menuIcono.hidden
})
document.addEventListener('click', () => { menuFigura.hidden = true; menuIcono.hidden = true })
inImgNueva.addEventListener('change', async () => {
  const file = inImgNueva.files?.[0]
  if (!file) return
  try {
    insertarImagen(await leerFoto(file))
  } catch (err) {
    estado.textContent = '❌ ' + (err instanceof Error ? err.message : String(err))
  }
  inImgNueva.value = ''
})

let contadorAgregados = 0 // para nombres únicos de elementos agregados

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
  bloqueado = {}
  cajaAlto = {}
  const base = lienzo.getBoundingClientRect()

  for (const c of camposActuales) {
    bloqueado[c.nombre] = true // los campos de plantilla nacen bloqueados
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
  const out: string[] = []
  for (const para of texto.split('\n')) {
    if (para === '') { out.push(''); continue }
    let linea = ''
    for (const palabra of para.split(/ +/)) {
      const prueba = linea ? linea + ' ' + palabra : palabra
      if (medirAncho(prueba, m, escala) <= m.maxWidthUser) {
        linea = prueba
        continue
      }
      // No entra con la palabra entera: cerrar la línea actual.
      if (linea) { out.push(linea); linea = '' }
      if (medirAncho(palabra, m, escala) <= m.maxWidthUser) {
        linea = palabra
      } else {
        // La palabra sola es más ancha que la caja → cortarla por sílabas (con guion).
        const piezas = partirPalabra(palabra, m, escala)
        for (let i = 0; i < piezas.length - 1; i++) out.push(piezas[i])
        linea = piezas[piezas.length - 1]
      }
    }
    out.push(linea)
  }
  return out
}

// Corta una palabra larga en piezas que entran en la caja; todas menos la última
// terminan en guion. Usa división silábica del español.
function partirPalabra(palabra: string, m: Metrica, escala: number): string[] {
  const sil = silabas(palabra)
  if (sil.length <= 1) return [palabra] // no se puede cortar (1 sílaba)
  const piezas: string[] = []
  let actual = ''
  for (let i = 0; i < sil.length; i++) {
    const ultima = i === sil.length - 1
    const tentativa = actual + sil[i]
    const medir = ultima ? tentativa : tentativa + '-'
    if (actual !== '' && medirAncho(medir, m, escala) > m.maxWidthUser) {
      piezas.push(actual + '-')
      actual = sil[i]
    } else {
      actual = tentativa
    }
  }
  piezas.push(actual)
  return piezas
}

// División silábica del español (aproximada, suficiente para cortar palabras).
function silabas(palabra: string): string[] {
  const w = palabra
  if (w.length <= 3) return [w]
  const esV = (c: string) => /[aeiouáéíóúüïàèìòù]/i.test(c)
  const acentDebil = (c: string) => /[íú]/i.test(c)
  const debil = (c: string) => /[iuü]/i.test(c)
  const fuerte = (c: string) => esV(c) && !debil(c) && !acentDebil(c)

  // 1) Núcleos vocálicos (uniendo diptongos/triptongos, separando hiatos).
  const nucleos: Array<[number, number]> = []
  let i = 0
  const n = w.length
  while (i < n) {
    if (esV(w[i])) {
      let j = i
      while (j + 1 < n && esV(w[j + 1])) {
        const a = w[j], b = w[j + 1]
        const hiato = acentDebil(a) || acentDebil(b) || (fuerte(a) && fuerte(b))
        if (hiato) break
        j++
      }
      nucleos.push([i, j])
      i = j + 1
    } else i++
  }
  if (nucleos.length <= 1) return [w]

  // 2) Punto de corte entre cada par de núcleos según las consonantes intermedias.
  const cortes: number[] = []
  for (let k = 0; k + 1 < nucleos.length; k++) {
    const cons: number[] = []
    for (let p = nucleos[k][1] + 1; p < nucleos[k + 1][0]; p++) cons.push(p)
    const m2 = cons.length
    let cut: number
    if (m2 === 0) cut = nucleos[k + 1][0]
    else if (m2 === 1) cut = cons[0]
    else {
      const c1 = w[cons[m2 - 2]], c2 = w[cons[m2 - 1]]
      cut = grupoInseparable(c1, c2) ? cons[m2 - 2] : cons[m2 - 1]
    }
    cortes.push(cut)
  }

  // 3) Armar sílabas.
  const sil: string[] = []
  let prev = 0
  for (const c of cortes) { sil.push(w.slice(prev, c)); prev = c }
  sil.push(w.slice(prev))
  return sil.filter((s) => s.length > 0)
}

// Pares de consonantes que NO se separan (consonante + l/r y dígrafos ch/ll/rr).
function grupoInseparable(c1: string, c2: string): boolean {
  const a = c1.toLowerCase(), b = c2.toLowerCase()
  if ((a === 'c' && b === 'h') || (a === 'l' && b === 'l') || (a === 'r' && b === 'r')) return true
  if (b === 'r' && 'bcdfgpt'.includes(a)) return true
  if (b === 'l' && 'bcfgpt'.includes(a)) return true // bl,cl,fl,gl,pl,tl (no dl, rl)
  return false
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
  const ef = estiloEfectivo(nombre)
  // Métrica efectiva para medir/envolver (con tamaño/peso/cursiva/familia actuales).
  const mEf: Metrica = { ...m, fontSizeUser: ef.fontSize, weight: ef.weight, family: ef.family, italic: ef.italic }
  const lhBase = m.lh * (ef.fontSize / m.fontSizeUser) // interlineado escalado al tamaño actual
  // Alineación → x del ancla (text-anchor) dentro de la caja.
  const ax = ef.align === 'middle' ? m.maxWidthUser / 2 : ef.align === 'end' ? m.maxWidthUser : 0

  const v = valores[nombre] ?? ''
  if (v === '') {
    aplicarCampoDom(svgEl, nombre, [''], {
      lh: lhBase, x: String(ax), y: m.y,
      fontSizePx: ef.fontSize, weight: ef.weight, italic: ef.italic, family: ef.family, anchor: ef.align, color: ef.color,
    })
    return
  }

  // Si el tamaño es manual, no auto-achicar; si no, aplicar shrink (≤5%).
  const res = ef.manual ? { lineas: envolver(v, mEf, 1), escala: 1 } : ajustar(v, mEf)
  let lineas = res.lineas
  const escala = res.escala

  // Caja con alto definido → recortar las líneas que no entran (no se renderizan).
  if (cajaAlto[nombre] !== undefined) {
    const maxLineas = Math.max(1, Math.floor(cajaAlto[nombre] / (lhBase * escala)))
    if (lineas.length > maxLineas) lineas = lineas.slice(0, maxLineas)
  }

  aplicarCampoDom(svgEl, nombre, lineas, {
    lh: lhBase * escala,
    x: String(ax),
    y: m.y,
    fontSizePx: ef.fontSize * escala,
    weight: ef.weight,
    italic: ef.italic,
    family: ef.family,
    anchor: ef.align,
    color: ef.color,
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

// Agrega un cuadro de texto nuevo (editable, movible, eliminable).
function agregarTexto(): void {
  if (!svgEl) return
  contadorAgregados++
  const nombre = `nuevo_${contadorAgregados}`
  const vb = svgEl.viewBox.baseVal
  const vw = vb.width || 1080
  const x0 = 90
  const y0 = 180 + (contadorAgregados % 6) * 40
  const fs = 48

  const t = document.createElementNS(SVGNS, 'text')
  t.setAttribute('data-campo', nombre)
  t.setAttribute('data-anchor', '1')
  t.setAttribute('data-agregado', 'texto')
  t.setAttribute('transform', `translate(${x0} ${y0})`)
  t.style.fontFamily = "'Poppins'"
  t.style.fontWeight = '600'
  t.style.fontSize = fs + 'px'
  t.style.fill = '#141930'
  const ts = document.createElementNS(SVGNS, 'tspan')
  ts.setAttribute('x', '0')
  ts.setAttribute('y', '0')
  ts.textContent = 'Texto nuevo'
  t.appendChild(ts)
  svgEl.appendChild(t)

  camposActuales.push({ nombre, etiqueta: 'Texto nuevo' })
  metaActual[nombre] = { lh: Math.round(fs * 1.3), x: '0', y: '0' }
  metricas[nombre] = {
    lh: Math.round(fs * 1.3),
    x: '0',
    y: '0',
    fontSizeUser: fs,
    weight: '600',
    family: "'Poppins'",
    color: 'rgb(20,25,48)',
    maxWidthUser: Math.max(120, vw - x0 - 40),
    boxLines: 50,
  }
  valores[nombre] = 'Texto nuevo'
  bloqueado[nombre] = false // los cuadros agregados nacen movibles

  construirOverlays()
  abrirEditor(nombre)
}

// Elimina un campo agregado (o cualquier campo) del SVG y del estado.
function eliminarCampo(nombre: string): void {
  if (!svgEl) return
  if (editorActivo && editorActivo.nombre === nombre) cancelarEditor()
  svgEl.querySelectorAll(`[data-campo="${nombre}"]`).forEach((n) => n.remove())
  camposActuales = camposActuales.filter((c) => c.nombre !== nombre)
  delete metricas[nombre]
  delete metaActual[nombre]
  delete valores[nombre]
  delete rectsIniciales[nombre]
  construirOverlays()
}

// Inserta una imagen nueva (movible, redimensionable, eliminable).
function insertarImagen(f: Foto): void {
  if (!svgEl) return
  contadorAgregados++
  const vw = svgEl.viewBox.baseVal.width || 1080
  const W = Math.min(450, vw * 0.5)
  const H = (W * f.h) / f.w
  const x = (vw - W) / 2
  const y = 200

  const img = document.createElementNS(SVGNS, 'image')
  img.setAttribute('data-agregado', 'imagen')
  img.setAttribute('width', String(W))
  img.setAttribute('height', String(H))
  img.setAttribute('transform', `translate(${x} ${y})`)
  img.setAttribute('href', f.dataUrl)
  img.setAttributeNS(XLINK, 'xlink:href', f.dataUrl)
  svgEl.appendChild(img)
  construirOverlays()
}

// Inserta una figura (movible, redimensionable por escala, color, eliminable).
function insertarFigura(tipo: string): void {
  if (!svgEl) return
  contadorAgregados++
  const vw = svgEl.viewBox.baseVal.width || 1080
  const vh = svgEl.viewBox.baseVal.height || 1350
  const S = 160
  const color = '#38bdf8'
  let el: SVGElement
  let modo = 'fill'
  if (tipo === 'rect' || tipo === 'redondeado') {
    el = document.createElementNS(SVGNS, 'rect')
    el.setAttribute('width', String(S)); el.setAttribute('height', String(Math.round(S * 0.66)))
    if (tipo === 'redondeado') el.setAttribute('rx', '18')
    el.setAttribute('fill', color)
  } else if (tipo === 'circulo') {
    el = document.createElementNS(SVGNS, 'circle')
    el.setAttribute('cx', String(S / 2)); el.setAttribute('cy', String(S / 2)); el.setAttribute('r', String(S / 2))
    el.setAttribute('fill', color)
  } else if (tipo === 'triangulo') {
    el = document.createElementNS(SVGNS, 'polygon')
    el.setAttribute('points', `${S / 2},0 ${S},${S} 0,${S}`)
    el.setAttribute('fill', color)
  } else if (tipo === 'linea') {
    el = document.createElementNS(SVGNS, 'line')
    el.setAttribute('x1', '0'); el.setAttribute('y1', '0'); el.setAttribute('x2', String(S)); el.setAttribute('y2', '0')
    el.setAttribute('stroke', color); el.setAttribute('stroke-width', '8'); el.setAttribute('stroke-linecap', 'round')
    modo = 'stroke'
  } else { // flecha
    el = document.createElementNS(SVGNS, 'path')
    el.setAttribute('d', `M0 ${S * 0.4} L${S * 0.66} ${S * 0.4} L${S * 0.66} ${S * 0.22} L${S} ${S * 0.5} L${S * 0.66} ${S * 0.78} L${S * 0.66} ${S * 0.6} L0 ${S * 0.6} Z`)
    el.setAttribute('fill', color)
  }
  const x = Math.round((vw - S) / 2), y = Math.round((vh - S) / 2)
  el.setAttribute('transform', `translate(${x} ${y}) scale(1)`)
  el.setAttribute('data-agregado', 'figura')
  el.setAttribute('data-colormode', modo)
  svgEl.appendChild(el)
  construirOverlays()
}

// Inserta un ícono (Lucide) como <g> de trazos, escalable y coloreable.
function insertarIcono(raw: string): void {
  if (!svgEl) return
  const doc = new DOMParser().parseFromString(raw, 'image/svg+xml')
  const svgIco = doc.querySelector('svg')
  if (!svgIco) return
  contadorAgregados++
  const g = document.createElementNS(SVGNS, 'g')
  for (const child of Array.from(svgIco.childNodes)) g.appendChild(document.importNode(child, true))
  g.setAttribute('fill', 'none')
  g.setAttribute('stroke', '#141930')
  g.setAttribute('stroke-width', '2')
  g.setAttribute('stroke-linecap', 'round')
  g.setAttribute('stroke-linejoin', 'round')
  g.setAttribute('data-agregado', 'icono')
  g.setAttribute('data-colormode', 'stroke')
  const vw = svgEl.viewBox.baseVal.width || 1080
  const vh = svgEl.viewBox.baseVal.height || 1350
  const s = 5 // 24 * 5 = 120 px
  const x = Math.round(vw / 2 - 12 * s), y = Math.round(vh / 2 - 12 * s)
  g.setAttribute('transform', `translate(${x} ${y}) scale(${s})`)
  svgEl.appendChild(g)
  construirOverlays()
}

// Arrastre genérico de un elemento (mueve su transform translate).
function habilitarArrastreEl(hit: HTMLElement, el: SVGElement): void {
  hit.addEventListener('pointerdown', (e) => {
    if (!svgEl) return
    const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
    const t = (el.getAttribute('transform') ?? '').match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)/)
    const tx0 = t ? +t[1] : 0, ty0 = t ? +t[2] : 0
    const escala = (el.getAttribute('transform') ?? '').match(/scale\([^)]*\)/)
    const escalaPart = escala ? ' ' + escala[0] : ''
    const hitX0 = parseFloat(hit.style.left), hitY0 = parseFloat(hit.style.top)
    const boxW = hit.offsetWidth, boxH = hit.offsetHeight
    let sx = e.clientX, sy = e.clientY, accX = 0, accY = 0
    let movido = false
    excluirImg = el
    const onMove = (ev: PointerEvent) => {
      const dxs = ev.clientX - sx, dys = ev.clientY - sy
      if (Math.abs(dxs) + Math.abs(dys) > 3) movido = true
      accX += dxs / k; accY += dys / k
      sx = ev.clientX; sy = ev.clientY
      const base = lienzo.getBoundingClientRect()
      const rawBox: Rect = { left: hitX0 + accX * k, top: hitY0 + accY * k, width: boxW, height: boxH }
      const snap = calcularSnap(rawBox, base)
      el.setAttribute('transform', `translate(${tx0 + accX + snap.dx / k} ${ty0 + accY + snap.dy / k})${escalaPart}`)
      hit.style.left = rawBox.left + snap.dx + 'px'
      hit.style.top = rawBox.top + snap.dy + 'px'
      dibujarGuias(snap.guias)
    }
    const onUp = () => {
      hit.removeEventListener('pointermove', onMove)
      excluirImg = null
      limpiarGuias()
      if (movido) construirOverlays()
    }
    try { hit.setPointerCapture(e.pointerId) } catch { /* sin captura: igual arrastra */ }
    hit.addEventListener('pointermove', onMove)
    hit.addEventListener('pointerup', onUp, { once: true })
    hit.addEventListener('pointercancel', onUp, { once: true })
  })
}

// Tirador para redimensionar una imagen (esquina inferior derecha, conserva proporción).
function crearTiradorResize(r: Rect, img: SVGElement): HTMLDivElement {
  const h = document.createElement('div')
  h.className = 'resize-handle'
  Object.assign(h.style, { left: r.left + r.width - 7 + 'px', top: r.top + r.height - 7 + 'px' })
  h.addEventListener('pointerdown', (e) => {
    if (!svgEl) return
    e.preventDefault(); e.stopPropagation()
    const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
    const W0 = parseFloat(img.getAttribute('width') ?? '0')
    const H0 = parseFloat(img.getAttribute('height') ?? '0')
    const ar = H0 / W0
    let sx = e.clientX
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(40, W0 + (ev.clientX - sx) / k)
      img.setAttribute('width', String(w))
      img.setAttribute('height', String(w * ar))
      h.style.left = parseFloat(h.style.left) + 0 + 'px' // (se reposiciona al soltar)
    }
    const onUp = () => { h.removeEventListener('pointermove', onMove); construirOverlays() }
    try { h.setPointerCapture(e.pointerId) } catch { /* sin captura: igual redimensiona */ }
    h.addEventListener('pointermove', onMove)
    h.addEventListener('pointerup', onUp, { once: true })
    h.addEventListener('pointercancel', onUp, { once: true })
    void sx
  })
  return h
}

// Tirador de escala (esquina) para figuras/íconos: cambia el scale del transform.
function crearTiradorEscala(r: Rect, el: SVGElement): HTMLDivElement {
  const h = document.createElement('div')
  h.className = 'resize-handle'
  Object.assign(h.style, { left: r.left + r.width - 7 + 'px', top: r.top + r.height - 7 + 'px' })
  h.addEventListener('pointerdown', (e) => {
    if (!svgEl) return
    e.preventDefault(); e.stopPropagation()
    const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
    const tr = el.getAttribute('transform') ?? ''
    const tm = tr.match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)/)
    const tx = tm ? +tm[1] : 0, ty = tm ? +tm[2] : 0
    const sm = tr.match(/scale\(\s*([-\d.]+)/)
    let s = sm ? +sm[1] : 1
    let baseW = 100
    try { baseW = (el as SVGGraphicsElement).getBBox().width || 100 } catch { /* default */ }
    let sx = e.clientX
    const onMove = (ev: PointerEvent) => {
      const dxs = ev.clientX - sx; sx = ev.clientX
      s = Math.max(0.08, s + dxs / (baseW * k))
      el.setAttribute('transform', `translate(${tx} ${ty}) scale(${s})`)
      h.style.left = parseFloat(h.style.left) + dxs + 'px'
    }
    const onUp = () => { h.removeEventListener('pointermove', onMove); construirOverlays() }
    try { h.setPointerCapture(e.pointerId) } catch { /* igual escala */ }
    h.addEventListener('pointermove', onMove)
    h.addEventListener('pointerup', onUp, { once: true })
    h.addEventListener('pointercancel', onUp, { once: true })
  })
  return h
}

// Selector de color para una figura/ícono (relleno o borde según data-colormode).
function crearSwatchColor(r: Rect, el: SVGElement): HTMLLabelElement {
  const wrap = document.createElement('label')
  wrap.className = 'swatch-figura'
  Object.assign(wrap.style, { left: r.left - 2 + 'px', top: r.top - 28 + 'px' })
  const modo = el.getAttribute('data-colormode') || 'fill'
  const inp = document.createElement('input')
  inp.type = 'color'
  inp.value = aHex(el.getAttribute(modo) || '#000000')
  inp.addEventListener('input', () => el.setAttribute(modo, inp.value))
  inp.addEventListener('pointerdown', (e) => e.stopPropagation())
  wrap.appendChild(inp)
  return wrap
}

// --- Caja contenedora de un campo de texto (para recortar/limitar) ---

// Bounding box del campo en coords del SVG: x = origen (translate x), y = top de
// la primera línea, w/h naturales del texto.
function bboxCampoUser(nombre: string): { x: number; y: number; w: number; h: number } | null {
  if (!svgEl) return null
  const els = Array.from(svgEl.querySelectorAll<SVGGraphicsElement>(`[data-campo="${nombre}"]`))
  if (!els.length) return null
  let minTx = Infinity, top = Infinity, bottom = -Infinity
  for (const el of els) {
    const t = (el.getAttribute('transform') ?? '').match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)/)
    const tx = t ? +t[1] : 0, ty = t ? +t[2] : 0
    let bb: DOMRect
    try { bb = el.getBBox() } catch { continue }
    minTx = Math.min(minTx, tx)
    top = Math.min(top, ty + bb.y)
    bottom = Math.max(bottom, ty + bb.y + bb.height)
  }
  if (minTx === Infinity) return null
  return { x: minTx, y: top, w: Math.max(1, bottom - top), h: Math.max(1, bottom - top) }
}

// Caja efectiva (ancho = maxWidthUser, alto = override o natural).
function cajaUser(nombre: string): { x: number; y: number; w: number; h: number } | null {
  const bb = bboxCampoUser(nombre)
  if (!bb) return null
  const w = metricas[nombre]?.maxWidthUser ?? bb.w
  const h = cajaAlto[nombre] ?? bb.h
  return { x: bb.x, y: bb.y, w, h }
}

// Caja en píxeles del lienzo (para el outline/handles).
function cajaScreen(nombre: string, base: DOMRect): Rect | null {
  const c = cajaUser(nombre)
  if (!c || !svgEl) return null
  const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
  const o = svgEl.getBoundingClientRect()
  return { left: o.left - base.left + c.x * k, top: o.top - base.top + c.y * k, width: c.w * k, height: c.h * k }
}

// --- Guías inteligentes (snap) al mover ---
const UMBRAL_SNAP = 6 // px de pantalla

// Rects (en px del lienzo) de los demás elementos arrastrables (para imantar).
function rectsDeElementos(excluir: string | null, base: DOMRect): Rect[] {
  if (!svgEl) return []
  const out: Rect[] = []
  for (const c of camposActuales) {
    if (c.nombre === excluir) continue
    const r = cajaScreen(c.nombre, base) ?? rectUnion(svgEl.querySelectorAll(`[data-campo="${c.nombre}"]`), base)
    if (r) out.push(r)
  }
  for (const im of Array.from(svgEl.querySelectorAll('image[data-agregado="imagen"]'))) {
    if (im === excluirImg) continue
    const r = rectUnion([im], base)
    if (r) out.push(r)
  }
  return out
}
let excluirImg: Element | null = null // imagen que se está arrastrando (no imantar consigo)

interface Guia { tipo: 'v' | 'h'; pos: number }

// Calcula el ajuste (dx,dy en px) para imantar el box a centro/bordes de la
// placa y a otros elementos, y qué guías mostrar.
function calcularSnap(box: Rect, base: DOMRect): { dx: number; dy: number; guias: Guia[] } {
  const W = lienzo.clientWidth, H = lienzo.clientHeight
  const vT = [0, W / 2, W]
  const hT = [0, H / 2, H]
  for (const r of rectsDeElementos(snapExcluir, base)) {
    vT.push(r.left, r.left + r.width / 2, r.left + r.width)
    hT.push(r.top, r.top + r.height / 2, r.top + r.height)
  }
  const ax = [box.left, box.left + box.width / 2, box.left + box.width]
  const ay = [box.top, box.top + box.height / 2, box.top + box.height]
  let bx = Infinity, bxt = 0
  for (const a of ax) for (const t of vT) if (Math.abs(t - a) < Math.abs(bx)) { bx = t - a; bxt = t }
  let by = Infinity, byt = 0
  for (const a of ay) for (const t of hT) if (Math.abs(t - a) < Math.abs(by)) { by = t - a; byt = t }
  const guias: Guia[] = []
  const snapX = Math.abs(bx) <= UMBRAL_SNAP
  const snapY = Math.abs(by) <= UMBRAL_SNAP
  if (snapX) guias.push({ tipo: 'v', pos: bxt })
  if (snapY) guias.push({ tipo: 'h', pos: byt })
  return { dx: snapX ? bx : 0, dy: snapY ? by : 0, guias }
}
let snapExcluir: string | null = null // campo que se está arrastrando

function dibujarGuias(guias: Guia[]): void {
  limpiarGuias()
  for (const g of guias) {
    const d = document.createElement('div')
    d.className = 'guia guia-' + g.tipo
    if (g.tipo === 'v') { d.style.left = g.pos + 'px'; d.style.top = '0'; d.style.height = lienzo.clientHeight + 'px' }
    else { d.style.top = g.pos + 'px'; d.style.left = '0'; d.style.width = lienzo.clientWidth + 'px' }
    lienzo.appendChild(d)
  }
}
function limpiarGuias(): void {
  lienzo.querySelectorAll('.guia').forEach((n) => n.remove())
}

function construirOverlays(): void {
  if (!svgEl) return
  lienzo.querySelectorAll('.hit, .foto-tools, .btn-eliminar, .resize-handle, .btn-candado, .resize-ancho, .resize-caja, .guia, .swatch-figura').forEach((n) => n.remove())
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
    const el = svgEl.querySelector(`[data-campo="${c.nombre}"][data-anchor]`)
    const agregado = el?.getAttribute('data-agregado') === 'texto'
    const libre = !bloqueado[c.nombre] // desbloqueado → movible/redimensionable
    let r = rectUnion(svgEl.querySelectorAll(`[data-campo="${c.nombre}"]`), base)
    if (!r || r.height < 10) r = rectsIniciales[c.nombre] ?? r
    if (!r) continue
    // Si está desbloqueado, materializamos la caja (con alto) y usamos su rect.
    if (libre && cajaAlto[c.nombre] === undefined) {
      const bb = bboxCampoUser(c.nombre)
      if (bb) cajaAlto[c.nombre] = bb.h + 6
    }
    const rCaja = libre ? (cajaScreen(c.nombre, base) ?? r) : r

    const hit = crearHit(rCaja, c.nombre, () => abrirEditor(c.nombre))
    hit.title = libre ? 'Arrastrá para mover · clic para editar' : `Editar: ${c.nombre}`
    lienzo.appendChild(hit)
    lienzo.appendChild(crearBotonCandado(rCaja, c.nombre))
    if (libre) {
      hit.classList.add('hit-agregado')
      habilitarArrastreTexto(hit, c.nombre)
      lienzo.appendChild(crearTiradorCaja(rCaja, c.nombre, 'x'))
      lienzo.appendChild(crearTiradorCaja(rCaja, c.nombre, 'y'))
      lienzo.appendChild(crearTiradorCaja(rCaja, c.nombre, 'xy'))
    }
    if (agregado) {
      lienzo.appendChild(crearBotonEliminar(rCaja, () => eliminarCampo(c.nombre)))
    }
  }

  // Imágenes agregadas (movibles, redimensionables, eliminables).
  for (const im of Array.from(svgEl.querySelectorAll<SVGElement>('image[data-agregado="imagen"]'))) {
    const r = rectUnion([im], base)
    if (!r) continue
    const hit = crearHit(r, 'imagen', () => {})
    hit.classList.add('hit-agregado')
    hit.title = 'Arrastrá para mover'
    habilitarArrastreEl(hit, im)
    lienzo.appendChild(hit)
    lienzo.appendChild(crearBotonEliminar(r, () => { im.remove(); construirOverlays() }))
    lienzo.appendChild(crearTiradorResize(r, im))
  }

  // Figuras e íconos agregados (mover, escalar, color, eliminar).
  for (const el of Array.from(svgEl.querySelectorAll<SVGElement>('[data-agregado="figura"], [data-agregado="icono"]'))) {
    const r = rectUnion([el], base)
    if (!r) continue
    const hit = crearHit(r, 'figura', () => {})
    hit.classList.add('hit-agregado')
    hit.title = 'Arrastrá para mover'
    habilitarArrastreEl(hit, el)
    lienzo.appendChild(hit)
    lienzo.appendChild(crearBotonEliminar(r, () => { el.remove(); construirOverlays() }))
    lienzo.appendChild(crearTiradorEscala(r, el))
    lienzo.appendChild(crearSwatchColor(r, el))
  }
}

// Botón ✕ para eliminar un elemento agregado (esquina sup. derecha de su caja).
function crearBotonEliminar(r: Rect, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'btn-eliminar'
  b.textContent = '✕'
  b.title = 'Eliminar'
  Object.assign(b.style, { left: r.left + r.width - 8 + 'px', top: r.top - 12 + 'px' })
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick() })
  return b
}

// Botón de candado: bloquea/desbloquea el campo (esquina sup. izquierda).
function crearBotonCandado(r: Rect, nombre: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'btn-candado'
  const locked = bloqueado[nombre]
  b.textContent = locked ? '🔒' : '🔓'
  b.title = locked ? 'Desbloquear (mover y redimensionar)' : 'Bloquear'
  if (!locked) b.classList.add('abierto')
  Object.assign(b.style, { left: r.left - 11 + 'px', top: r.top - 12 + 'px' })
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    bloqueado[nombre] = !bloqueado[nombre]
    construirOverlays()
  })
  return b
}

// Tirador para ajustar el ANCHO de la caja de texto (borde derecho).
// Tirador de la caja: 'x' = ancho (borde der), 'y' = alto (borde inf),
// 'xy' = esquina (ambos). Cambia maxWidthUser y/o cajaAlto, re-wrappea y re-clipea.
function crearTiradorCaja(r: Rect, nombre: string, eje: 'x' | 'y' | 'xy'): HTMLDivElement {
  const h = document.createElement('div')
  h.className = 'resize-caja resize-caja-' + eje
  if (eje === 'x') Object.assign(h.style, { left: r.left + r.width - 4 + 'px', top: r.top + r.height / 2 - 11 + 'px' })
  else if (eje === 'y') Object.assign(h.style, { left: r.left + r.width / 2 - 11 + 'px', top: r.top + r.height - 4 + 'px' })
  else Object.assign(h.style, { left: r.left + r.width - 7 + 'px', top: r.top + r.height - 7 + 'px' })
  h.addEventListener('pointerdown', (e) => {
    if (!svgEl) return
    e.preventDefault(); e.stopPropagation()
    const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
    let sx = e.clientX, sy = e.clientY
    const onMove = (ev: PointerEvent) => {
      const dxs = ev.clientX - sx, dys = ev.clientY - sy
      sx = ev.clientX; sy = ev.clientY
      const m = metricas[nombre]
      if (eje !== 'y') m.maxWidthUser = Math.max(40, m.maxWidthUser + dxs / k)
      if (eje !== 'x') cajaAlto[nombre] = Math.max(20, (cajaAlto[nombre] ?? 0) + dys / k)
      // Re-acomodar/recortar si hay texto real (el ancho re-wrappea, el alto re-recorta).
      if ((valores[nombre] ?? '').trim()) pintarCampo(nombre)
      if (eje !== 'y') h.style.left = parseFloat(h.style.left) + dxs + 'px'
      if (eje !== 'x') h.style.top = parseFloat(h.style.top) + dys + 'px'
    }
    const onUp = () => { h.removeEventListener('pointermove', onMove); construirOverlays() }
    try { h.setPointerCapture(e.pointerId) } catch { /* igual redimensiona */ }
    h.addEventListener('pointermove', onMove)
    h.addEventListener('pointerup', onUp, { once: true })
    h.addEventListener('pointercancel', onUp, { once: true })
  })
  return h
}

// Arrastre de un cuadro de texto agregado: mueve su transform translate.
// Click sin movimiento = editar (lo maneja el listener de click del hit).
function habilitarArrastreTexto(hit: HTMLDivElement, nombre: string): void {
  hit.addEventListener('pointerdown', (e) => {
    if (!svgEl) return
    // Mover TODOS los <text> del campo juntos (un campo de plantilla sin editar
    // puede tener varias líneas en <text> separados; mover sólo el ancla los rompe).
    const els = Array.from(svgEl.querySelectorAll<SVGElement>(`[data-campo="${nombre}"]`))
    if (!els.length) return
    const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
    const inicial = els.map((el) => {
      const m = (el.getAttribute('transform') ?? '').match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)/)
      return { el, x: m ? +m[1] : 0, y: m ? +m[2] : 0 }
    })
    const hitX0 = parseFloat(hit.style.left), hitY0 = parseFloat(hit.style.top)
    const boxW = hit.offsetWidth, boxH = hit.offsetHeight
    let sx = e.clientX, sy = e.clientY, accX = 0, accY = 0
    let movido = false
    snapExcluir = nombre
    const onMove = (ev: PointerEvent) => {
      const dxs = ev.clientX - sx, dys = ev.clientY - sy
      if (Math.abs(dxs) + Math.abs(dys) > 3) movido = true
      accX += dxs / k; accY += dys / k
      sx = ev.clientX; sy = ev.clientY
      const base = lienzo.getBoundingClientRect()
      const rawBox: Rect = { left: hitX0 + accX * k, top: hitY0 + accY * k, width: boxW, height: boxH }
      const snap = calcularSnap(rawBox, base)
      const ox = accX + snap.dx / k, oy = accY + snap.dy / k
      for (const it of inicial) it.el.setAttribute('transform', `translate(${it.x + ox} ${it.y + oy})`)
      hit.style.left = rawBox.left + snap.dx + 'px'
      hit.style.top = rawBox.top + snap.dy + 'px'
      dibujarGuias(snap.guias)
    }
    const onUp = () => {
      hit.removeEventListener('pointermove', onMove)
      snapExcluir = null
      limpiarGuias()
      if (movido) construirOverlays() // si fue clic, dejar que abra el editor
    }
    try { hit.setPointerCapture(e.pointerId) } catch { /* sin captura: igual arrastra */ }
    hit.addEventListener('pointermove', onMove)
    hit.addEventListener('pointerup', onUp, { once: true })
    hit.addEventListener('pointercancel', onUp, { once: true })
  })
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
    try { hit.setPointerCapture(e.pointerId) } catch { /* sin captura: igual arrastra */ }
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
  ta.style.left = r.left + 'px'
  ta.style.top = r.top - 1 + 'px'
  ta.style.width = Math.max(m.maxWidthUser * k, 60) + 'px'
  ta.style.color = m.color
  ta.style.caretColor = m.color
  lienzo.appendChild(ta)
  aplicarEstiloTextarea(nombre) // tamaño/peso/cursiva/familia/alineación
  autoCrecer(ta)
  ta.focus()
  ta.setSelectionRange(ta.value.length, ta.value.length)

  editorActivo = { nombre, ta, valorPrevio, tocado: false, els }
  sincronizarBarra(nombre)
  ta.addEventListener('input', () => {
    editorActivo!.tocado = true
    valores[nombre] = ta.value
    autoCrecer(ta)
  })
  ta.addEventListener('blur', (e) => {
    // Si el foco va a la barra de controles (ej. el selector de fuente),
    // NO cerramos el editor: queremos seguir editando ese campo.
    const rt = e.relatedTarget as HTMLElement | null
    if (rt && barraTexto.contains(rt)) return
    commitEditor()
  })
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelarEditor() }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur() }
  })
}

// Aplica el estilo efectivo del campo al textarea (vista en vivo durante la edición).
function aplicarEstiloTextarea(nombre: string): void {
  const ta = document.querySelector<HTMLTextAreaElement>('.editor-text')
  if (!ta || !svgEl) return
  const m = metricas[nombre]
  if (!m) return
  const ef = estiloEfectivo(nombre)
  const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
  ta.style.fontSize = ef.fontSize * k + 'px'
  ta.style.fontWeight = ef.weight
  ta.style.fontStyle = ef.italic ? 'italic' : 'normal'
  ta.style.fontFamily = ef.family
  ta.style.lineHeight = m.lh * (ef.fontSize / m.fontSizeUser) * k + 'px'
  ta.style.textAlign = ef.align === 'middle' ? 'center' : ef.align === 'end' ? 'right' : 'left'
  ta.style.color = ef.color
  ta.style.caretColor = ef.color
  autoCrecer(ta)
}

// Refleja en la barra los valores actuales del campo y la muestra.
function sincronizarBarra(nombre: string): void {
  const ef = estiloEfectivo(nombre)
  btSize.textContent = String(Math.round(ef.fontSize))
  btBold.classList.toggle('activo', ef.weight === '700')
  btItalic.classList.toggle('activo', ef.italic)
  btColor.value = aHex(ef.color)
  btFamily.value = ef.family
  for (const b of Array.from(barraTexto.querySelectorAll('[data-bt^="al:"]'))) {
    b.classList.toggle('activo', b.getAttribute('data-bt') === 'al:' + ef.align)
  }
  barraTexto.hidden = false
}

// Evitar que los botones de la barra roben el foco del textarea (si no, el
// blur cierra el editor y el control no se aplica). El <select> sí debe abrirse.
barraTexto.addEventListener('mousedown', (e) => {
  if (!(e.target as HTMLElement).closest('select')) e.preventDefault()
})

// Controles de la barra (operan sobre el campo en edición).
barraTexto.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('[data-bt]')
  if (!b || !editorActivo) return
  const nombre = editorActivo.nombre
  const bt = b.getAttribute('data-bt')!
  const ef = estiloEfectivo(nombre)
  const est = (estilos[nombre] ??= {})
  if (bt === 'size-') est.fontSize = Math.max(8, Math.round(ef.fontSize) - 4)
  else if (bt === 'size+') est.fontSize = Math.round(ef.fontSize) + 4
  else if (bt.startsWith('al:')) est.align = bt.slice(3) as EstiloCampo['align']
  else if (bt === 'bold') est.bold = ef.weight !== '700'
  else if (bt === 'italic') est.italic = !ef.italic
  aplicarEstiloTextarea(nombre)
  sincronizarBarra(nombre)
  if ((valores[nombre] ?? '').trim()) editorActivo.tocado = true
})
btFamily.addEventListener('change', () => {
  if (!editorActivo) return
  const nombre = editorActivo.nombre
  ;(estilos[nombre] ??= {}).family = btFamily.value
  aplicarEstiloTextarea(nombre)
  if ((valores[nombre] ?? '').trim()) editorActivo.tocado = true
  editorActivo.ta.focus() // volver a editar tras elegir fuente
})
btColor.addEventListener('input', () => {
  if (!editorActivo) return
  const nombre = editorActivo.nombre
  ;(estilos[nombre] ??= {}).color = btColor.value
  aplicarEstiloTextarea(nombre)
  if ((valores[nombre] ?? '').trim()) editorActivo.tocado = true
})

// Convierte "rgb(r,g,b)" o "#rrggbb" a "#rrggbb" para el input de color.
function aHex(color: string): string {
  if (color.startsWith('#')) return color
  const m = color.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
  if (!m) return '#000000'
  const h = (n: string) => (+n).toString(16).padStart(2, '0')
  return '#' + h(m[1]) + h(m[2]) + h(m[3])
}

function autoCrecer(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto'
  ta.style.height = ta.scrollHeight + 'px'
}

function commitEditor(): void {
  if (!editorActivo) return
  barraTexto.hidden = true
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
  barraTexto.hidden = true
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

// Detecta si el canvas tiene algún píxel no totalmente opaco.
function tieneTransparencia(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  try {
    const data = ctx.getImageData(0, 0, w, h).data
    for (let p = 3; p < data.length; p += 4) {
      if (data[p] < 255) return true
    }
  } catch { /* canvas no legible: asumir opaca */ }
  return false
}

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
          // Si la imagen tiene transparencia, guardamos PNG (conserva el alfa);
          // si es opaca, JPEG (más liviano). Antes siempre JPEG → fondo negro.
          const dataUrl = tieneTransparencia(ctx, w, h)
            ? canvas.toDataURL('image/png')
            : canvas.toDataURL('image/jpeg', 0.92)
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
  estilos = {}
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
void (async () => {
  inyectarFontFaces()
  await cargarPack()
  btFamily.innerHTML = familiasDisponibles()
    .map((f) => `<option value="${escAttr(f)}">${escAttr(f)}</option>`)
    .join('')
  await montarPlantilla()
})()
