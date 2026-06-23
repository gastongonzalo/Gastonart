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
  familiaInternaDeFont,
  detectarFormatoCss,
  type FontFace,
} from './font'
import { renderResvg } from './render-resvg'
import polygonClipping from 'polygon-clipping'

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

const rutasPlantilla = Object.keys(plantillas).sort() // mutable: se le suman las plantillas que carga el usuario
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
  bold?: boolean // legado: se sigue leyendo de proyectos viejos
  weight?: number // peso explícito (100–900); tiene prioridad sobre bold
  italic?: boolean
  align?: 'start' | 'middle' | 'end'
  family?: string
  color?: string
  lineHeight?: number // factor sobre el interlineado base (1 = original)
}

// Nombre legible de cada peso para el selector de variantes.
const NOMBRE_PESO: Record<number, string> = {
  100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium',
  600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black',
}

let plantillaActual = rutasPlantilla[0]
// SVG fuente del lienzo actual (plantilla, imagen en blanco o SVG importado).
let svgActual: string = plantillas[plantillaActual]
let facesPack: FontFace[] = []
let valores: Record<string, string> = {}
let estilos: Record<string, EstiloCampo> = {}
let bloqueado: Record<string, boolean> = {} // textos de plantilla nacen bloqueados (no se mueven)
let cajaAlto: Record<string, number> = {} // alto de la caja (user units). Definido ⇒ caja activa (recorta)
// Cada <image> de la plantilla es un hueco de foto editable, identificado por su
// id (data-foto="0","1",…). El estado de foto/encuadre se guarda por id.
let fotos: Record<string, Foto> = {}
let framesFoto: Record<string, FrameFoto> = {}
let encuadres: Record<string, Encuadre> = {}
let fotoActiva: string | null = null // slot al que se sube/cambia la foto
let zoomSlider: HTMLInputElement | null = null

// Ids de los huecos de foto presentes en el SVG montado (en orden del documento).
function idsFoto(): string[] {
  if (!svgEl) return []
  return Array.from(svgEl.querySelectorAll('[data-foto]'))
    .map((e) => e.getAttribute('data-foto'))
    .filter((v): v is string => v != null)
}
function encuadreDe(id: string): Encuadre {
  return (encuadres[id] ??= { zoom: 1, ox: 0, oy: 0 })
}

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

// Pesos cargados para una familia (variantes reales que tenemos para el export).
function pesosDisponibles(family: string): number[] {
  const fam = family.replace(/['"]/g, '').split(',')[0].trim().toLowerCase()
  const pesos = [...new Set(facesPack.filter((f) => f.family.toLowerCase() === fam).map((f) => f.weight))]
  return pesos.length ? pesos.sort((a, b) => a - b) : [400]
}

// (Re)llena el selector de tipografías de la barra de texto.
function poblarFamilias(): void {
  const sel = btFamily.value
  btFamily.innerHTML = familiasDisponibles()
    .map((f) => `<option value="${escAttr(f)}">${escAttr(f)}</option>`)
    .join('')
  if (sel) btFamily.value = sel
}

// Importa una tipografía desde un archivo .ttf/.otf (también .woff/.woff2).
// Se registra para el editor (FontFace API) y para el render resvg (facesPack).
async function importarFont(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const family = familiaInternaDeFont(bytes) || file.name.replace(/\.[^.]+$/, '')
  if (facesPack.some((f) => f.family === family)) {
    estado.textContent = `La tipografía «${family}» ya estaba cargada`
    poblarFamilias(); return
  }
  try {
    const ff = new FontFace(family, bytes)
    await ff.load()
    ;(document as Document & { fonts: FontFaceSet }).fonts.add(ff)
  } catch (e) {
    estado.textContent = '❌ No se pudo cargar la tipografía'
    console.error('[importarFont]', e)
    return
  }
  facesPack.push({ bytes, family, weight: 400, style: 'normal', formato: detectarFormatoCss(bytes) })
  poblarFamilias()
  estado.textContent = `Tipografía agregada: ${family}`
}

// Fuentes populares de Google para el buscador rápido.
const GOOGLE_FONTS_POPULARES = [
  'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Oswald', 'Raleway', 'Poppins', 'Nunito',
  'Inter', 'Work Sans', 'Rubik', 'Barlow', 'Playfair Display', 'Merriweather', 'Bebas Neue',
  'Anton', 'Archivo Black', 'Teko', 'Bangers', 'Pacifico', 'Lobster', 'Dancing Script',
  'Caveat', 'Permanent Marker', 'Abril Fatface', 'Righteous', 'Bungee', 'Shrikhand',
]

// Trae una familia de Google Fonts (regular + bold), la registra para el editor
// (FontFace) y para el export resvg (facesPack como woff2). Devuelve la familia
// cargada, o null si no existe / falló.
// fetch con timeout (aborta si la red cuelga, para no dejar la UI trabada).
async function fetchTimeout(url: string, ms = 12000): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try { return await fetch(url, { signal: ctrl.signal }) }
  finally { clearTimeout(t) }
}

async function traerGoogleFont(familia: string): Promise<string | null> {
  const fam = familia.trim()
  if (!fam) return null
  const ya = facesPack.find((f) => f.family.toLowerCase() === fam.toLowerCase())
  if (ya) { poblarFamilias(); return ya.family }
  // Pedimos todas las variantes; Google devuelve solo las que la fuente tiene.
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam)}:wght@100;200;300;400;500;600;700;800;900&display=swap`
  let css: string
  try {
    const r = await fetchTimeout(url)
    if (!r.ok) return null
    css = await r.text()
  } catch { return null }
  // Google parte la fuente en subsets (latin, cyrillic, greek…). Hay que elegir
  // el LATINO (el único con A-Z, á, ñ); tomar otro deja el texto sin glifos.
  // Para cada peso guardamos la URL del subset latino (o el primero como fallback).
  const porPeso = new Map<number, string>()
  for (const bloque of css.split('@font-face').slice(1)) {
    const um = bloque.match(/url\((https:[^)]+\.woff2)\)/)
    if (!um) continue
    const peso = +(bloque.match(/font-weight:\s*(\d+)/)?.[1] ?? '400')
    const latino = /U\+0000-00FF/i.test(bloque.match(/unicode-range:\s*([^;}]+)/i)?.[1] ?? '')
    if (latino || !porPeso.has(peso)) porPeso.set(peso, um[1])
  }
  // Descargar todas las variantes EN PARALELO (no en secuencia): así tarda lo
  // del peso más lento, no la suma de todos.
  const caras = await Promise.all([...porPeso].map(async ([peso, woff2]) => {
    if (facesPack.some((f) => f.family === fam && f.weight === peso)) return null
    try {
      const bytes = new Uint8Array(await (await fetchTimeout(woff2)).arrayBuffer())
      const ff = new FontFace(fam, bytes, { weight: String(peso) })
      await ff.load()
      return { peso, bytes, ff }
    } catch { return null }
  }))
  let agregada = false
  for (const c of caras) {
    if (!c) continue
    ;(document as Document & { fonts: FontFaceSet }).fonts.add(c.ff)
    facesPack.push({ bytes: c.bytes, family: fam, weight: c.peso, style: 'normal', formato: 'woff2' })
    agregada = true
  }
  if (!agregada && !facesPack.some((f) => f.family.toLowerCase() === fam.toLowerCase())) return null
  recordarFuenteGoogle(fam) // persistir para próximas sesiones
  poblarFamilias()
  return fam
}

// --- Persistencia de fuentes de Google agregadas (se re-bajan al iniciar) ---
const LS_FUENTES = 'gastonart-fuentes-google'
const fuentesGoogle = new Set<string>()
function recordarFuenteGoogle(fam: string): void {
  if (fuentesGoogle.has(fam)) return
  fuentesGoogle.add(fam)
  try { localStorage.setItem(LS_FUENTES, JSON.stringify([...fuentesGoogle])) } catch { /* ignorar */ }
}
// Re-baja (en paralelo) las fuentes de Google que el usuario agregó en sesiones
// anteriores, para que queden disponibles sin volver a buscarlas.
async function cargarFuentesGuardadas(): Promise<void> {
  let lista: string[] = []
  try { const a = JSON.parse(localStorage.getItem(LS_FUENTES) || '[]'); if (Array.isArray(a)) lista = a.filter((x) => typeof x === 'string') } catch { /* ignorar */ }
  if (!lista.length) return
  await Promise.all(lista.map((fam) => traerGoogleFont(fam)))
  // Si ya hay una plantilla montada, re-evaluar y repintar con las fuentes recién cargadas.
  if (svgEl) { void revisarFuentes(); await refrescarTrasFuente() }
}

// Tras cargar una fuente nueva: re-medir y repintar los campos (la fuente cambia
// las métricas). Los textos no editados reflowean solos al cargar la fuente.
async function refrescarTrasFuente(): Promise<void> {
  if (!svgEl) return
  // No bloquear indefinidamente si document.fonts.ready no resuelve.
  await Promise.race([
    (document as Document & { fonts: FontFaceSet }).fonts.ready,
    new Promise((res) => setTimeout(res, 4000)),
  ])
  calcularMetricas()
  for (const nombre of Object.keys(valores)) if (valores[nombre] && metricas[nombre]) pintarCampo(nombre)
  construirOverlays()
}

// Familias declaradas en el SVG que no están disponibles para el export (resvg).
// Toma el último nombre de cada lista (el fallback real, ej. "Oswald-Bold, Oswald").
function fuentesFaltantes(svg: string): string[] {
  const decls = new Set<string>()
  for (const m of svg.matchAll(/font-family\s*:\s*([^;}"]+)/gi)) decls.add(m[1])
  for (const m of svg.matchAll(/font-family\s*=\s*["']([^"']+)["']/gi)) decls.add(m[1])
  const faltan = new Set<string>()
  for (const decl of decls) {
    const nombres = decl.split(',').map((s) => s.replace(/['"]/g, '').trim()).filter(Boolean)
    const fam = nombres[nombres.length - 1]
    if (!fam || /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(fam)) continue
    if (!facesPack.some((f) => f.family.toLowerCase() === fam.toLowerCase())) faltan.add(fam)
  }
  return [...faltan]
}

// Estilo efectivo de un campo = base (métrica) + overrides del usuario.
function estiloEfectivo(nombre: string): {
  fontSize: number; weight: string; italic: boolean; family: string; align: 'start' | 'middle' | 'end'; color: string; manual: boolean; lineHeight: number
} {
  const m = metricas[nombre]
  const e = estilos[nombre] ?? {}
  return {
    fontSize: e.fontSize ?? m.fontSizeUser,
    weight: String(e.weight ?? (e.bold ? 700 : m.weight)),
    italic: !!e.italic,
    family: (e.family ?? m.family).replace(/['"]/g, '').split(',')[0].trim(),
    align: e.align ?? 'start',
    color: e.color ?? m.color,
    manual: e.fontSize != null,
    lineHeight: e.lineHeight ?? 1,
  }
}

// ---------------------------------------------------------------
//  UI base
// ---------------------------------------------------------------
const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <header class="topbar">
    <div class="tb-marca">
      <strong>GastonART</strong>
      <label>Plantilla
        <select id="sel-plantilla">
          ${rutasPlantilla.map((r) => `<option value="${escAttr(r)}">${escAttr(nombreCorto(r))}</option>`).join('')}
        </select>
      </label>
      <button id="btn-tamano" class="mini" title="Cambiar el tamaño de la mesa de trabajo">📐 Tamaño</button>
    </div>
    <span class="estado" id="estado"></span>
    <div class="tb-acciones">
      <button id="btn-deshacer" class="mini" title="Deshacer (Ctrl+Z)" disabled>↶</button>
      <button id="btn-rehacer" class="mini" title="Rehacer (Ctrl+Y)" disabled>↷</button>
      <span class="tb-div"></span>
      <button id="btn-copiar" class="mini" title="Copiar elemento seleccionado (Ctrl+C)" disabled>⧉ Copiar</button>
      <button id="btn-pegar" class="mini" title="Pegar (Ctrl+V)" disabled>📋 Pegar</button>
      <span class="tb-div"></span>
      <button id="btn-import-font" class="mini" title="Importar tipografía (.ttf / .otf)">+ Aa</button>
      <button id="btn-guardar" class="mini">💾 Guardar</button>
      <button id="btn-cargar" class="mini">📂 Cargar</button>
      <button id="btn-guardar-plantilla" class="mini" title="Guardar el lienzo actual como plantilla reutilizable">🗂 Plantilla</button>
      <button id="btn-nuevo" class="mini">Nuevo</button>
      <button id="btn-export">⬇ Exportar PNG</button>
    </div>
  </header>
  <input type="file" id="in-proyecto" accept=".json,application/json" hidden>

  <div id="barra-texto" class="barra-formato" hidden>
    <span class="bt-label">Texto</span>
    <select id="bt-family" title="Tipografía"></select>
    <select id="bt-weight" title="Variante / peso"></select>
    <button id="bt-gfonts" class="mini" title="Buscar y agregar una fuente de Google Fonts">🔤 Google</button>
    <span class="bt-sep"></span>
    <button data-bt="size-" title="Achicar">A−</button>
    <span id="bt-size" class="bt-val">–</span>
    <button data-bt="size+" title="Agrandar">A+</button>
    <span class="bt-sep"></span>
    <button data-bt="bold" id="bt-bold" title="Negrita"><b>N</b></button>
    <button data-bt="italic" id="bt-italic" title="Cursiva"><i>C</i></button>
    <label class="bt-color" title="Color"><input type="color" id="bt-color"></label>
    <span class="bt-sep"></span>
    <button data-bt="al:start" title="Alinear a la izquierda">⯇</button>
    <button data-bt="al:middle" title="Centrar">≡</button>
    <button data-bt="al:end" title="Alinear a la derecha">⯈</button>
    <span class="bt-sep"></span>
    <button data-bt="lh-" title="Menos interlineado">↕−</button>
    <span id="bt-lh" class="bt-val" title="Interlineado">–</span>
    <button data-bt="lh+" title="Más interlineado">↕+</button>
  </div>

  <div id="aviso-fuentes" hidden></div>

  <div id="panel-gfonts" hidden>
    <div class="pg-head">
      <strong>Agregar fuente de Google Fonts</strong>
      <button id="pg-cerrar" class="mini" title="Cerrar">✕</button>
    </div>
    <div class="pg-buscar">
      <input id="pg-input" type="text" placeholder="Nombre de la fuente (ej. Oswald)" autocomplete="off">
      <button id="pg-traer" class="ini-btn-acc">Agregar</button>
    </div>
    <div id="pg-estado" class="pg-estado"></div>
    <div class="pg-pop-tit">Populares</div>
    <div id="pg-populares" class="pg-populares"></div>
  </div>

  <div id="panel-iconos" hidden>
    <div class="pg-head">
      <strong>Íconos, formas y vectores</strong>
      <button id="pi-cerrar" class="mini" title="Cerrar">✕</button>
    </div>
    <div class="pg-buscar">
      <input id="pi-input" type="text" placeholder="Buscar (inglés): heart, arrow, home, star…" autocomplete="off">
      <button id="pi-buscar" class="ini-btn-acc">Buscar</button>
    </div>
    <div id="pi-estado" class="pg-estado"></div>
    <div id="pi-grid" class="pi-grid"></div>
  </div>

  <div id="panel-imagen" hidden>
    <div class="pg-head">
      <strong>Agregar imagen</strong>
      <button id="pm-cerrar" class="mini" title="Cerrar">✕</button>
    </div>
    <button id="pm-subir" class="ini-btn-acc pm-subir">⬆ Subir desde el dispositivo</button>
    <div class="pm-sep">o buscá en el banco de imágenes libres</div>
    <div class="pg-buscar">
      <input id="pm-input" type="text" placeholder="Buscar (inglés): mountain, city, people…" autocomplete="off">
      <button id="pm-buscar" class="ini-btn-acc">Buscar</button>
    </div>
    <div id="pm-estado" class="pg-estado"></div>
    <div id="pm-grid" class="pi-grid"></div>
  </div>

  <div id="panel-tamano" hidden>
    <div class="pg-head">
      <strong>Tamaño de la mesa</strong>
      <button id="pt-cerrar" class="mini" title="Cerrar">✕</button>
    </div>
    <div id="pt-presets" class="pt-presets"></div>
    <div class="pt-custom">
      <input id="pt-w" type="number" min="16" max="8000" aria-label="Ancho"> ×
      <input id="pt-h" type="number" min="16" max="8000" aria-label="Alto"> px
      <button id="pt-aplicar" class="ini-btn-acc">Aplicar</button>
    </div>
    <div class="pt-nota">Cambia el tamaño de la placa actual. El contenido queda en su lugar.</div>
  </div>

  <div class="cuerpo">
    <nav class="toolbar-izq" aria-label="Insertar elementos">
      <button id="btn-add-texto" class="herr" title="Agregar texto"><span class="herr-ic">T</span><span>Texto</span></button>
      <button id="btn-add-img" class="herr" title="Agregar imagen"><span class="herr-ic">▣</span><span>Imagen</span></button>
      <span class="add-wrap">
        <button id="btn-add-figura" class="herr" title="Agregar figura"><span class="herr-ic">▢</span><span>Figura</span></button>
        <div id="menu-figura" class="menu-pop menu-figs" hidden></div>
      </span>
      <button id="btn-add-icono" class="herr" title="Agregar ícono / forma / vector"><span class="herr-ic">★</span><span>Ícono</span></button>
      <button id="btn-pluma" class="herr" title="Pluma (puntos de ancla)"><span class="herr-ic">✒</span><span>Pluma</span></button>
      <button id="btn-grafico" class="herr" title="Seleccionar y editar vectores/imágenes de la plantilla"><span class="herr-ic">✦</span><span>Gráficos</span></button>
    </nav>
    <div id="escenario">
      <div id="lienzo"></div>
      <div id="vista-carrusel" hidden></div>
    </div>
  </div>
  <div id="zoom-ctrl">
    <button id="zoom-menos" title="Alejar (Ctrl −)">−</button>
    <button id="zoom-val" title="Restablecer a 100%">100%</button>
    <button id="zoom-mas" title="Acercar (Ctrl +)">+</button>
    <button id="zoom-fit" title="Ajustar a la vista">⤢</button>
  </div>
  <div id="tira-mesas"></div>
  <input type="file" id="in-foto" accept="image/*" hidden>
  <input type="file" id="in-img-nueva" accept="image/*" hidden>
  <input type="file" id="in-font" accept=".ttf,.otf,.woff,.woff2,font/*" multiple hidden>
  <input type="file" id="in-svg-plantilla" accept=".svg,image/svg+xml" hidden>

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
const btLh = document.querySelector<HTMLSpanElement>('#bt-lh')!
const btBold = document.querySelector<HTMLButtonElement>('#bt-bold')!
const btItalic = document.querySelector<HTMLButtonElement>('#bt-italic')!
const btFamily = document.querySelector<HTMLSelectElement>('#bt-family')!
const btWeight = document.querySelector<HTMLSelectElement>('#bt-weight')!
const btColor = document.querySelector<HTMLInputElement>('#bt-color')!
document.querySelector('#pe-cerrar')!.addEventListener('click', () => { panelExport.hidden = true })
document.querySelector('#btn-add-texto')!.addEventListener('click', () => agregarTexto())
document.querySelector('#btn-add-img')!.addEventListener('click', (e) => { e.stopPropagation(); abrirPanelImagen() })
const menuFigura = document.querySelector<HTMLDivElement>('#menu-figura')!
// Tipos de figura disponibles (orden del selector).
const TIPOS_FIGURA = [
  'rect', 'redondeado', 'circulo', 'triangulo', 'rombo', 'pentagono', 'hexagono',
  'octagono', 'estrella', 'estrella6', 'corazon', 'rayo', 'flecha', 'linea',
]
// Poblar el popover con un preview de cada figura.
for (const tipo of TIPOS_FIGURA) {
  const b = document.createElement('button'); b.dataset.fig = tipo; b.title = tipo
  const svg = document.createElementNS(SVGNS, 'svg')
  svg.setAttribute('viewBox', '-1 -1 26 26'); svg.setAttribute('width', '22'); svg.setAttribute('height', '22')
  svg.appendChild(crearFiguraEl(tipo, 24).el)
  b.appendChild(svg)
  b.addEventListener('click', () => { insertarFigura(tipo); menuFigura.hidden = true })
  menuFigura.appendChild(b)
}
// Cierra los paneles flotantes (Figura, Íconos, Imagen, Google Fonts) excepto uno.
function cerrarPanelesFlotantes(excepto?: Element): void {
  for (const sel of ['#menu-figura', '#panel-iconos', '#panel-imagen', '#panel-gfonts', '#panel-tamano']) {
    const p = document.querySelector<HTMLElement>(sel)
    if (p && p !== excepto) {
      // Soltar el foco del input de búsqueda (si no, su cursor sigue parpadeando).
      if (p.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
      p.hidden = true
    }
  }
}
document.querySelector('#btn-add-figura')!.addEventListener('click', (e) => {
  e.stopPropagation()
  const abrir = menuFigura.hidden
  cerrarPanelesFlotantes()
  menuFigura.hidden = !abrir
})

// --- Panel de íconos / formas / vectores (Iconify + favoritos empaquetados) ---
const panelIconos = document.querySelector<HTMLDivElement>('#panel-iconos')!
const piInput = document.querySelector<HTMLInputElement>('#pi-input')!
const piEstado = document.querySelector<HTMLDivElement>('#pi-estado')!
const piGrid = document.querySelector<HTMLDivElement>('#pi-grid')!

function mostrarIconosFavoritos(): void {
  piGrid.innerHTML = ''
  for (const raw of Object.values(iconosPack)) {
    const b = document.createElement('button'); b.className = 'pi-item'; b.innerHTML = raw
    const svg = b.querySelector('svg'); if (svg) { svg.setAttribute('stroke', '#e6edf6') }
    b.addEventListener('click', () => insertarIcono(raw))
    piGrid.appendChild(b)
  }
}
// Diccionario español→inglés para el buscador (los nombres de Iconify son en inglés).
const DIC_ICONOS: Record<string, string> = {
  corazon: 'heart', flecha: 'arrow', casa: 'home', hogar: 'home', estrella: 'star',
  usuario: 'user', persona: 'user', gente: 'users', buscar: 'search', busqueda: 'search',
  ajustes: 'settings', configuracion: 'settings', engranaje: 'settings', basura: 'trash',
  eliminar: 'trash', borrar: 'trash', editar: 'edit', lapiz: 'pencil', descargar: 'download',
  subir: 'upload', archivo: 'file', carpeta: 'folder', calendario: 'calendar', fecha: 'calendar',
  reloj: 'clock', hora: 'clock', campana: 'bell', notificacion: 'bell', correo: 'mail',
  email: 'mail', sobre: 'mail', candado: 'lock', bloqueo: 'lock', ojo: 'eye', camara: 'camera',
  foto: 'photo', imagen: 'image', musica: 'music', nota: 'music', telefono: 'phone',
  llamada: 'phone', carrito: 'shopping-cart', compra: 'shopping-cart', dinero: 'cash',
  plata: 'cash', tarjeta: 'credit-card', mapa: 'map', ubicacion: 'map-pin', pin: 'map-pin',
  bandera: 'flag', etiqueta: 'tag', fuego: 'flame', rayo: 'bolt', sol: 'sun', luna: 'moon',
  nube: 'cloud', lluvia: 'cloud-rain', tilde: 'check', check: 'check', cruz: 'x', equis: 'x',
  mas: 'plus', menos: 'minus', menu: 'menu', compartir: 'share', megusta: 'thumb-up',
  pulgar: 'thumb-up', premio: 'award', medalla: 'medal', regalo: 'gift', mensaje: 'message',
  chat: 'message-circle', wifi: 'wifi', bateria: 'battery', libro: 'book', pincel: 'brush',
  paleta: 'palette', tijera: 'scissors', llave: 'key', escudo: 'shield', candidato: 'user',
  globo: 'globe', mundo: 'world', avion: 'plane', auto: 'car', coche: 'car', bici: 'bike',
  bicicleta: 'bike', trofeo: 'trophy', voto: 'check', urna: 'box', verificado: 'badge-check',
  whatsapp: 'brand-whatsapp', instagram: 'brand-instagram', facebook: 'brand-facebook',
  twitter: 'brand-twitter', youtube: 'brand-youtube', tiktok: 'brand-tiktok',
  linkedin: 'brand-linkedin', telegram: 'brand-telegram', flechaderecha: 'arrow-right',
  flechaizquierda: 'arrow-left', flechaarriba: 'arrow-up', flechaabajo: 'arrow-down',
  comillas: 'quote', cita: 'quote', play: 'player-play', pausa: 'player-pause',
  reproducir: 'player-play', detener: 'player-stop', siguiente: 'player-track-next',
  anterior: 'player-track-prev', volumen: 'volume', silencio: 'volume-off', micro: 'microphone',
  microfono: 'microphone', auriculares: 'headphones', altavoz: 'speakerphone', video: 'video',
  pantalla: 'device-desktop', computadora: 'device-desktop', compu: 'device-desktop',
  celular: 'device-mobile', notebook: 'device-laptop', impresora: 'printer', enlace: 'link',
  link: 'link', adjuntar: 'paperclip', clip: 'paperclip', copiar: 'copy', pegar: 'clipboard',
  cortar: 'cut', imprimir: 'printer', refrescar: 'refresh', recargar: 'refresh', actualizar: 'refresh',
  filtro: 'filter', ordenar: 'sort-ascending', lista: 'list', cuadricula: 'grid-dots',
  tabla: 'table', grafico: 'chart-bar', estadistica: 'chart-line', torta: 'chart-pie',
  moneda: 'coin', banco: 'building-bank', pago: 'credit-card', precio: 'tag', oferta: 'discount',
  descuento: 'discount', bolsa: 'shopping-bag', tienda: 'building-store', negocio: 'building-store',
  maletin: 'briefcase', trabajo: 'briefcase', empresa: 'building', edificio: 'building',
  fabrica: 'building-factory', hospital: 'building-hospital', escuela: 'school', cafe: 'coffee',
  comida: 'tools-kitchen-2', restaurante: 'tools-kitchen-2', pizza: 'pizza', cerveza: 'beer',
  vino: 'glass-full', cumpleanos: 'cake', fiesta: 'confetti', guitarra: 'guitar-pick',
  deporte: 'ball-football', futbol: 'ball-football', pelota: 'ball-basketball', correr: 'run',
  nadar: 'swimming', gimnasio: 'barbell', salud: 'heartbeat', medico: 'stethoscope',
  pastilla: 'pill', virus: 'virus', mascarilla: 'mask', termometro: 'temperature',
  perro: 'dog', gato: 'cat', planta: 'plant', arbol: 'tree', flor: 'flower', hoja: 'leaf',
  agua: 'droplet', gota: 'droplet', viento: 'wind', nieve: 'snowflake', votar: 'checkbox',
  politica: 'building-bank', megafono: 'speakerphone', anuncio: 'speakerphone', noticias: 'news',
  periodico: 'news', radio: 'radio', tv: 'device-tv', brujula: 'compass', ancla: 'anchor',
  barco: 'sailboat', tren: 'train', colectivo: 'bus', bus: 'bus', taxi: 'car', moto: 'motorbike',
  camion: 'truck', envio: 'truck-delivery', paquete: 'package', caja: 'box', maleta: 'luggage',
  cohete: 'rocket', planeta: 'planet', idea: 'bulb', foco: 'bulb', bombilla: 'bulb',
  cerebro: 'brain', objetivo: 'target', meta: 'target', alerta: 'alert-triangle',
  peligro: 'alert-triangle', info: 'info-circle', pregunta: 'help-circle', ayuda: 'help-circle',
  error: 'alert-circle', exito: 'circle-check', correcto: 'circle-check', mano: 'hand-stop',
  dedo: 'pointer', emoji: 'mood-smile', sonrisa: 'mood-smile', triste: 'mood-sad',
  enojo: 'mood-angry', cara: 'mood-smile', pulgararriba: 'thumb-up', pulgarabajo: 'thumb-down',
}
function traducirBusqueda(q: string): string {
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const todo = norm(q.trim().replace(/\s+/g, ''))
  if (DIC_ICONOS[todo]) return DIC_ICONOS[todo]
  // por palabra: traducir las que estén en el diccionario
  return q.trim().split(/\s+/).map((w) => DIC_ICONOS[norm(w)] ?? w).join(' ')
}

async function buscarIconos(q: string): Promise<void> {
  q = q.trim()
  if (!q) { piEstado.textContent = 'Favoritos'; mostrarIconosFavoritos(); return }
  const consulta = traducirBusqueda(q)
  piEstado.textContent = 'Buscando…'; piGrid.innerHTML = ''
  let iconos: string[] = []
  try {
    const data = await (await fetchTimeout(`https://api.iconify.design/search?query=${encodeURIComponent(consulta)}&limit=120`)).json()
    iconos = (data as { icons?: string[] }).icons ?? []
  } catch { piEstado.textContent = 'No se pudo buscar (¿sin conexión?)'; return }
  if (!iconos.length) { piEstado.textContent = `Sin resultados para «${q}»`; return }
  piEstado.textContent = `${iconos.length} resultado(s)`
  for (const nombre of iconos) {
    const b = document.createElement('button'); b.className = 'pi-item'; b.title = nombre
    const img = document.createElement('img')
    img.src = `https://api.iconify.design/${nombre}.svg?height=26&color=%23e6edf6`
    img.loading = 'lazy'; img.alt = nombre
    b.appendChild(img)
    b.addEventListener('click', () => void insertarIconoIconify(nombre))
    piGrid.appendChild(b)
  }
}
async function insertarIconoIconify(nombre: string): Promise<void> {
  piEstado.textContent = `Agregando ${nombre}…`
  try {
    const raw = await (await fetchTimeout(`https://api.iconify.design/${nombre}.svg`)).text()
    insertarIcono(raw)
    piEstado.textContent = `✓ ${nombre}`
  } catch { piEstado.textContent = 'No se pudo agregar el ícono' }
}
document.querySelector('#btn-add-icono')!.addEventListener('click', (e) => {
  e.stopPropagation()
  cerrarPanelesFlotantes(panelIconos)
  panelIconos.hidden = false
  if (!piGrid.childElementCount) { piEstado.textContent = 'Favoritos'; mostrarIconosFavoritos() }
  piInput.focus()
})
document.querySelector('#pi-cerrar')!.addEventListener('click', () => { panelIconos.hidden = true })
document.querySelector('#pi-buscar')!.addEventListener('click', () => void buscarIconos(piInput.value))
piInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void buscarIconos(piInput.value) })
panelIconos.addEventListener('click', (e) => e.stopPropagation())

// --- Panel de imagen: subir del dispositivo o banco de imágenes libres (Openverse) ---
const panelImagen = document.querySelector<HTMLDivElement>('#panel-imagen')!
const pmInput = document.querySelector<HTMLInputElement>('#pm-input')!
const pmEstado = document.querySelector<HTMLDivElement>('#pm-estado')!
const pmGrid = document.querySelector<HTMLDivElement>('#pm-grid')!
function abrirPanelImagen(): void {
  cerrarPanelesFlotantes(panelImagen)
  panelImagen.hidden = false
  pmInput.focus()
}
async function buscarImagenes(q: string): Promise<void> {
  q = q.trim()
  if (!q) return
  const consulta = traducirBusqueda(q)
  pmEstado.textContent = 'Buscando…'; pmGrid.innerHTML = ''
  let resultados: { id: string; thumbnail?: string; title?: string }[] = []
  try {
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(consulta)}&page_size=20`
    const data = await (await fetchTimeout(url)).json()
    resultados = (data as { results?: typeof resultados }).results ?? []
  } catch { pmEstado.textContent = 'No se pudo buscar (¿sin conexión?)'; return }
  const conThumb = resultados.filter((r) => r.thumbnail)
  if (!conThumb.length) { pmEstado.textContent = `Sin resultados para «${q}»`; return }
  pmEstado.textContent = `${conThumb.length} imágenes`
  for (const r of conThumb) {
    const b = document.createElement('button'); b.className = 'pi-item pm-item'; b.title = r.title ?? ''
    const img = document.createElement('img'); img.src = r.thumbnail!; img.loading = 'lazy'; img.alt = r.title ?? ''
    b.appendChild(img)
    b.addEventListener('click', () => void agregarImagenBanco(r.thumbnail!))
    pmGrid.appendChild(b)
  }
}
async function agregarImagenBanco(url: string): Promise<void> {
  pmEstado.textContent = 'Agregando imagen…'
  try {
    const blob = await (await fetchTimeout(url)).blob()
    const foto = await leerFoto(new File([blob], 'banco', { type: blob.type || 'image/jpeg' }))
    insertarImagen(foto)
    panelImagen.hidden = true
    estado.textContent = 'Imagen agregada desde el banco'
  } catch { pmEstado.textContent = 'No se pudo agregar la imagen' }
}
document.querySelector('#pm-subir')!.addEventListener('click', () => { panelImagen.hidden = true; inImgNueva.click() })
document.querySelector('#pm-cerrar')!.addEventListener('click', () => { panelImagen.hidden = true })
document.querySelector('#pm-buscar')!.addEventListener('click', () => void buscarImagenes(pmInput.value))
pmInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void buscarImagenes(pmInput.value) })
panelImagen.addEventListener('click', (e) => e.stopPropagation())

// --- Panel de tamaño de mesa ---
const panelTamano = document.querySelector<HTMLDivElement>('#panel-tamano')!
const ptW = document.querySelector<HTMLInputElement>('#pt-w')!
const ptH = document.querySelector<HTMLInputElement>('#pt-h')!
function poblarPresetsTamano(): void {
  const cont = document.querySelector<HTMLDivElement>('#pt-presets')!
  if (cont.childElementCount) return
  for (const p of PRESETS_TAMANO) {
    const b = document.createElement('button'); b.className = 'pt-preset'
    b.innerHTML = `<span class="pt-preset-nom">${escAttr(p.nombre)}</span><span class="pt-preset-dim">${p.w}×${p.h}</span>`
    b.addEventListener('click', () => { ptW.value = String(p.w); ptH.value = String(p.h); redimensionarMesa(p.w, p.h) })
    cont.appendChild(b)
  }
}
function clampDim(v: number): number { return Math.max(16, Math.min(8000, Math.round(v) || 16)) }
document.querySelector('#btn-tamano')!.addEventListener('click', (e) => {
  e.stopPropagation()
  const abrir = panelTamano.hidden
  cerrarPanelesFlotantes(panelTamano)
  if (abrir && svgEl) {
    poblarPresetsTamano()
    ptW.value = String(Math.round(svgEl.viewBox.baseVal.width)); ptH.value = String(Math.round(svgEl.viewBox.baseVal.height))
  }
  panelTamano.hidden = !abrir
})
document.querySelector('#pt-cerrar')!.addEventListener('click', () => { panelTamano.hidden = true })
document.querySelector('#pt-aplicar')!.addEventListener('click', () => {
  redimensionarMesa(clampDim(+ptW.value), clampDim(+ptH.value))
})
panelTamano.addEventListener('click', (e) => e.stopPropagation())
document.querySelector('#btn-pluma')!.addEventListener('click', (e) => {
  e.stopPropagation()
  if (modoGrafico) desactivarGrafico()
  if (plumaActiva) desactivarPluma()
  else activarPluma()
})
document.querySelector('#btn-grafico')!.addEventListener('click', (e) => {
  e.stopPropagation()
  if (modoGrafico) desactivarGrafico()
  else activarGrafico()
})
// Cerrar los paneles flotantes al hacer clic fuera de ellos (si no, el input de
// búsqueda queda con foco y su cursor parpadea arriba a la izquierda). Se excluye
// cada panel y su botón disparador para no cerrarlos en el mismo clic que los abre.
const SEL_PANELES = '#menu-figura, #panel-iconos, #panel-imagen, #panel-gfonts, #panel-tamano'
const SEL_DISPARADORES = '#btn-add-figura, #btn-add-icono, #btn-add-img, #btn-tamano, #bt-gfonts'
document.addEventListener('pointerdown', (e) => {
  const t = e.target as Element | null
  if (!t || t.closest(SEL_PANELES) || t.closest(SEL_DISPARADORES)) return
  cerrarPanelesFlotantes()
}, true)
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

const inFont = document.querySelector<HTMLInputElement>('#in-font')!
document.querySelector<HTMLButtonElement>('#btn-import-font')!.addEventListener('click', () => inFont.click())
inFont.addEventListener('change', async () => {
  for (const file of Array.from(inFont.files ?? [])) await importarFont(file)
  inFont.value = ''
})

// --- Panel de Google Fonts ---
const panelGfonts = document.querySelector<HTMLDivElement>('#panel-gfonts')!
const pgInput = document.querySelector<HTMLInputElement>('#pg-input')!
const pgEstado = document.querySelector<HTMLDivElement>('#pg-estado')!
function abrirGfonts(): void {
  cerrarPanelesFlotantes(panelGfonts)
  panelGfonts.hidden = false
  pgEstado.textContent = ''
  const cont = document.querySelector<HTMLDivElement>('#pg-populares')!
  cont.innerHTML = ''
  for (const fam of GOOGLE_FONTS_POPULARES) {
    const b = document.createElement('button')
    b.className = 'pg-chip'; b.textContent = fam; b.style.fontFamily = `'${fam}'`
    b.addEventListener('click', () => { void agregarGfont(fam) })
    cont.appendChild(b)
  }
  // precargar las populares para que el chip se vea con su fuente
  const link = document.createElement('link'); link.rel = 'stylesheet'
  link.href = 'https://fonts.googleapis.com/css2?' + GOOGLE_FONTS_POPULARES.map((f) => 'family=' + encodeURIComponent(f)).join('&') + '&display=swap'
  document.head.appendChild(link)
  pgInput.value = ''; pgInput.focus()
}
async function agregarGfont(fam: string): Promise<void> {
  pgEstado.textContent = `Trayendo «${fam}»…`
  const ok = await traerGoogleFont(fam)
  if (!ok) { pgEstado.textContent = `No se encontró «${fam}» en Google Fonts.`; return }
  await refrescarTrasFuente()
  if (editorActivo) { (estilos[editorActivo.nombre] ??= {}).family = ok; aplicarEstiloTextarea(editorActivo.nombre); marcarCampoEditado(); btFamily.value = ok }
  revisarFuentes()
  pgEstado.textContent = `✓ «${ok}» agregada.`
  estado.textContent = `Fuente agregada: ${ok}`
}
document.querySelector('#bt-gfonts')!.addEventListener('mousedown', (e) => e.preventDefault()) // no robar foco del editor
document.querySelector('#bt-gfonts')!.addEventListener('click', () => abrirGfonts())
document.querySelector('#pg-cerrar')!.addEventListener('click', () => { panelGfonts.hidden = true })
document.querySelector('#pg-traer')!.addEventListener('click', () => { if (pgInput.value.trim()) void agregarGfont(pgInput.value.trim()) })
pgInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && pgInput.value.trim()) void agregarGfont(pgInput.value.trim()) })

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

// Detecta las fuentes que la plantilla usa y NO tenemos en facesPack, intenta
// bajarlas SOLAS desde Google (silencioso, así quedan en el sistema y el export
// las usa) y solo muestra el aviso para las que no estén en Google.
const avisoFuentes = document.querySelector<HTMLDivElement>('#aviso-fuentes')!
let revisandoFuentes = false
async function revisarFuentes(): Promise<void> {
  if (revisandoFuentes) return
  const faltan = fuentesFaltantes(svgActual)
  if (!faltan.length) { avisoFuentes.hidden = true; return }
  // Intentar resolverlas automáticamente desde Google Fonts.
  revisandoFuentes = true
  let noHay: string[] = faltan
  try {
    const res = await Promise.all(faltan.map((fam) => traerGoogleFont(fam).then((ok) => ({ fam, ok }))))
    if (res.some((r) => r.ok)) await refrescarTrasFuente()
    noHay = res.filter((r) => !r.ok).map((r) => r.fam)
  } catch (e) { console.error('[revisarFuentes]', e) }
  finally { revisandoFuentes = false }
  if (!noHay.length) { avisoFuentes.hidden = true; return }
  // Las que no están en Google: avisar para importarlas a mano (no hay descarga).
  avisoFuentes.innerHTML =
    `<span>⚠ Falta${noHay.length > 1 ? 'n' : ''} la fuente${noHay.length > 1 ? 's' : ''}: <strong>${noHay.map(escAttr).join(', ')}</strong> — no está${noHay.length > 1 ? 'n' : ''} en Google Fonts, importala${noHay.length > 1 ? 's' : ''} con 🔤</span>` +
    `<button id="av-cerrar" class="mini" title="Ignorar">✕</button>`
  avisoFuentes.hidden = false
  avisoFuentes.querySelector('#av-cerrar')!.addEventListener('click', () => { avisoFuentes.hidden = true })
}

// ---------------------------------------------------------------
//  Montaje de la plantilla
// ---------------------------------------------------------------
async function montarPlantilla(): Promise<void> {
  cerrarEditor()
  if (modoGrafico) desactivarGrafico()
  const prep = prepararEditor(svgActual)
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

  // Marco visible de cada foto (máscara de recorte ∩ placa) — base del encuadre.
  framesFoto = {}
  for (const id of idsFoto()) framesFoto[id] = frameVisibleUser(id) ?? prep.frames[id]

  // Foto del usuario por hueco (si hay), con su encuadre.
  for (const id of idsFoto()) {
    const f = fotos[id], fr = framesFoto[id]
    if (f && fr) {
      const enc = encuadreDe(id)
      const c = aplicarFotoDom(svgEl!, id, f, fr, enc)
      enc.ox = c.ox; enc.oy = c.oy
    }
  }

  await document.fonts.ready
  calcularMetricas()

  // Aplicar valores ya cargados (normalmente vacío al cambiar de plantilla).
  for (const nombre of Object.keys(valores)) {
    if (valores[nombre] && metricas[nombre]) pintarCampo(nombre)
  }

  suprimirHistorial = true
  construirOverlays()
  suprimirHistorial = false
  reiniciarHistorial() // nueva placa = historial nuevo
  estado.textContent = `${camposActuales.length} campo(s) · ${hayImagen(svgActual) ? 'foto editable' : 'sin foto'} · pasá el mouse y hacé clic`
  revisarFuentes() // avisar si la plantilla usa fuentes que no tenemos
  aplicarZoom() // fijar el ancho del lienzo según el zoom actual
  iniciarMesas() // un montaje fresco = proyecto de una sola mesa
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
    // Líneas reales (agrupando tspans kerneados por baseline) y su ANCHO NATURAL
    // (lo que va a usar el textarea y el render reconstruido). Medir cada tspan
    // suelto daba un maxWidthUser = ancho de un carácter en texto kerneado.
    const fsUser = parseFloat(cs.fontSize) || 16
    textoMedidor.style.fontFamily = cs.fontFamily || "'Poppins'"
    textoMedidor.style.fontWeight = cs.fontWeight || '400'
    textoMedidor.style.fontStyle = cs.fontStyle || 'normal'
    textoMedidor.style.fontSize = fsUser + 'px'
    const lineas = lineasDeNodos(els).filter((l) => l.trim() !== '')
    const usarLineas = lineas.length ? lineas : ['']
    const anchos = usarLineas.map((ln) => {
      textoMedidor.textContent = ln || ' '
      try { return textoMedidor.getComputedTextLength() } catch { return 0 }
    })

    metricas[c.nombre] = {
      lh: metaActual[c.nombre].lh,
      x: metaActual[c.nombre].x,
      y: metaActual[c.nombre].y,
      fontSizeUser: fsUser,
      weight: cs.fontWeight || '400',
      family: cs.fontFamily || "'Poppins'",
      color: cs.fill && cs.fill !== 'none' ? cs.fill : '#111',
      maxWidthUser: Math.max(...anchos, 1),
      boxLines: usarLineas.length,
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
  // Auto-achica hasta 50% para que el texto entre en las líneas de la caja
  // antes de tener que recortar.
  let ultimo = { lineas: envolver(texto, m, 1), escala: 1 }
  for (let escala = 1; escala >= 0.5; escala = +(escala - 0.05).toFixed(2)) {
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
  const lhBase = m.lh * (ef.fontSize / m.fontSizeUser) * ef.lineHeight // interlineado escalado + factor del usuario
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
function frameVisibleUser(id: string): FrameFoto | null {
  if (!svgEl) return null
  const img = svgEl.querySelector(`[data-foto="${id}"]`)
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
function rectFotoVisible(img: Element, base: DOMRect): Rect | null {
  const id = img.getAttribute('data-foto')
  const fr = id != null ? framesFoto[id] : null
  if (!svgEl || !fr) return null
  const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
  const svgRect = svgEl.getBoundingClientRect()
  return {
    left: svgRect.left - base.left + fr.x * k,
    top: svgRect.top - base.top + fr.y * k,
    width: fr.w * k,
    height: fr.h * k,
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
// Puntos de un polígono regular de n lados inscrito en el box S (centrado).
function ptsPoligono(n: number, S: number, rotDeg = -90): string {
  const c = S / 2, r = S / 2, pts: string[] = []
  for (let i = 0; i < n; i++) {
    const a = (rotDeg + (i * 360) / n) * Math.PI / 180
    pts.push(`${(c + r * Math.cos(a)).toFixed(1)},${(c + r * Math.sin(a)).toFixed(1)}`)
  }
  return pts.join(' ')
}
// Puntos de una estrella de `picos` puntas.
function ptsEstrella(picos: number, S: number, rInt = 0.42, rotDeg = -90): string {
  const c = S / 2, rE = S / 2, rI = (S / 2) * rInt, pts: string[] = []
  for (let i = 0; i < picos * 2; i++) {
    const r = i % 2 ? rI : rE
    const a = (rotDeg + (i * 180) / picos) * Math.PI / 180
    pts.push(`${(c + r * Math.cos(a)).toFixed(1)},${(c + r * Math.sin(a)).toFixed(1)}`)
  }
  return pts.join(' ')
}

// Crea el elemento SVG de una figura en un box de lado S (sin transform).
function crearFiguraEl(tipo: string, S: number): { el: SVGElement; modo: 'fill' | 'stroke' } {
  const poligono = (pts: string) => { const p = document.createElementNS(SVGNS, 'polygon'); p.setAttribute('points', pts); return p }
  const camino = (d: string) => { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); return p }
  let el: SVGElement
  let modo: 'fill' | 'stroke' = 'fill'
  switch (tipo) {
    case 'rect': case 'redondeado':
      el = document.createElementNS(SVGNS, 'rect')
      el.setAttribute('width', String(S)); el.setAttribute('height', String(Math.round(S * 0.66)))
      if (tipo === 'redondeado') el.setAttribute('rx', String(S * 0.11)); break
    case 'circulo':
      el = document.createElementNS(SVGNS, 'circle')
      el.setAttribute('cx', String(S / 2)); el.setAttribute('cy', String(S / 2)); el.setAttribute('r', String(S / 2)); break
    case 'triangulo': el = poligono(`${S / 2},0 ${S},${S} 0,${S}`); break
    case 'rombo': el = poligono(ptsPoligono(4, S)); break
    case 'pentagono': el = poligono(ptsPoligono(5, S)); break
    case 'hexagono': el = poligono(ptsPoligono(6, S, 0)); break
    case 'octagono': el = poligono(ptsPoligono(8, S, -90 + 22.5)); break
    case 'estrella': el = poligono(ptsEstrella(5, S)); break
    case 'estrella6': el = poligono(ptsEstrella(6, S, 0.58)); break
    case 'corazon': el = camino(`M${0.5 * S} ${0.86 * S} C ${0.16 * S} ${0.62 * S} ${0.04 * S} ${0.36 * S} ${0.23 * S} ${0.23 * S} C ${0.36 * S} ${0.13 * S} ${0.46 * S} ${0.2 * S} ${0.5 * S} ${0.3 * S} C ${0.54 * S} ${0.2 * S} ${0.64 * S} ${0.13 * S} ${0.77 * S} ${0.23 * S} C ${0.96 * S} ${0.36 * S} ${0.84 * S} ${0.62 * S} ${0.5 * S} ${0.86 * S} Z`); break
    case 'rayo': el = camino(`M${0.56 * S} 0 L${0.18 * S} ${0.56 * S} L${0.44 * S} ${0.56 * S} L${0.4 * S} ${S} L${0.82 * S} ${0.38 * S} L${0.52 * S} ${0.38 * S} Z`); break
    case 'linea':
      el = document.createElementNS(SVGNS, 'line')
      el.setAttribute('x1', '0'); el.setAttribute('y1', String(S / 2)); el.setAttribute('x2', String(S)); el.setAttribute('y2', String(S / 2))
      el.setAttribute('stroke-width', String(Math.max(2, S * 0.05))); el.setAttribute('stroke-linecap', 'round'); modo = 'stroke'; break
    default: // flecha
      el = camino(`M0 ${S * 0.4} L${S * 0.66} ${S * 0.4} L${S * 0.66} ${S * 0.22} L${S} ${S * 0.5} L${S * 0.66} ${S * 0.78} L${S * 0.66} ${S * 0.6} L0 ${S * 0.6} Z`)
  }
  if (modo === 'fill') el.setAttribute('fill', '#38bdf8')
  else { el.setAttribute('stroke', '#38bdf8'); el.setAttribute('fill', 'none') }
  return { el, modo }
}

function insertarFigura(tipo: string): void {
  if (!svgEl) return
  contadorAgregados++
  const vw = svgEl.viewBox.baseVal.width || 1080
  const vh = svgEl.viewBox.baseVal.height || 1350
  const S = 160
  const { el, modo } = crearFiguraEl(tipo, S)
  const x = Math.round((vw - S) / 2), y = Math.round((vh - S) / 2)
  el.setAttribute('transform', `translate(${x} ${y}) scale(1)`)
  if (!el.getAttribute('stroke-width')) el.setAttribute('stroke-width', '4')
  el.setAttribute('stroke-linejoin', 'round')
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
  // Sacar currentColor explícito de los hijos para que hereden el color del <g>.
  for (const el of Array.from(g.querySelectorAll('*'))) {
    if (el.getAttribute('fill') === 'currentColor') el.removeAttribute('fill')
    if (el.getAttribute('stroke') === 'currentColor') el.removeAttribute('stroke')
  }
  const color = '#141930'
  g.setAttribute('data-agregado', 'icono')
  // ¿Es de contorno (outline) o relleno (solid)? Según el stroke real del SVG.
  const esContorno = /stroke\s*=\s*["'](?!none)/i.test(raw)
  if (esContorno) {
    g.setAttribute('fill', 'none')
    g.setAttribute('stroke', color)
    g.setAttribute('stroke-width', svgIco.getAttribute('stroke-width') ?? '2')
    g.setAttribute('stroke-linecap', 'round')
    g.setAttribute('stroke-linejoin', 'round')
    g.setAttribute('data-colormode', 'stroke')
  } else {
    g.setAttribute('fill', color)
    g.setAttribute('data-colormode', 'fill')
  }
  // Escalar según el viewBox del ícono (no siempre 24×24) a ~120px.
  const vb = (svgIco.getAttribute('viewBox') ?? '0 0 24 24').split(/[\s,]+/).map(Number)
  const iw = vb[2] || 24, ih = vb[3] || 24
  const vw = svgEl.viewBox.baseVal.width || 1080
  const vh = svgEl.viewBox.baseVal.height || 1350
  const s = 120 / Math.max(iw, ih)
  const x = Math.round(vw / 2 - (iw * s) / 2), y = Math.round(vh / 2 - (ih * s) / 2)
  g.setAttribute('transform', `translate(${x} ${y}) scale(${s})`)
  svgEl.appendChild(g)
  construirOverlays()
}

// ============ Máscaras de recorte para imágenes agregadas ============

// Forma de máscara centrada en (cx,cy) con "radio" R (mitad del lado).
function formaMascaraEn(tipo: string, cx: number, cy: number, R: number): SVGElement {
  if (tipo === 'circulo') {
    const c = document.createElementNS(SVGNS, 'circle')
    c.setAttribute('cx', String(cx)); c.setAttribute('cy', String(cy)); c.setAttribute('r', String(R))
    return c
  }
  if (tipo === 'elipse') {
    const e = document.createElementNS(SVGNS, 'ellipse')
    e.setAttribute('cx', String(cx)); e.setAttribute('cy', String(cy))
    e.setAttribute('rx', String(R * 1.3)); e.setAttribute('ry', String(R * 0.85))
    return e
  }
  if (tipo === 'redondeado') {
    const rc = document.createElementNS(SVGNS, 'rect')
    rc.setAttribute('x', String(cx - R)); rc.setAttribute('y', String(cy - R))
    rc.setAttribute('width', String(2 * R)); rc.setAttribute('height', String(2 * R))
    rc.setAttribute('rx', String(R * 0.28))
    return rc
  }
  if (tipo === 'triangulo') {
    const p = document.createElementNS(SVGNS, 'polygon')
    p.setAttribute('points', `${cx},${cy - R} ${cx + R},${cy + R} ${cx - R},${cy + R}`)
    return p
  }
  const pts: string[] = []
  if (tipo === 'hexagono') {
    for (let i = 0; i < 6; i++) { const a = (Math.PI / 180) * (60 * i - 30); pts.push(`${(cx + R * Math.cos(a)).toFixed(1)},${(cy + R * Math.sin(a)).toFixed(1)}`) }
  } else {
    const ri = R * 0.45
    for (let i = 0; i < 10; i++) { const rad = i % 2 === 0 ? R : ri; const a = -Math.PI / 2 + (i * Math.PI) / 5; pts.push(`${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`) }
  }
  const poly = document.createElementNS(SVGNS, 'polygon')
  poly.setAttribute('points', pts.join(' '))
  return poly
}

// (Re)construye el clipPath de una imagen desde sus params (data-mask-*).
function construirMascara(img: SVGElement): void {
  if (!svgEl) return
  const tipo = img.getAttribute('data-mask-tipo')
  if (!img.id) { contadorAgregados++; img.id = 'agimg-' + contadorAgregados }
  const id = 'mask-' + img.id
  svgEl.querySelector('#' + id)?.remove()
  if (!tipo || tipo === 'ninguna') { img.removeAttribute('clip-path'); return }
  const W = parseFloat(img.getAttribute('width') || '0')
  const H = parseFloat(img.getAttribute('height') || '0')
  const cx = parseFloat(img.getAttribute('data-mask-cx') ?? String(W / 2))
  const cy = parseFloat(img.getAttribute('data-mask-cy') ?? String(H / 2))
  const s = parseFloat(img.getAttribute('data-mask-s') ?? '1')
  const R = (Math.min(W, H) / 2) * s
  let defs = svgEl.querySelector('defs')
  if (!defs) { defs = document.createElementNS(SVGNS, 'defs'); svgEl.insertBefore(defs, svgEl.firstChild) }
  const cp = document.createElementNS(SVGNS, 'clipPath')
  cp.id = id
  cp.setAttribute('clipPathUnits', 'userSpaceOnUse')
  cp.appendChild(formaMascaraEn(tipo, cx, cy, R))
  defs.appendChild(cp)
  img.setAttribute('clip-path', `url(#${id})`)
}

// Aplica/quita una máscara (resetea centro y tamaño al default).
function aplicarMascara(img: SVGElement, tipo: string): void {
  if (tipo === 'ninguna') {
    for (const a of ['data-mask-tipo', 'data-mask-cx', 'data-mask-cy', 'data-mask-s']) img.removeAttribute(a)
  } else {
    const W = parseFloat(img.getAttribute('width') || '0')
    const H = parseFloat(img.getAttribute('height') || '0')
    img.setAttribute('data-mask-tipo', tipo)
    img.setAttribute('data-mask-cx', String(W / 2))
    img.setAttribute('data-mask-cy', String(H / 2))
    img.setAttribute('data-mask-s', '1')
  }
  construirMascara(img)
  construirOverlays()
}

// Botón ✂ (con menú de formas) para recortar una imagen agregada.
function crearBotonMascara(r: Rect, img: SVGElement): HTMLDivElement {
  const wrap = document.createElement('div')
  wrap.className = 'mascara-wrap'
  wrap.style.left = r.left - 2 + 'px'; wrap.style.top = r.top - 2 + 'px'
  const btn = document.createElement('button')
  btn.className = 'btn-mascara'; btn.textContent = '✂'; btn.title = 'Recorte (máscara)'
  const pop = document.createElement('div')
  pop.className = 'menu-pop mascara-pop'; pop.hidden = true
  const formas: [string, string][] = [
    ['ninguna', '⊘'], ['circulo', '●'], ['elipse', '⬭'], ['redondeado', '▢'],
    ['triangulo', '▲'], ['hexagono', '⬡'], ['estrella', '★'],
  ]
  for (const [tipo, label] of formas) {
    const b = document.createElement('button')
    b.textContent = label; b.title = tipo
    b.addEventListener('click', (e) => { e.stopPropagation(); aplicarMascara(img, tipo) })
    pop.appendChild(b)
  }
  btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden })
  wrap.appendChild(btn); wrap.appendChild(pop)
  return wrap
}

// Handles para mover/redimensionar la máscara de recorte de una imagen.
function handlesMascara(img: SVGElement, base: DOMRect): HTMLElement[] {
  const tipo = img.getAttribute('data-mask-tipo')
  if (!tipo || tipo === 'ninguna' || !svgEl) return []
  const W = parseFloat(img.getAttribute('width') || '0')
  const H = parseFloat(img.getAttribute('height') || '0')
  const cx = parseFloat(img.getAttribute('data-mask-cx') ?? String(W / 2))
  const cy = parseFloat(img.getAttribute('data-mask-cy') ?? String(H / 2))
  const s = parseFloat(img.getAttribute('data-mask-s') ?? '1')
  const R = (Math.min(W, H) / 2) * s
  const tm = (img.getAttribute('transform') ?? '').match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)/)
  const tx = tm ? +tm[1] : 0, ty = tm ? +tm[2] : 0
  const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
  const o = svgEl.getBoundingClientRect()
  const scr = (ux: number, uy: number) => ({ left: o.left - base.left + (tx + ux) * k, top: o.top - base.top + (ty + uy) * k })
  const c = scr(cx, cy), e = scr(cx + R, cy)
  const mov = document.createElement('div')
  mov.className = 'mask-handle mask-mover'; mov.title = 'Mover el recorte'
  mov.style.left = c.left + 'px'; mov.style.top = c.top + 'px'
  habilitarDragMascara(mov, img, 'mover')
  const esc = document.createElement('div')
  esc.className = 'mask-handle mask-escalar'; esc.title = 'Tamaño del recorte'
  esc.style.left = e.left + 'px'; esc.style.top = e.top + 'px'
  habilitarDragMascara(esc, img, 'escalar')
  return [mov, esc]
}

function habilitarDragMascara(h: HTMLElement, img: SVGElement, modo: 'mover' | 'escalar'): void {
  h.addEventListener('pointerdown', (e) => {
    if (!svgEl) return
    e.preventDefault(); e.stopPropagation()
    const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
    const W = parseFloat(img.getAttribute('width') || '0')
    const H = parseFloat(img.getAttribute('height') || '0')
    const baseR = Math.min(W, H) / 2
    let cx = parseFloat(img.getAttribute('data-mask-cx') ?? String(W / 2))
    let cy = parseFloat(img.getAttribute('data-mask-cy') ?? String(H / 2))
    let s = parseFloat(img.getAttribute('data-mask-s') ?? '1')
    let sx = e.clientX, sy = e.clientY
    const onMove = (ev: PointerEvent) => {
      const dxs = ev.clientX - sx, dys = ev.clientY - sy
      sx = ev.clientX; sy = ev.clientY
      if (modo === 'mover') {
        cx += dxs / k; cy += dys / k
        img.setAttribute('data-mask-cx', String(cx)); img.setAttribute('data-mask-cy', String(cy))
        h.style.left = parseFloat(h.style.left) + dxs + 'px'; h.style.top = parseFloat(h.style.top) + dys + 'px'
      } else {
        s = Math.max(0.06, s + (dxs / k) / baseR)
        img.setAttribute('data-mask-s', String(s))
        h.style.left = parseFloat(h.style.left) + dxs + 'px'
      }
      construirMascara(img)
    }
    const onUp = () => { h.removeEventListener('pointermove', onMove); construirOverlays() }
    try { h.setPointerCapture(e.pointerId) } catch { /* igual ajusta */ }
    h.addEventListener('pointermove', onMove)
    h.addEventListener('pointerup', onUp, { once: true })
    h.addEventListener('pointercancel', onUp, { once: true })
  })
}

// ============ Pluma (Bézier con puntos de ancla) ============
// Manijas independientes estilo Illustrator: hi = manija de ENTRADA (segmento que
// llega), ho = manija de SALIDA (próximo segmento). Punto liso => hi == -ho.
// Punto de esquina => manijas independientes (o sin manija).
interface Ancla { x: number; y: number; hix: number; hiy: number; hox: number; hoy: number }
let plumaActiva = false
let plumaAnclas: Ancla[] = []
let plumaPath: SVGPathElement | null = null
let plumaPreview: SVGPathElement | null = null
let plumaManijas: SVGPathElement | null = null // líneas finas ancla↔manija
let plumaCursor: { x: number; y: number } | null = null
let plumaCapa: HTMLDivElement | null = null
const COLOR_PLUMA = '#141930'
const tieneIn = (a: Ancla) => a.hix !== 0 || a.hiy !== 0
const tieneOut = (a: Ancla) => a.hox !== 0 || a.hoy !== 0

function screenToUser(clientX: number, clientY: number): { x: number; y: number } {
  const o = svgEl!.getBoundingClientRect()
  const k = svgEl!.clientWidth / (svgEl!.viewBox.baseVal.width || 1080)
  return { x: (clientX - o.left) / k, y: (clientY - o.top) / k }
}

// Un tramo entre dos anclas: curva si alguna tiene manija en ese lado, si no recta.
function tramoD(p: Ancla, c: Ancla): string {
  if (tieneOut(p) || tieneIn(c)) {
    return ` C ${p.x + p.hox} ${p.y + p.hoy} ${c.x + c.hix} ${c.y + c.hiy} ${c.x} ${c.y}`
  }
  return ` L ${c.x} ${c.y}`
}

// Construye el atributo d de un path Bézier a partir de las anclas.
function dPluma(anclas: Ancla[], cerrado: boolean): string {
  if (!anclas.length) return ''
  let d = `M ${anclas[0].x} ${anclas[0].y}`
  for (let i = 1; i < anclas.length; i++) d += tramoD(anclas[i - 1], anclas[i])
  if (cerrado && anclas.length >= 2) {
    d += tramoD(anclas[anclas.length - 1], anclas[0]) + ' Z'
  }
  return d
}

function dibujarPluma(): void {
  if (!svgEl) return
  if (!plumaPath) {
    plumaPath = document.createElementNS(SVGNS, 'path')
    plumaPath.setAttribute('fill', 'none')
    plumaPath.setAttribute('stroke', COLOR_PLUMA)
    plumaPath.setAttribute('stroke-width', '4')
    plumaPath.setAttribute('stroke-linecap', 'round')
    plumaPath.setAttribute('stroke-linejoin', 'round')
    svgEl.appendChild(plumaPath)
  }
  plumaPath.setAttribute('d', dPluma(plumaAnclas, false))
  // Líneas finas ancla↔manija (en el mismo espacio del SVG).
  if (!plumaManijas) {
    plumaManijas = document.createElementNS(SVGNS, 'path')
    plumaManijas.setAttribute('fill', 'none')
    plumaManijas.setAttribute('stroke', COLOR_PLUMA)
    plumaManijas.setAttribute('stroke-width', '1')
    plumaManijas.setAttribute('opacity', '0.6')
    plumaManijas.setAttribute('pointer-events', 'none')
    svgEl.appendChild(plumaManijas)
  }
  let dl = ''
  for (const a of plumaAnclas) {
    if (tieneIn(a)) dl += ` M ${a.x} ${a.y} L ${a.x + a.hix} ${a.y + a.hiy}`
    if (tieneOut(a)) dl += ` M ${a.x} ${a.y} L ${a.x + a.hox} ${a.y + a.hoy}`
  }
  plumaManijas.setAttribute('d', dl.trim())
  lienzo.querySelectorAll('.pluma-pt, .pluma-manija').forEach((n) => n.remove())
  const base = lienzo.getBoundingClientRect()
  const o = svgEl.getBoundingClientRect()
  const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
  const aPx = (x: number, y: number) => ({ left: o.left - base.left + x * k, top: o.top - base.top + y * k })
  const ptManija = (x: number, y: number) => {
    const h = aPx(x, y)
    const dot = document.createElement('div'); dot.className = 'pluma-manija'
    dot.style.left = h.left + 'px'; dot.style.top = h.top + 'px'
    lienzo.appendChild(dot)
  }
  plumaAnclas.forEach((a, i) => {
    const s = aPx(a.x, a.y)
    const pt = document.createElement('div')
    pt.className = 'pluma-pt' + (i === 0 ? ' primero' : '')
    pt.style.left = s.left + 'px'; pt.style.top = s.top + 'px'
    lienzo.appendChild(pt)
    if (tieneIn(a)) ptManija(a.x + a.hix, a.y + a.hiy)
    if (tieneOut(a)) ptManija(a.x + a.hox, a.y + a.hoy)
  })
}

// Segmento provisional (punteado) desde el último punto hasta el cursor, para ir
// viendo el trazo mientras se mueve el mouse (antes de fijar el próximo punto).
function dibujarPreviewPluma(): void {
  if (!svgEl || !plumaAnclas.length || !plumaCursor) return
  if (!plumaPreview) {
    plumaPreview = document.createElementNS(SVGNS, 'path')
    plumaPreview.setAttribute('fill', 'none')
    plumaPreview.setAttribute('stroke', COLOR_PLUMA)
    plumaPreview.setAttribute('stroke-width', '4')
    plumaPreview.setAttribute('stroke-linecap', 'round')
    plumaPreview.setAttribute('stroke-dasharray', '1 9')
    plumaPreview.setAttribute('opacity', '0.5')
    plumaPreview.setAttribute('pointer-events', 'none')
    svgEl.appendChild(plumaPreview)
  }
  const last = plumaAnclas[plumaAnclas.length - 1]
  let d = `M ${last.x} ${last.y}`
  if (tieneOut(last)) d += ` C ${last.x + last.hox} ${last.y + last.hoy} ${plumaCursor.x} ${plumaCursor.y} ${plumaCursor.x} ${plumaCursor.y}`
  else d += ` L ${plumaCursor.x} ${plumaCursor.y}`
  plumaPreview.setAttribute('d', d)
}

// Mueve el cursor (sin botón apretado): actualiza el preview del próximo tramo.
function plumaHover(e: PointerEvent): void {
  if (!plumaActiva || e.buttons !== 0) return // con botón, lo maneja el arrastre de manija
  if (!plumaAnclas.length) { plumaCursor = null; return }
  plumaCursor = screenToUser(e.clientX, e.clientY)
  dibujarPreviewPluma()
}

function activarPluma(): void {
  if (!svgEl) return
  cerrarEditor()
  plumaActiva = true
  plumaAnclas = []
  plumaCursor = null
  document.querySelector('#btn-pluma')!.classList.add('activo-pluma')
  plumaCapa = document.createElement('div')
  plumaCapa.className = 'pluma-capa'
  plumaCapa.addEventListener('pointerdown', plumaPointerDown)
  plumaCapa.addEventListener('pointermove', plumaHover)
  plumaCapa.addEventListener('dblclick', () => finalizarPluma(false))
  lienzo.appendChild(plumaCapa)
  document.addEventListener('keydown', plumaKey)
}

function desactivarPluma(): void {
  plumaActiva = false
  document.querySelector('#btn-pluma')?.classList.remove('activo-pluma')
  plumaCapa?.remove(); plumaCapa = null
  plumaPath?.remove(); plumaPath = null
  plumaPreview?.remove(); plumaPreview = null
  plumaManijas?.remove(); plumaManijas = null
  plumaCursor = null
  lienzo.querySelectorAll('.pluma-pt, .pluma-manija').forEach((n) => n.remove())
  document.removeEventListener('keydown', plumaKey)
  plumaAnclas = []
}

function plumaKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') desactivarPluma()
  else if (e.key === 'Enter') finalizarPluma(false)
}

function plumaPointerDown(e: PointerEvent): void {
  if (!svgEl || !plumaCapa) return
  e.preventDefault()
  const pt = screenToUser(e.clientX, e.clientY)
  const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
  if (plumaAnclas.length >= 2) {
    const a0 = plumaAnclas[0]
    if (Math.hypot((pt.x - a0.x) * k, (pt.y - a0.y) * k) < 11) { finalizarPluma(true); return }
  }
  const ancla: Ancla = { x: pt.x, y: pt.y, hix: 0, hiy: 0, hox: 0, hoy: 0 }
  plumaAnclas.push(ancla)
  dibujarPluma()
  plumaCursor = { x: pt.x, y: pt.y } // reiniciar el preview al nuevo punto
  dibujarPreviewPluma()
  const onMove = (ev: PointerEvent) => {
    const p = screenToUser(ev.clientX, ev.clientY)
    // Manija de SALIDA = hacia donde se arrastra (define el próximo trazo).
    ancla.hox = p.x - ancla.x; ancla.hoy = p.y - ancla.y
    // Sin Alt: punto liso (entrada espejada). Con Alt: se rompe — la entrada
    // (lo ya dibujado) queda fija y solo cambia la salida (como Illustrator).
    if (!ev.altKey) { ancla.hix = -ancla.hox; ancla.hiy = -ancla.hoy }
    dibujarPluma()
  }
  const onUp = () => plumaCapa!.removeEventListener('pointermove', onMove)
  try { plumaCapa.setPointerCapture(e.pointerId) } catch { /* igual dibuja */ }
  plumaCapa.addEventListener('pointermove', onMove)
  plumaCapa.addEventListener('pointerup', onUp, { once: true })
  plumaCapa.addEventListener('pointercancel', onUp, { once: true })
}

function finalizarPluma(cerrado: boolean): void {
  if (!svgEl || plumaAnclas.length < 2) { desactivarPluma(); return }
  // Normalizar coords al origen (para que el scale del overlay no lo desplace).
  let minX = Infinity, minY = Infinity
  for (const a of plumaAnclas) { minX = Math.min(minX, a.x); minY = Math.min(minY, a.y) }
  const norm = plumaAnclas.map((a) => ({ x: a.x - minX, y: a.y - minY, hix: a.hix, hiy: a.hiy, hox: a.hox, hoy: a.hoy }))
  const p = document.createElementNS(SVGNS, 'path')
  p.setAttribute('d', dPluma(norm, cerrado))
  p.setAttribute('fill', 'none')
  p.setAttribute('stroke', COLOR_PLUMA)
  p.setAttribute('stroke-width', '4')
  p.setAttribute('stroke-linecap', 'round')
  p.setAttribute('stroke-linejoin', 'round')
  p.setAttribute('transform', `translate(${minX} ${minY}) scale(1)`)
  p.setAttribute('data-agregado', 'figura')
  p.setAttribute('data-colormode', 'stroke')
  svgEl.appendChild(p)
  desactivarPluma()
  construirOverlays()
}

// ============ Editar puntos de un trazo terminado (estilo Illustrator) ============
// Convierte el atributo `d` de un path en anclas con manijas in/out. Soporta
// M L H V C S Q T Z (absoluto y relativo) y un solo subtrazo. Devuelve null si
// no se puede editar (varios subtrazos, arcos A, etc.).
function parsearD(d: string): { anclas: Ancla[]; cerrado: boolean } | null {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g)
  if (!toks) return null
  const anclas: Ancla[] = []
  let i = 0, cx = 0, cy = 0, sx = 0, sy = 0, cerrado = false, nM = 0
  let prevCtrl: { x: number; y: number } | null = null // 2º control previo (para S)
  let prevQ: { x: number; y: number } | null = null     // control quad previo (para T)
  let cmd = ''
  const num = () => parseFloat(toks[i++])
  const esNum = (t: string) => /[-\d.]/.test(t[0])
  const nuevaAncla = (x: number, y: number) => { anclas.push({ x, y, hix: 0, hiy: 0, hox: 0, hoy: 0 }); return anclas[anclas.length - 1] }
  while (i < toks.length) {
    if (!esNum(toks[i])) cmd = toks[i++]
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    if (C === 'M') {
      const x = num() + (rel ? cx : 0), y = num() + (rel ? cy : 0)
      if (++nM > 1) return null // varios subtrazos: no editable acá
      cx = sx = x; cy = sy = y; nuevaAncla(x, y); prevCtrl = prevQ = null
      cmd = rel ? 'l' : 'L' // coords siguientes sin letra = lineTo
    } else if (C === 'L') {
      const x = num() + (rel ? cx : 0), y = num() + (rel ? cy : 0)
      cx = x; cy = y; nuevaAncla(x, y); prevCtrl = prevQ = null
    } else if (C === 'H') {
      const x = num() + (rel ? cx : 0); cx = x; nuevaAncla(x, cy); prevCtrl = prevQ = null
    } else if (C === 'V') {
      const y = num() + (rel ? cy : 0); cy = y; nuevaAncla(cx, y); prevCtrl = prevQ = null
    } else if (C === 'C' || C === 'S') {
      let x1: number, y1: number
      if (C === 'C') { x1 = num() + (rel ? cx : 0); y1 = num() + (rel ? cy : 0) }
      else { x1 = prevCtrl ? 2 * cx - prevCtrl.x : cx; y1 = prevCtrl ? 2 * cy - prevCtrl.y : cy }
      const x2 = num() + (rel ? cx : 0), y2 = num() + (rel ? cy : 0)
      const x = num() + (rel ? cx : 0), y = num() + (rel ? cy : 0)
      const prev = anclas[anclas.length - 1]
      prev.hox = x1 - prev.x; prev.hoy = y1 - prev.y
      const a = nuevaAncla(x, y); a.hix = x2 - x; a.hiy = y2 - y
      cx = x; cy = y; prevCtrl = { x: x2, y: y2 }; prevQ = null
    } else if (C === 'Q' || C === 'T') {
      let qx: number, qy: number
      if (C === 'Q') { qx = num() + (rel ? cx : 0); qy = num() + (rel ? cy : 0) }
      else { qx = prevQ ? 2 * cx - prevQ.x : cx; qy = prevQ ? 2 * cy - prevQ.y : cy }
      const x = num() + (rel ? cx : 0), y = num() + (rel ? cy : 0)
      const prev = anclas[anclas.length - 1]
      prev.hox = (2 / 3) * (qx - prev.x); prev.hoy = (2 / 3) * (qy - prev.y)
      const a = nuevaAncla(x, y); a.hix = (2 / 3) * (qx - x); a.hiy = (2 / 3) * (qy - y)
      cx = x; cy = y; prevQ = { x: qx, y: qy }; prevCtrl = null
    } else if (C === 'Z') {
      cerrado = true; cx = sx; cy = sy; prevCtrl = prevQ = null
    } else {
      return null // comando no soportado (p.ej. A)
    }
  }
  if (anclas.length < 2) return null
  // Si cerró y el último coincide con el primero, fusionar (su manija de entrada
  // pasa al primer ancla) para no dejar un punto duplicado.
  if (cerrado && anclas.length > 2) {
    const u = anclas[anclas.length - 1], p0 = anclas[0]
    if (Math.hypot(u.x - p0.x, u.y - p0.y) < 0.01) {
      p0.hix = u.hix; p0.hiy = u.hiy; anclas.pop()
    }
  }
  return { anclas, cerrado }
}

let editPath: SVGPathElement | null = null
let editAnclas: Ancla[] = []
let editCerrado = false
let editCapa: HTMLDivElement | null = null
let editLineas: SVGSVGElement | null = null

function ctmEdit(): DOMMatrix { return editPath!.getScreenCTM() as DOMMatrix }
// local (espacio del `d`) -> px relativos al lienzo
function localAPx(ux: number, uy: number): { left: number; top: number } {
  const p = svgEl!.createSVGPoint(); p.x = ux; p.y = uy
  const s = p.matrixTransform(ctmEdit())
  const base = lienzo.getBoundingClientRect()
  return { left: s.x - base.left, top: s.y - base.top }
}
// pantalla (clientX/Y) -> local (espacio del `d`)
function pantallaALocal(clientX: number, clientY: number): { x: number; y: number } {
  const p = svgEl!.createSVGPoint(); p.x = clientX; p.y = clientY
  const l = p.matrixTransform(ctmEdit().inverse())
  return { x: l.x, y: l.y }
}

function entrarEditarPuntos(path: SVGPathElement): void {
  const r = parsearD(path.getAttribute('d') || '')
  if (!r) { alert('Este trazo no se puede editar punto a punto (tiene varios subtrazos o arcos).'); return }
  cerrarEditorPuntos()
  editPath = path
  editAnclas = r.anclas
  editCerrado = r.cerrado
  limpiarGraf()
  editLineas = document.createElementNS(SVGNS, 'svg') as unknown as SVGSVGElement
  editLineas.setAttribute('class', 'edit-svg')
  lienzo.appendChild(editLineas)
  editCapa = document.createElement('div')
  editCapa.className = 'edit-capa'
  editCapa.addEventListener('pointerdown', editPointerDown)
  editCapa.addEventListener('dblclick', editDblClick)
  lienzo.appendChild(editCapa)
  document.addEventListener('keydown', editKey)
  dibujarEditor()
}

function dibujarEditor(): void {
  if (!editPath || !editCapa) return
  editPath.setAttribute('d', dPluma(editAnclas, editCerrado))
  lienzo.querySelectorAll('.pluma-pt, .pluma-manija').forEach((n) => n.remove())
  if (editLineas) {
    editLineas.setAttribute('width', String(lienzo.clientWidth))
    editLineas.setAttribute('height', String(lienzo.clientHeight))
    while (editLineas.firstChild) editLineas.removeChild(editLineas.firstChild)
  }
  const linea = (x1: number, y1: number, x2: number, y2: number) => {
    const ln = document.createElementNS(SVGNS, 'line')
    ln.setAttribute('x1', String(x1)); ln.setAttribute('y1', String(y1))
    ln.setAttribute('x2', String(x2)); ln.setAttribute('y2', String(y2))
    editLineas!.appendChild(ln)
  }
  const dot = (left: number, top: number, cls: string) => {
    const d = document.createElement('div'); d.className = cls
    d.style.left = left + 'px'; d.style.top = top + 'px'
    lienzo.appendChild(d)
  }
  editAnclas.forEach((a) => {
    const s = localAPx(a.x, a.y)
    if (tieneIn(a)) { const h = localAPx(a.x + a.hix, a.y + a.hiy); linea(s.left, s.top, h.left, h.top); dot(h.left, h.top, 'pluma-manija') }
    if (tieneOut(a)) { const h = localAPx(a.x + a.hox, a.y + a.hoy); linea(s.left, s.top, h.left, h.top); dot(h.left, h.top, 'pluma-manija') }
    dot(s.left, s.top, 'pluma-pt')
  })
}

// Devuelve qué se tocó: un ancla o una manija (in/out) cercana al puntero.
function editHit(clientX: number, clientY: number): { i: number; tipo: 'a' | 'in' | 'out' } | null {
  const base = lienzo.getBoundingClientRect()
  const px = clientX - base.left, py = clientY - base.top
  let mejor: { i: number; tipo: 'a' | 'in' | 'out'; d: number } | null = null
  const probar = (i: number, tipo: 'a' | 'in' | 'out', lx: number, ly: number) => {
    const p = localAPx(lx, ly); const d = Math.hypot(p.left - px, p.top - py)
    if (d < 11 && (!mejor || d < mejor.d)) mejor = { i, tipo, d }
  }
  editAnclas.forEach((a, i) => {
    if (tieneIn(a)) probar(i, 'in', a.x + a.hix, a.y + a.hiy)
    if (tieneOut(a)) probar(i, 'out', a.x + a.hox, a.y + a.hoy)
  })
  // Las anclas se prueban después para que las manijas (encima) ganen al empatar.
  editAnclas.forEach((a, i) => probar(i, 'a', a.x, a.y))
  const m = mejor as { i: number; tipo: 'a' | 'in' | 'out'; d: number } | null
  return m ? { i: m.i, tipo: m.tipo } : null
}

function editPointerDown(e: PointerEvent): void {
  if (!editCapa) return
  const hit = editHit(e.clientX, e.clientY)
  if (!hit) { salirEditarPuntos(); return } // clic en vacío: terminar
  e.preventDefault()
  const a = editAnclas[hit.i]
  // Alt + clic sobre un ANCLA (sin arrastrar) = eliminar el punto.
  if (hit.tipo === 'a' && e.altKey && editAnclas.length > 2) {
    let movido = false
    const onMv = () => { movido = true }
    const onUp = () => {
      editCapa!.removeEventListener('pointermove', onMv)
      if (!movido) { editAnclas.splice(hit.i, 1); dibujarEditor() }
    }
    editCapa.addEventListener('pointermove', onMv)
    editCapa.addEventListener('pointerup', onUp, { once: true })
    return
  }
  // ¿El ancla estaba liso (manijas espejadas)? Si sí, al mover una manija se
  // mueve la otra, salvo que se mantenga Alt (rompe la simetría).
  const liso = tieneIn(a) && tieneOut(a) &&
    Math.abs(a.hix + a.hox) < 0.01 && Math.abs(a.hiy + a.hoy) < 0.01
  const onMove = (ev: PointerEvent) => {
    const l = pantallaALocal(ev.clientX, ev.clientY)
    if (hit.tipo === 'a') {
      a.x = l.x; a.y = l.y // las manijas son relativas: se mueven con el ancla
    } else if (hit.tipo === 'out') {
      a.hox = l.x - a.x; a.hoy = l.y - a.y
      if (liso && !ev.altKey) { a.hix = -a.hox; a.hiy = -a.hoy }
    } else {
      a.hix = l.x - a.x; a.hiy = l.y - a.y
      if (liso && !ev.altKey) { a.hox = -a.hix; a.hoy = -a.hiy }
    }
    dibujarEditor()
  }
  const onUp = () => editCapa!.removeEventListener('pointermove', onMove)
  try { editCapa.setPointerCapture(e.pointerId) } catch { /* igual edita */ }
  editCapa.addEventListener('pointermove', onMove)
  editCapa.addEventListener('pointerup', onUp, { once: true })
  editCapa.addEventListener('pointercancel', onUp, { once: true })
}

// Doble clic sobre un ancla: alterna entre esquina (sin manijas) y liso.
function editDblClick(e: MouseEvent): void {
  const hit = editHit(e.clientX, e.clientY)
  if (!hit || hit.tipo !== 'a') return
  e.preventDefault()
  const n = editAnclas.length, i = hit.i, a = editAnclas[i]
  if (tieneIn(a) || tieneOut(a)) { a.hix = a.hiy = a.hox = a.hoy = 0 } // -> esquina
  else { // -> liso: manijas según la dirección de los vecinos
    const prev = editAnclas[(i - 1 + n) % n], next = editAnclas[(i + 1) % n]
    const vx = next.x - prev.x, vy = next.y - prev.y
    const len = Math.hypot(vx, vy) || 1
    const mag = Math.min(Math.hypot(a.x - prev.x, a.y - prev.y), Math.hypot(next.x - a.x, next.y - a.y)) / 3
    a.hox = (vx / len) * mag; a.hoy = (vy / len) * mag
    a.hix = -a.hox; a.hiy = -a.hoy
  }
  dibujarEditor()
}

function editKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); salirEditarPuntos() }
}

function salirEditarPuntos(): void {
  if (!editPath) return
  editPath.setAttribute('d', dPluma(editAnclas, editCerrado))
  const path = editPath
  cerrarEditorPuntos()
  registrarHistorial(); autoguardar()
  if (modoGrafico) { grafSeleccion = [path]; dibujarSelGraf() }
  else construirOverlays()
}

function editandoPuntos(): boolean { return editPath != null }

function cerrarEditorPuntos(): void {
  editCapa?.remove(); editCapa = null
  editLineas?.remove(); editLineas = null
  lienzo.querySelectorAll('.pluma-pt, .pluma-manija').forEach((n) => n.remove())
  document.removeEventListener('keydown', editKey)
  editPath = null; editAnclas = []; editCerrado = false
}

// ---------------------------------------------------------------
//  Modo Gráficos: seleccionar/editar vectores e imágenes de la plantilla
// ---------------------------------------------------------------
const TAGS_GRAFICO = new Set(['rect', 'circle', 'ellipse', 'path', 'polygon', 'polyline', 'line', 'image', 'use'])
let modoGrafico = false
let grafSeleccion: SVGElement[] = []

// ¿El elemento (o un ancestro cercano) es un gráfico seleccionable?
// Excluye el fondo (rect que cubre toda la placa) y lo que esté en <defs>.
// Si el gráfico vive dentro de un grupo recortado (clip-path), devuelve ESE
// grupo: así al mover/escalar, el recorte viaja con el contenido en vez de
// enmascarar parte del dibujo (caso típico del logo de Illustrator).
function graficoSeleccionable(t: Element | null): SVGElement | null {
  let el: Element | null = t
  let hallado: SVGElement | null = null
  while (el && el !== svgEl) {
    const tag = el.tagName.toLowerCase()
    if (el.closest('defs, clipPath, mask, pattern')) return null
    // Los cuadros de TEXTO agregados también son seleccionables (mover/copiar/etc.).
    if (tag === 'text' && el.getAttribute('data-agregado') === 'texto') { hallado = el as SVGElement; break }
    if (TAGS_GRAFICO.has(tag)) {
      // Saltar el fondo: rect en (0,0) que cubre ~todo el viewBox.
      if (tag === 'rect' && esFondo(el as SVGRectElement)) return null
      hallado = el as SVGElement
      break
    }
    el = el.parentElement
  }
  if (!hallado) return null
  // Una FOTO de hueco (data-foto) es su propia unidad: NO subir a los grupos
  // recortados de la plantilla (el hueco, la placa), que envolverían medio diseño.
  // PERO si la foto ya está dentro de un recorte nuestro, seleccionamos ESE grupo
  // (para mover/escalar el recorte completo).
  if (hallado.getAttribute('data-foto') != null) {
    const rec = hallado.closest('[data-recorte]') as SVGElement | null
    return rec ?? hallado
  }
  // Subir a la unidad de selección: un grupo nuestro (data-grupo) tiene prioridad;
  // si no, el grupo recortado (clip-path) más externo. Así los grupos y los logos
  // recortados se manejan como una sola pieza.
  let grupo: SVGElement | null = null
  let recortado: SVGElement | null = null
  let a: Element | null = hallado
  // Área de la placa para no tratar como "pieza" a un grupo recortado que cubre
  // casi todo (esos son contenedores de la plantilla, no logos): si lo eligiéramos,
  // un recorte borraría la placa entera.
  const pr = svgEl!.getBoundingClientRect()
  const areaPlaca = Math.max(1, pr.width * pr.height)
  while (a && a !== svgEl) {
    if (a.getAttribute && a.getAttribute('data-grupo') === '1') grupo = a as SVGElement
    else if (!(a.getAttribute && a.getAttribute('data-graf-wrap') === '1')) {
      const cp = getComputedStyle(a).clipPath
      if (cp && cp !== 'none') {
        const ab = (a as SVGGraphicsElement).getBoundingClientRect()
        if ((ab.width * ab.height) / areaPlaca < 0.6) recortado = a as SVGElement // solo piezas chicas
      }
    }
    a = a.parentElement
  }
  return grupo ?? recortado ?? hallado
}

function esFondo(rect: SVGRectElement): boolean {
  if (!svgEl) return false
  const vb = svgEl.viewBox.baseVal
  const w = parseFloat(rect.getAttribute('width') ?? '0')
  const h = parseFloat(rect.getAttribute('height') ?? '0')
  const x = parseFloat(rect.getAttribute('x') ?? '0')
  const y = parseFloat(rect.getAttribute('y') ?? '0')
  return x <= 1 && y <= 1 && w >= vb.width * 0.98 && h >= vb.height * 0.98
}

function activarGrafico(): void {
  if (!svgEl) return
  cerrarEditor()
  if (plumaActiva) desactivarPluma()
  modoGrafico = true
  document.querySelector('#btn-grafico')!.classList.add('activo-grafico')
  lienzo.classList.add('modo-grafico')
  svgEl.addEventListener('pointerdown', grafPointerDown)
  document.addEventListener('keydown', grafKey)
  estado.textContent = 'Modo gráficos: clic en un vector/imagen para editarlo'
}

function desactivarGrafico(): void {
  modoGrafico = false
  document.querySelector('#btn-grafico')?.classList.remove('activo-grafico')
  lienzo.classList.remove('modo-grafico')
  svgEl?.removeEventListener('pointerdown', grafPointerDown)
  document.removeEventListener('keydown', grafKey)
  grafSeleccion = []
  limpiarGraf()
  construirOverlays() // reconstruir overlays normales (handles/hits) tras el modo gráfico
}

function grafKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (reframeG) { salirReencuadre(); return }
    if (grafSeleccion.length) { grafSeleccion = []; limpiarGraf() } else desactivarGrafico()
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && grafSeleccion.length) {
    e.preventDefault(); borrarGraf()
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
    e.preventDefault()
    if (e.shiftKey) desagruparSel(); else agruparSel()
  } else if ((e.ctrlKey || e.metaKey) && e.key === '7') {
    e.preventDefault()
    if (e.altKey) liberarRecorte(); else recortarConMascara()
  }
}

function limpiarGraf(): void {
  lienzo.querySelectorAll('.graf-sel, .graf-tools, .resize-handle, .graf-marquee, .grad-panel, .alinear-panel').forEach((n) => n.remove())
  actualizarBotonesEdicion()
}

// Nodo realmente manipulable: si el elemento ya está envuelto para mover, su wrapper.
function nodoManip(el: SVGElement): SVGElement {
  const p = el.parentNode as Element | null
  return (p && p.getAttribute && p.getAttribute('data-graf-wrap') === '1') ? (p as unknown as SVGElement) : el
}

// Envuelve el elemento en un <g data-graf-wrap> (una vez) para mover sin
// pisar su transform propio (matrix/rotate de Illustrator).
function wrapperGraf(el: SVGElement): SVGGElement {
  const p = el.parentNode as Element | null
  if (p && p.getAttribute && p.getAttribute('data-graf-wrap') === '1') return p as unknown as SVGGElement
  const g = document.createElementNS(SVGNS, 'g')
  g.setAttribute('data-graf-wrap', '1')
  p!.insertBefore(g, el)
  g.appendChild(el)
  return g
}

function grafPointerDown(e: PointerEvent): void {
  if (!svgEl) return
  if (editandoPuntos()) return // editando puntos: lo maneja la capa del editor
  if (reframeG) { iniciarPanReencuadre(e); return } // en reencuadre, arrastrar = mover la foto
  const el = graficoSeleccionable(e.target as Element)
  const aditivo = e.ctrlKey || e.metaKey
  if (!el) {
    // Clic en vacío: recuadro de selección (marquee). Sin Ctrl, limpia primero.
    e.preventDefault() // si no, arrastrar selecciona el TEXTO del SVG (resaltado azul)
    if (!aditivo) { grafSeleccion = []; limpiarGraf() }
    iniciarMarquee(e)
    return
  }
  e.preventDefault()
  if (aditivo) {
    // Ctrl+clic: agrega/quita de la selección (no arrastra).
    const i = grafSeleccion.indexOf(el)
    if (i >= 0) grafSeleccion.splice(i, 1); else grafSeleccion.push(el)
    dibujarSelGraf()
    return
  }
  // Clic normal: si no estaba seleccionado, pasa a ser la única selección.
  if (!grafSeleccion.includes(el)) grafSeleccion = [el]
  dibujarSelGraf()
  iniciarArrastreGraf(e)
}

// Arrastra todos los elementos seleccionados con el mismo delta.
function iniciarArrastreGraf(e: PointerEvent): void {
  if (!svgEl) return
  const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
  const wraps = grafSeleccion.map((el) => {
    const g = wrapperGraf(el)
    const tm = (g.getAttribute('transform') ?? '').match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)/)
    return { g, tx0: tm ? +tm[1] : 0, ty0: tm ? +tm[2] : 0 }
  })
  let sx = e.clientX, sy = e.clientY, accX = 0, accY = 0, movido = false
  const onMove = (ev: PointerEvent) => {
    accX += (ev.clientX - sx) / k; accY += (ev.clientY - sy) / k
    sx = ev.clientX; sy = ev.clientY
    if (Math.abs(accX) + Math.abs(accY) > 1) movido = true
    for (const w of wraps) w.g.setAttribute('transform', `translate(${w.tx0 + accX} ${w.ty0 + accY})`)
    dibujarSelGraf()
  }
  const onUp = () => {
    svgEl!.removeEventListener('pointermove', onMove)
    if (movido) { registrarHistorial(); autoguardar() }
  }
  try { svgEl.setPointerCapture(e.pointerId) } catch { /* igual arrastra */ }
  svgEl.addEventListener('pointermove', onMove)
  svgEl.addEventListener('pointerup', onUp, { once: true })
  svgEl.addEventListener('pointercancel', onUp, { once: true })
}

// Recuadro de selección por arrastre: selecciona todo lo que toca.
function iniciarMarquee(e: PointerEvent): void {
  if (!svgEl) return
  const base = lienzo.getBoundingClientRect()
  const x0 = e.clientX, y0 = e.clientY
  const div = document.createElement('div')
  div.className = 'graf-marquee'
  lienzo.appendChild(div)
  let movido = false
  const onMove = (ev: PointerEvent) => {
    const l = Math.min(x0, ev.clientX), t = Math.min(y0, ev.clientY)
    const w = Math.abs(ev.clientX - x0), h = Math.abs(ev.clientY - y0)
    if (w + h > 3) movido = true
    Object.assign(div.style, { left: l - base.left + 'px', top: t - base.top + 'px', width: w + 'px', height: h + 'px' })
  }
  const onUp = (ev: PointerEvent) => {
    svgEl!.removeEventListener('pointermove', onMove)
    div.remove()
    if (movido) {
      const rect = { left: Math.min(x0, ev.clientX), top: Math.min(y0, ev.clientY), right: Math.max(x0, ev.clientX), bottom: Math.max(y0, ev.clientY) }
      const hallados = elementosEnRect(rect)
      if (e.ctrlKey || e.metaKey) for (const el of hallados) { if (!grafSeleccion.includes(el)) grafSeleccion.push(el) }
      else grafSeleccion = hallados
      dibujarSelGraf()
    }
  }
  try { svgEl.setPointerCapture(e.pointerId) } catch { /* igual */ }
  svgEl.addEventListener('pointermove', onMove)
  svgEl.addEventListener('pointerup', onUp, { once: true })
  svgEl.addEventListener('pointercancel', onUp, { once: true })
}

// Unidades seleccionables cuyo bounding-box (en px) queda COMPLETAMENTE dentro del rect.
function elementosEnRect(rect: { left: number; top: number; right: number; bottom: number }): SVGElement[] {
  if (!svgEl) return []
  const vistos = new Set<SVGElement>()
  const out: SVGElement[] = []
  for (const leaf of Array.from(svgEl.querySelectorAll<SVGElement>('rect,circle,ellipse,path,polygon,polyline,line,image,use,text[data-agregado="texto"]'))) {
    const u = graficoSeleccionable(leaf)
    if (!u || vistos.has(u)) continue
    vistos.add(u)
    const b = u.getBoundingClientRect()
    if (b.width < 0.5 && b.height < 0.5) continue
    // Solo si el elemento queda COMPLETAMENTE dentro del recuadro (contención, no roce).
    if (b.left >= rect.left && b.right <= rect.right && b.top >= rect.top && b.bottom <= rect.bottom) out.push(u)
  }
  return out
}

function borrarGraf(): void {
  if (!grafSeleccion.length) return
  for (const el of grafSeleccion) nodoManip(el).remove()
  grafSeleccion = []
  limpiarGraf()
  registrarHistorial(); autoguardar()
}

// ============ Copiar / pegar / duplicar (modo Gráficos) ============
const SEL_GRAF = 'rect,circle,ellipse,path,polygon,polyline,line,image,use,text[data-agregado="texto"]'
let portapapeles: SVGElement[] = [] // clones de los elementos copiados

function actualizarBotonesEdicion(): void {
  const bc = document.querySelector<HTMLButtonElement>('#btn-copiar')
  const bp = document.querySelector<HTMLButtonElement>('#btn-pegar')
  if (bc) bc.disabled = !grafSeleccion.length
  if (bp) bp.disabled = !portapapeles.length
}

function copiarSeleccion(): void {
  if (!grafSeleccion.length) return
  portapapeles = grafSeleccion.map((el) => nodoManip(el).cloneNode(true) as SVGElement)
  estado.textContent = `${portapapeles.length} elemento(s) copiado(s)`
  actualizarBotonesEdicion()
}
function pegarPortapapeles(): void { if (portapapeles.length) clonarYPegar(portapapeles) }
function duplicarSeleccion(): void { if (grafSeleccion.length) clonarYPegar(grafSeleccion.map(nodoManip)) }

// Clona las fuentes, las pega con un pequeño offset y las deja seleccionadas.
function clonarYPegar(fuentes: SVGElement[]): void {
  if (!svgEl || !fuentes.length) return
  if (!modoGrafico) activarGrafico()
  const nuevos: SVGElement[] = []
  for (const fuente of fuentes) {
    const nodo = fuente.cloneNode(true) as SVGElement
    offsetTransform(nodo, 24, 24)
    svgEl.appendChild(nodo)
    independizarCampos(nodo) // si tiene texto editable, darle nombre nuevo + estado propio
    const hoja = (nodo.matches?.(SEL_GRAF) ? nodo : nodo.querySelector<SVGElement>(SEL_GRAF)) ?? nodo
    nuevos.push(graficoSeleccionable(hoja) ?? hoja)
  }
  construirOverlays() // registrar hits de los cuadros de texto recién pegados
  grafSeleccion = nuevos
  dibujarSelGraf()
  registrarHistorial(); autoguardar()
  estado.textContent = `${nuevos.length} elemento(s) pegado(s)`
}

// Tras pegar un clon: si contiene cuadros de texto editables (data-campo), les da
// un nombre nuevo y copia su estado, para que la copia sea independiente (editar
// una no toca a la otra).
function independizarCampos(nodo: SVGElement): void {
  const conCampo: Element[] = []
  if (nodo.getAttribute('data-campo')) conCampo.push(nodo)
  conCampo.push(...Array.from(nodo.querySelectorAll('[data-campo]')))
  if (!conCampo.length) return
  const renombres = new Map<string, string>()
  for (const el of conCampo) {
    const viejo = el.getAttribute('data-campo')!
    let nuevo = renombres.get(viejo)
    if (!nuevo) {
      contadorAgregados++
      nuevo = `copia_${contadorAgregados}`
      renombres.set(viejo, nuevo)
      if (valores[viejo] !== undefined) valores[nuevo] = valores[viejo]
      if (estilos[viejo]) estilos[nuevo] = { ...estilos[viejo] }
      if (metricas[viejo]) metricas[nuevo] = { ...metricas[viejo] }
      if (metaActual[viejo]) metaActual[nuevo] = { ...metaActual[viejo] }
      if (cajaAlto[viejo] !== undefined) cajaAlto[nuevo] = cajaAlto[viejo]
      bloqueado[nuevo] = false // la copia nace movible
      camposActuales.push({ nombre: nuevo, etiqueta: nuevo })
    }
    el.setAttribute('data-campo', nuevo)
  }
}

// Suma (dx,dy) al translate del transform (o lo antepone si no había).
function offsetTransform(el: SVGElement, dx: number, dy: number): void {
  const tr = el.getAttribute('transform') ?? ''
  const m = tr.match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)([^)]*)\)/)
  if (m) el.setAttribute('transform', tr.replace(m[0], `translate(${+m[1] + dx} ${+m[2] + dy}${m[3]})`))
  else el.setAttribute('transform', `translate(${dx} ${dy}) ${tr}`.trim())
}

// Agrupa la selección (≥2) en un <g data-grupo> para manejarla como una unidad.
function agruparSel(): void {
  if (!svgEl || grafSeleccion.length < 2) return
  const nodos = grafSeleccion.map(nodoManip)
  // Orden de documento para preservar el apilado (z-order).
  nodos.sort((a, b) => ((a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1))
  const ref = nodos[nodos.length - 1] // el grupo va donde está el más alto en z
  const g = document.createElementNS(SVGNS, 'g')
  g.setAttribute('data-grupo', '1')
  ref.parentNode!.insertBefore(g, ref.nextSibling)
  for (const n of nodos) g.appendChild(n)
  grafSeleccion = [g]
  dibujarSelGraf()
  registrarHistorial(); autoguardar()
}

// Desagrupa el grupo seleccionado (uno solo): saca los hijos preservando posición.
function desagruparSel(): void {
  if (!svgEl || grafSeleccion.length !== 1) return
  const sel = grafSeleccion[0]
  const wrap = (sel.getAttribute('data-graf-wrap') === '1') ? sel : null
  const grupo = wrap ? (wrap.firstElementChild as SVGElement | null) : sel
  if (!grupo || grupo.tagName.toLowerCase() !== 'g') return
  const objetivo = wrap ?? grupo
  // Hornear los transforms (wrapper + grupo) en cada hijo para no perder posición.
  const pre = [wrap?.getAttribute('transform') ?? '', grupo.getAttribute('transform') ?? ''].filter(Boolean).join(' ')
  const hijos = Array.from(grupo.children) as SVGElement[]
  for (const kid of hijos) {
    if (pre) { const prev = kid.getAttribute('transform') ?? ''; kid.setAttribute('transform', (pre + ' ' + prev).trim()) }
    objetivo.parentNode!.insertBefore(kid, objetivo)
  }
  objetivo.remove()
  grafSeleccion = hijos
  dibujarSelGraf()
  registrarHistorial(); autoguardar()
}

// El <g data-recorte> dentro de una selección (sea el propio nodo o su wrapper).
function grupoRecorteDe(sel: SVGElement): SVGElement | null {
  if (sel.getAttribute('data-recorte')) return sel
  const dentro = sel.querySelector('[data-recorte]')
  return (dentro as SVGElement | null)
}

// ¿El elemento aporta geometría de recorte? Sólo formas vectoriales y texto;
// una imagen <image> NO recorta (dejaría el clip vacío y todo desaparecería).
const FORMAS_RECORTE = ['rect', 'circle', 'ellipse', 'path', 'polygon', 'polyline', 'line', 'text']
function esFormaRecorte(el: SVGElement): boolean {
  if (FORMAS_RECORTE.includes(el.tagName.toLowerCase())) return true
  return !!el.querySelector(FORMAS_RECORTE.join(',')) // grupo/wrapper con alguna forma
}

// Crea una máscara de recorte: una FORMA recorta al resto (imágenes, etc.).
// Como en Illustrator: poner la forma encima, seleccionar todo y "Recortar".
// La máscara es la forma de más arriba; una imagen nunca puede ser la máscara.
function recortarConMascara(): void {
  if (!svgEl || !grafSeleccion.length) return
  // Trabajamos sobre los elementos REALES seleccionados (no sus wrappers de
  // arrastre, que ocultan data-agregado). Orden de documento (z): último = arriba.
  const sel = [...grafSeleccion]
  sel.sort((a, b) => ((a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1))
  const formas = sel.filter(esFormaRecorte)
  if (!formas.length) {
    estado.textContent = 'Para recortar necesitás una forma (vector) como máscara, no una imagen.'
    return
  }
  // La máscara: la forma que VOS agregaste (figura/pluma/ícono); si no hay, la de
  // más arriba. Así un vector de la plantilla tocado por error no es la máscara.
  const formasUsuario = formas.filter((f) => f.getAttribute('data-agregado') != null)
  const candidatas = formasUsuario.length ? formasUsuario : formas
  const mascaraSel = candidatas[candidatas.length - 1]
  const mascara = nodoManip(mascaraSel)
  const mb = mascara.getBoundingClientRect()
  const tocaMascara = (el: Element): boolean => {
    const cb = el.getBoundingClientRect()
    return cb.width > 1 && !(mb.right <= cb.left || mb.left >= cb.right || mb.bottom <= cb.top || mb.top >= cb.bottom)
  }
  // ¿Qué se recorta? Si seleccionaste contenido propio (otra forma/imagen agregada
  // o una foto), se respeta. Si NO (típico: la foto es el fondo a sangre y no se
  // puede clickear porque está tapada), se recorta la FOTO que la máscara tape —
  // que es lo que casi siempre se quiere. Evita recortar un vector de la plantilla
  // por error y que "desaparezca todo".
  const seleccionNoMask = sel.filter((e) => e !== mascaraSel)
  const eligioContenido = seleccionNoMask.some((n) =>
    n.getAttribute('data-agregado') != null || n.getAttribute('data-foto') != null ||
    n.querySelector('[data-agregado],[data-foto]'))
  // Área de superposición (px²) de la máscara con un elemento.
  const areaSuperpuesta = (el: Element): number => {
    const cb = el.getBoundingClientRect()
    const w = Math.min(mb.right, cb.right) - Math.max(mb.left, cb.left)
    const h = Math.min(mb.bottom, cb.bottom) - Math.max(mb.top, cb.top)
    return w > 0 && h > 0 ? w * h : 0
  }
  let contenido: SVGElement[]
  if (eligioContenido) {
    contenido = seleccionNoMask.map(nodoManip)
  } else {
    // Sin contenido elegido: recortar ÚNICAMENTE la foto que más tapa la máscara
    // (no todas las que rozan su bbox, para no arrastrar fotos vecinas).
    const fotos = Array.from(svgEl.querySelectorAll<SVGElement>('[data-foto]')).filter((im) =>
      (im.getAttribute('href') || im.getAttribute('xlink:href')) && areaSuperpuesta(im) > 0)
    fotos.sort((a, b) => areaSuperpuesta(b) - areaSuperpuesta(a))
    contenido = fotos.length ? [fotos[0]] : seleccionNoMask.map(nodoManip)
  }
  if (!contenido.length) return
  // La forma tiene que SUPERPONERSE con algo del contenido; si no, el recorte
  // quedaría vacío (todo desaparece). Avisar en vez de borrar el dibujo.
  if (!contenido.some(tocaMascara)) {
    estado.textContent = 'La forma no se superpone con la foto/imagen. Ponela ENCIMA de lo que querés recortar.'
    return
  }
  let defs = svgEl.querySelector('defs')
  if (!defs) { defs = document.createElementNS(SVGNS, 'defs'); svgEl.insertBefore(defs, svgEl.firstChild) }
  contadorAgregados++
  const id = 'recorte-' + contadorAgregados
  const clip = document.createElementNS(SVGNS, 'clipPath')
  clip.setAttribute('id', id)
  clip.setAttribute('clipPathUnits', 'userSpaceOnUse')
  defs.appendChild(clip)
  // Envolvemos el contenido EN SU LUGAR (donde estaba el más alto en z), sin
  // sacarlo de los grupos de la plantilla. El recorte nuevo es el único clip del
  // grupo. La máscara se expresa en el espacio de coordenadas de ESE grupo
  // (matriz relativa g⁻¹·máscara), así queda perfectamente alineada aunque la
  // plantilla tenga el contenido dentro de grupos escalados.
  const ref = contenido[contenido.length - 1]
  const g = document.createElementNS(SVGNS, 'g')
  g.setAttribute('data-grupo', '1')
  g.setAttribute('data-recorte', id)
  g.setAttribute('clip-path', `url(#${id})`)
  ref.parentNode!.insertBefore(g, ref.nextSibling)
  // La región de recorte: muestreamos el CONTORNO de la forma en píxeles de
  // PANTALLA (getScreenCTM, sin ambigüedades) y lo pasamos al espacio del grupo
  // recortado. Así queda alineado aunque la plantilla anide y escale todo.
  const dRecorte = contornoEnEspacioDe(mascaraSel, g)
  if (dRecorte) {
    const pth = document.createElementNS(SVGNS, 'path')
    pth.setAttribute('d', dRecorte)
    clip.appendChild(pth)
  } else {
    clip.appendChild(mascara) // fallback
  }
  for (const n of contenido) {
    quitarClipsPropios(n) // anular clips propios (hueco) — el recorte es el único
    g.appendChild(n)
  }
  // la forma máscara original (el círculo/figura que dibujaste) ya cumplió su rol
  if (dRecorte) nodoManip(mascaraSel).remove()
  grafSeleccion = [g]
  dibujarSelGraf()
  registrarHistorial(); autoguardar()
}

// Muestrea el contorno de una forma como lista de puntos [x,y], aplicando
// `transformar` a cada punto local. [] si no tiene longitud. Base común del
// recorte (contornoEnEspacioDe) y del buscatrazos (elementoAGeom).
function muestrearContorno(geo: SVGGeometryElement, transformar: (p: DOMPoint) => { x: number; y: number }): number[][] {
  let len = 0
  try { len = geo.getTotalLength() } catch { return [] }
  if (!len) return []
  const n = Math.min(800, Math.max(48, Math.round(len / 3)))
  const pt = svgEl!.createSVGPoint()
  const pts: number[][] = []
  for (let i = 0; i < n; i++) {
    let q: DOMPoint
    try { q = geo.getPointAtLength((i / n) * len) } catch { continue }
    pt.x = q.x; pt.y = q.y
    const r = transformar(pt)
    pts.push([r.x, r.y])
  }
  return pts
}

// Devuelve el atributo `d` del contorno de `forma`, expresado en el espacio de
// usuario de `destino`. Muestrea por pantalla (getScreenCTM) para no depender de
// los transforms anidados. Sirve para cualquier forma (círculo, polígono, path).
function contornoEnEspacioDe(forma: SVGElement, destino: SVGElement): string | null {
  if (!svgEl) return null
  const geo = (forma.getAttribute('data-foto') == null && (forma as unknown as SVGGeometryElement).getTotalLength)
    ? (forma as unknown as SVGGeometryElement)
    : (forma.querySelector('rect,circle,ellipse,path,polygon,polyline,line') as unknown as SVGGeometryElement | null)
  if (!geo || !geo.getTotalLength) return null
  const sCtm = (geo as unknown as SVGGraphicsElement).getScreenCTM()
  const dInv = (destino as unknown as SVGGraphicsElement).getScreenCTM()?.inverse()
  if (!sCtm || !dInv) return null
  const pts = muestrearContorno(geo, (p) => p.matrixTransform(sCtm).matrixTransform(dInv))
  if (pts.length < 3) return null
  const partes = pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`)
  return 'M ' + partes.join(' L ') + ' Z'
}

// ¿Hay una foto de hueco (con foto cargada) que esta forma tape? Para ofrecer
// "Recortar foto" cuando la foto es el fondo y no se puede clickear.
function hayFotoBajo(el: SVGElement): boolean {
  if (!svgEl) return false
  const mb = el.getBoundingClientRect()
  return Array.from(svgEl.querySelectorAll('[data-foto]')).some((im) => {
    if (!(im.getAttribute('href') || im.getAttribute('xlink:href'))) return false
    const cb = im.getBoundingClientRect()
    return cb.width > 1 && !(mb.right <= cb.left || mb.left >= cb.right || mb.bottom <= cb.top || mb.top >= cb.bottom)
  })
}

// --- Reencuadre: mover/zoomear la foto DENTRO del recorte, con el marco fijo ----
let reframeG: SVGElement | null = null
let reframeWrap: SVGGElement | null = null
let reframeClipAttr = ''
let reframeOutline: SVGPathElement | null = null
let reframePan = { x: 0, y: 0 }
let reframeZoom = 1
let reframeCen = { x: 0, y: 0 }
let reframeUnidad = 1 // unidades de usuario del grupo por píxel de pantalla

// Centro (bbox) a partir del atributo d de un path (números en pares x,y).
function bboxDeD(d: string): { x: number; y: number } {
  const nums = (d.match(/-?\d+\.?\d*/g) || []).map(Number)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i + 1 < nums.length; i += 2) {
    minX = Math.min(minX, nums[i]); maxX = Math.max(maxX, nums[i])
    minY = Math.min(minY, nums[i + 1]); maxY = Math.max(maxY, nums[i + 1])
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

function entrarReencuadre(g: SVGElement): void {
  if (!svgEl) return
  const foto = g.querySelector('[data-foto], image') as SVGElement | null
  if (!foto) return
  reframeG = g
  reframePan = { x: 0, y: 0 }; reframeZoom = 1
  // wrapper de reencuadre alrededor de la foto (el encuadre previo ya está horneado
  // en la foto al salir, así que siempre arrancamos uno nuevo).
  {
    reframeWrap = document.createElementNS(SVGNS, 'g')
    reframeWrap.setAttribute('class', 'reframe-wrap')
    foto.parentElement!.insertBefore(reframeWrap, foto)
    reframeWrap.appendChild(foto)
  }
  reframeWrap.style.opacity = '0.5' // foto completa atenuada para ver el contexto
  reframeClipAttr = g.getAttribute('clip-path') || ''
  g.removeAttribute('clip-path') // mostrar la foto completa mientras reencuadrás
  reframeUnidad = 1 / (((g as SVGGraphicsElement).getScreenCTM()?.a) || 1)
  const clipId = (reframeClipAttr.match(/#([^)"']+)/) || [])[1]
  const formaClip = clipId ? svgEl.querySelector(`clipPath[id="${clipId}"] > *`) : null
  const d = formaClip?.getAttribute('d') || ''
  reframeCen = d ? bboxDeD(d) : { x: 0, y: 0 }
  if (d) {
    reframeOutline = document.createElementNS(SVGNS, 'path')
    reframeOutline.setAttribute('d', d)
    reframeOutline.setAttribute('fill', 'none')
    reframeOutline.setAttribute('stroke', '#ff2d78')
    reframeOutline.setAttribute('stroke-width', String(2 * reframeUnidad))
    reframeOutline.setAttribute('stroke-dasharray', `${6 * reframeUnidad} ${4 * reframeUnidad}`)
    reframeOutline.setAttribute('pointer-events', 'none')
    g.appendChild(reframeOutline)
  }
  lienzo.classList.add('reencuadrando')
  limpiarGraf()
  svgEl.addEventListener('wheel', wheelReencuadre, { passive: false })
  dibujarBarraReencuadre()
}

function aplicarReencuadre(): void {
  if (!reframeWrap) return
  const { x: cx, y: cy } = reframeCen
  reframeWrap.setAttribute('transform',
    `translate(${reframePan.x} ${reframePan.y}) translate(${cx} ${cy}) scale(${reframeZoom}) translate(${-cx} ${-cy})`)
}

function salirReencuadre(): void {
  if (!reframeG || !svgEl) return
  if (reframeClipAttr) reframeG.setAttribute('clip-path', reframeClipAttr)
  reframeOutline?.remove(); reframeOutline = null
  // Hornear el encuadre en la foto y SACAR el wrapper, para no acumular wrappers
  // ni perder el encuadre al reentrar (reentrar arrancaría con pan/zoom en 0/1).
  if (reframeWrap) {
    reframeWrap.style.opacity = ''
    const wt = reframeWrap.getAttribute('transform') ?? ''
    for (const kid of Array.from(reframeWrap.children) as SVGElement[]) {
      if (wt) { const prev = kid.getAttribute('transform') ?? ''; kid.setAttribute('transform', (wt + ' ' + prev).trim()) }
      reframeWrap.parentNode!.insertBefore(kid, reframeWrap)
    }
    reframeWrap.remove()
  }
  lienzo.classList.remove('reencuadrando')
  svgEl.removeEventListener('wheel', wheelReencuadre)
  lienzo.querySelectorAll('.reframe-bar').forEach((n) => n.remove())
  const g = reframeG
  reframeG = null; reframeWrap = null
  grafSeleccion = [g]
  dibujarSelGraf()
  registrarHistorial(); autoguardar()
}

const REFRAME_ZOOM_MIN = 0.2, REFRAME_ZOOM_MAX = 4
function wheelReencuadre(e: WheelEvent): void {
  e.preventDefault()
  reframeZoom = Math.min(REFRAME_ZOOM_MAX, Math.max(REFRAME_ZOOM_MIN, reframeZoom * (e.deltaY < 0 ? 1.08 : 0.92)))
  aplicarReencuadre()
  const s = lienzo.querySelector<HTMLInputElement>('.reframe-bar input')
  if (s) s.value = String(reframeZoom)
}

function iniciarPanReencuadre(e: PointerEvent): void {
  if (!svgEl) return
  e.preventDefault()
  let sx = e.clientX, sy = e.clientY
  const onMove = (ev: PointerEvent) => {
    reframePan.x += (ev.clientX - sx) * reframeUnidad
    reframePan.y += (ev.clientY - sy) * reframeUnidad
    sx = ev.clientX; sy = ev.clientY
    aplicarReencuadre()
  }
  const onUp = () => svgEl!.removeEventListener('pointermove', onMove)
  try { svgEl.setPointerCapture(e.pointerId) } catch { /* igual */ }
  svgEl.addEventListener('pointermove', onMove)
  svgEl.addEventListener('pointerup', onUp, { once: true })
  svgEl.addEventListener('pointercancel', onUp, { once: true })
}

function dibujarBarraReencuadre(): void {
  lienzo.querySelectorAll('.reframe-bar').forEach((n) => n.remove())
  const bar = document.createElement('div'); bar.className = 'reframe-bar'
  bar.addEventListener('pointerdown', (e) => e.stopPropagation())
  const txt = document.createElement('span'); txt.textContent = 'Reencuadrar · arrastrá, rueda = zoom'
  const z = document.createElement('input'); z.type = 'range'; z.min = String(REFRAME_ZOOM_MIN); z.max = String(REFRAME_ZOOM_MAX); z.step = '0.01'; z.value = String(reframeZoom)
  z.addEventListener('input', () => { reframeZoom = parseFloat(z.value); aplicarReencuadre() })
  const ok = document.createElement('button'); ok.textContent = 'Listo'; ok.className = 'reframe-ok'
  ok.addEventListener('click', (e) => { e.stopPropagation(); salirReencuadre() })
  bar.append(txt, z, ok)
  lienzo.append(bar)
}

// Anula cualquier clip-path propio del elemento y sus descendientes (atributo,
// estilo inline o regla por CLASE CSS), para que solo aplique el recorte nuevo.
function quitarClipsPropios(raiz: SVGElement): void {
  const els: Element[] = [raiz, ...Array.from(raiz.querySelectorAll('*'))]
  for (const el of els) {
    if (el.getAttribute('clip-path')) el.removeAttribute('clip-path')
    const he = el as HTMLElement & SVGElement
    // forzar inline 'none' pisa cualquier clip-path heredado de una clase CSS
    if (he.style && getComputedStyle(el).clipPath !== 'none') he.style.clipPath = 'none'
  }
}

// Libera un recorte: devuelve el contenido y la forma máscara al lienzo.
function liberarRecorte(): void {
  if (!svgEl || grafSeleccion.length !== 1) return
  const sel = grafSeleccion[0]
  const g = grupoRecorteDe(sel)
  if (!g) return
  const id = g.getAttribute('data-recorte')!
  const clip = svgEl.querySelector('clipPath[id="' + id + '"]')
  const wrap = (sel.getAttribute('data-graf-wrap') === '1') ? sel : null
  const objetivo = wrap ?? g
  // Hornear los transforms (wrapper + grupo) para no perder posición.
  const pre = [wrap?.getAttribute('transform') ?? '', g.getAttribute('transform') ?? ''].filter(Boolean).join(' ')
  const aplicarPre = (el: SVGElement) => { if (pre) { const prev = el.getAttribute('transform') ?? ''; el.setAttribute('transform', (pre + ' ' + prev).trim()) } }
  const hijos = Array.from(g.children) as SVGElement[]
  for (const kid of hijos) { aplicarPre(kid); objetivo.parentNode!.insertBefore(kid, objetivo) }
  clip?.remove() // borrar el clipPath (su <path> es geometría de recorte, no una forma visible)
  objetivo.remove()
  grafSeleccion = hijos
  dibujarSelGraf()
  registrarHistorial(); autoguardar()
}

// Capas que deben quedar siempre al fondo (defs, estilos, y el rect de fondo).
function esCapaReservada(el: Element | null): boolean {
  if (!el) return false
  const t = el.tagName.toLowerCase()
  return t === 'defs' || t === 'style' || t === 'clippath' || t === 'metadata' ||
    (t === 'rect' && esFondo(el as SVGRectElement))
}

// Reordena el apilado (z-order) de la selección: subir/bajar un paso, al tope o al fondo.
function reordenarSel(modo: 'arriba' | 'abajo' | 'tope' | 'fondo'): void {
  if (!svgEl || !grafSeleccion.length) return
  const nodos = grafSeleccion.map(nodoManip)
  nodos.sort((a, b) => ((a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1)) // doc order (fondo→tope)
  const p = nodos[0].parentElement
  if (!p) return
  if (modo === 'tope') {
    for (const n of nodos) p.appendChild(n) // en orden de doc → preservan su orden relativo arriba
  } else if (modo === 'fondo') {
    let ref = p.firstElementChild
    while (esCapaReservada(ref)) ref = ref!.nextElementSibling
    for (const n of nodos) if (n !== ref) p.insertBefore(n, ref)
  } else if (modo === 'arriba') {
    for (const n of [...nodos].reverse()) { const s = n.nextElementSibling; if (s && !esCapaReservada(s)) p.insertBefore(s, n) }
  } else if (modo === 'abajo') {
    for (const n of nodos) { const s = n.previousElementSibling; if (s && !esCapaReservada(s)) p.insertBefore(n, s) }
  }
  dibujarSelGraf(); registrarHistorial(); autoguardar()
}

// --- Degradados de relleno -------------------------------------------------
interface ParadaGrad { color: string; pos: number } // pos 0..100

// id del gradiente si el fill del elemento es url(#...).
function gradIdDe(el: SVGElement): string | null {
  const f = el.style.fill || el.getAttribute('fill') || ''
  const m = f.match(/url\(["']?#([^"')]+)/)
  return m ? m[1] : null
}

// Lee el degradé actual del elemento, o uno por defecto desde su color sólido.
function leerDegradado(el: SVGElement): { stops: ParadaGrad[]; angulo: number } {
  const id = gradIdDe(el)
  const g = id ? svgEl?.querySelector(`linearGradient[id="${id}"]`) : null
  if (g) {
    const stops = Array.from(g.querySelectorAll('stop')).map((s) => ({
      color: aHex(s.getAttribute('stop-color') || '#000000'),
      pos: Math.round(parseFloat(s.getAttribute('offset') || '0') * 100),
    }))
    const x1 = +(g.getAttribute('x1') ?? 0), y1 = +(g.getAttribute('y1') ?? 0)
    const x2 = +(g.getAttribute('x2') ?? 1), y2 = +(g.getAttribute('y2') ?? 0)
    const ang = Math.round((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI)
    if (stops.length >= 2) return { stops, angulo: (ang + 360) % 360 }
  }
  const c = getComputedStyle(el).fill
  const hex = c && c !== 'none' ? aHex(c) : '#38bdf8'
  return { stops: [{ color: hex, pos: 0 }, { color: '#ffffff', pos: 100 }], angulo: 0 }
}

// Crea/actualiza un linearGradient en defs y lo aplica como fill a los elementos.
function aplicarDegradado(els: SVGElement[], stops: ParadaGrad[], angulo: number): void {
  if (!svgEl || !els.length) return
  let defs = svgEl.querySelector('defs')
  if (!defs) { defs = document.createElementNS(SVGNS, 'defs'); svgEl.insertBefore(defs, svgEl.firstChild) }
  let id = gradIdDe(els[0])
  let grad = id ? svgEl.querySelector(`linearGradient[id="${id}"]`) : null
  if (!grad) {
    contadorAgregados++; id = 'grad-' + contadorAgregados
    grad = document.createElementNS(SVGNS, 'linearGradient')
    grad.setAttribute('id', id)
    defs.appendChild(grad)
  }
  const t = (angulo * Math.PI) / 180
  grad.setAttribute('x1', (0.5 - Math.cos(t) / 2).toFixed(4))
  grad.setAttribute('y1', (0.5 - Math.sin(t) / 2).toFixed(4))
  grad.setAttribute('x2', (0.5 + Math.cos(t) / 2).toFixed(4))
  grad.setAttribute('y2', (0.5 + Math.sin(t) / 2).toFixed(4))
  while (grad.firstChild) grad.removeChild(grad.firstChild)
  const ordenadas = [...stops].sort((a, b) => a.pos - b.pos)
  for (const s of ordenadas) {
    const st = document.createElementNS(SVGNS, 'stop')
    st.setAttribute('offset', String(s.pos / 100))
    st.setAttribute('stop-color', s.color)
    grad.appendChild(st)
  }
  for (const el of els) el.style.fill = `url(#${id})`
}

// Panel flotante para editar el degradé de la selección.
function abrirPanelDegradado(els: SVGElement[]): void {
  lienzo.querySelectorAll('.grad-panel').forEach((n) => n.remove())
  const estado0 = leerDegradado(els[0])
  let stops = estado0.stops
  let angulo = estado0.angulo
  const panel = document.createElement('div')
  panel.className = 'grad-panel'
  panel.addEventListener('pointerdown', (e) => e.stopPropagation())
  const aplicar = () => aplicarDegradado(els, stops, angulo)
  const render = () => {
    panel.innerHTML = '<div class="grad-head">Degradado <button class="grad-cerrar">✕</button></div>'
    const lista = document.createElement('div'); lista.className = 'grad-stops'
    stops.forEach((s, i) => {
      const fila = document.createElement('div'); fila.className = 'grad-fila'
      const col = document.createElement('input'); col.type = 'color'; col.value = s.color
      col.addEventListener('input', () => { stops[i].color = col.value; aplicar() })
      const pos = document.createElement('input'); pos.type = 'range'; pos.min = '0'; pos.max = '100'; pos.value = String(s.pos)
      pos.addEventListener('input', () => { stops[i].pos = +pos.value; aplicar() })
      fila.append(col, pos)
      if (stops.length > 2) {
        const del = document.createElement('button'); del.className = 'grad-del-stop'; del.textContent = '−'
        del.addEventListener('click', () => { stops.splice(i, 1); aplicar(); render() })
        fila.append(del)
      }
      lista.append(fila)
    })
    panel.append(lista)
    const add = document.createElement('button'); add.className = 'grad-add'; add.textContent = '+ color'
    add.addEventListener('click', () => { stops.push({ color: '#000000', pos: 100 }); aplicar(); render() })
    const angLab = document.createElement('label'); angLab.className = 'grad-ang'; angLab.textContent = 'Ángulo '
    const ang = document.createElement('input'); ang.type = 'range'; ang.min = '0'; ang.max = '360'; ang.value = String(angulo)
    ang.addEventListener('input', () => { angulo = +ang.value; aplicar() })
    angLab.append(ang)
    panel.append(add, angLab)
    panel.querySelector('.grad-cerrar')!.addEventListener('click', () => { registrarHistorial(); autoguardar(); panel.remove() })
  }
  render()
  lienzo.append(panel)
  aplicar()
}

// --- Alinear / distribuir --------------------------------------------------
// Desplaza un elemento (vía su wrapper) por dx,dy en unidades de usuario.
function desplazarNodo(sel: SVGElement, dxU: number, dyU: number): void {
  const g = wrapperGraf(sel)
  const tm = (g.getAttribute('transform') ?? '').match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)/)
  const tx = tm ? +tm[1] : 0, ty = tm ? +tm[2] : 0
  g.setAttribute('transform', `translate(${tx + dxU} ${ty + dyU})`)
}

type ModoAlinear = 'izq' | 'centroH' | 'der' | 'arriba' | 'medioV' | 'abajo'
// Alinea la selección respecto del PRIMER elemento elegido (key object).
function alinear(modo: ModoAlinear): void {
  if (!svgEl || grafSeleccion.length < 2) return
  const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
  const rects = grafSeleccion.map((el) => el.getBoundingClientRect())
  const key = rects[0]
  for (let i = 1; i < grafSeleccion.length; i++) {
    const r = rects[i]; let dx = 0, dy = 0
    switch (modo) {
      case 'izq': dx = key.left - r.left; break
      case 'der': dx = key.right - r.right; break
      case 'centroH': dx = (key.left + key.right) / 2 - (r.left + r.right) / 2; break
      case 'arriba': dy = key.top - r.top; break
      case 'abajo': dy = key.bottom - r.bottom; break
      case 'medioV': dy = (key.top + key.bottom) / 2 - (r.top + r.bottom) / 2; break
    }
    if (dx || dy) desplazarNodo(grafSeleccion[i], dx / k, dy / k)
  }
  dibujarSelGraf(); registrarHistorial(); autoguardar()
}

// Distribuye los centros de la selección de forma pareja entre los extremos.
function distribuir(eje: 'h' | 'v'): void {
  if (!svgEl || grafSeleccion.length < 3) return
  const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
  const items = grafSeleccion.map((el) => {
    const r = el.getBoundingClientRect()
    return { el, c: eje === 'h' ? (r.left + r.right) / 2 : (r.top + r.bottom) / 2 }
  }).sort((a, b) => a.c - b.c)
  const min = items[0].c, max = items[items.length - 1].c
  const paso = (max - min) / (items.length - 1)
  items.forEach((it, i) => {
    if (i === 0 || i === items.length - 1) return
    const objetivo = min + paso * i
    const d = (objetivo - it.c) / k
    desplazarNodo(it.el, eje === 'h' ? d : 0, eje === 'h' ? 0 : d)
  })
  dibujarSelGraf(); registrarHistorial(); autoguardar()
}

// Crea un popover flotante (cierra los otros), con cabecera + botón ✕. Devuelve el
// panel para que el llamador le agregue el cuerpo.
function crearPopover(titulo: string): HTMLDivElement {
  lienzo.querySelectorAll('.alinear-panel').forEach((n) => n.remove())
  const panel = document.createElement('div')
  panel.className = 'alinear-panel'
  panel.addEventListener('pointerdown', (e) => e.stopPropagation())
  panel.innerHTML = `<div class="alinear-head">${titulo} <button class="alinear-cerrar">✕</button></div>`
  panel.querySelector('.alinear-cerrar')!.addEventListener('click', () => panel.remove())
  lienzo.append(panel)
  return panel
}

// Popover con los botones de alinear/distribuir.
function abrirPanelAlinear(): void {
  const panel = crearPopover('Alinear (respecto del 1.º)')
  const btns: [string, () => void, string][] = [
    ['⊣', () => alinear('izq'), 'Alinear a la izquierda'],
    ['⊪', () => alinear('centroH'), 'Centrar horizontal'],
    ['⊢', () => alinear('der'), 'Alinear a la derecha'],
    ['⊤', () => alinear('arriba'), 'Alinear arriba'],
    ['⊫', () => alinear('medioV'), 'Centrar vertical'],
    ['⊥', () => alinear('abajo'), 'Alinear abajo'],
    ['↔', () => distribuir('h'), 'Distribuir horizontal'],
    ['↕', () => distribuir('v'), 'Distribuir vertical'],
  ]
  const grid = document.createElement('div'); grid.className = 'alinear-grid'
  for (const [icono, fn, titulo] of btns) {
    const b = document.createElement('button'); b.textContent = icono; b.title = titulo
    b.addEventListener('click', (e) => { e.stopPropagation(); fn() })
    grid.append(b)
  }
  panel.append(grid)
}

// --- Buscatrazos (operaciones booleanas de formas) -------------------------
// Aplana una forma a un polígono (anillo) en coords de usuario del SVG, muestreando
// su contorno y aplicando su matriz (CTM) para respetar transform/escala.
function elementoAGeom(el: SVGGraphicsElement): number[][][] {
  const ctm = el.getCTM()
  const ring = muestrearContorno(el as unknown as SVGGeometryElement, (p) => (ctm ? p.matrixTransform(ctm) : p))
  if (ring.length < 3) return []
  ring.push([...ring[0]])
  return [ring] // un Polygon = [anillo]
}

// MultiPolygon de polygon-clipping → atributo d (con fill-rule evenodd).
function multiPolygonAPath(mp: number[][][][]): string {
  let d = ''
  for (const poly of mp) for (const ring of poly) {
    if (ring.length < 3) continue
    d += 'M ' + ring.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ') + ' Z '
  }
  return d.trim()
}

type OpBool = 'unir' | 'restar' | 'intersecar' | 'excluir'
// Combina las formas seleccionadas en un único path (unión/resta/intersección/exclusión).
function buscatrazos(op: OpBool): void {
  if (!svgEl || grafSeleccion.length < 2) return
  const nodos = [...grafSeleccion]
  nodos.sort((a, b) => ((a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1)) // fondo→tope
  const geoms = nodos.map((n) => elementoAGeom(n as SVGGraphicsElement)).filter((g) => g.length)
  if (geoms.length < 2) { estado.textContent = 'No se pudieron convertir las formas (¿son cerradas?).'; return }
  const pc = polygonClipping as unknown as Record<string, (...a: unknown[]) => number[][][][]>
  const fn = ({ unir: pc.union, restar: pc.difference, intersecar: pc.intersection, excluir: pc.xor })[op]
  let res: number[][][][]
  try { res = fn(geoms[0], ...geoms.slice(1)) } catch { estado.textContent = 'No se pudo combinar las formas.'; return }
  const d = multiPolygonAPath(res)
  if (!d) { estado.textContent = 'El resultado quedó vacío.'; return }
  const path = document.createElementNS(SVGNS, 'path')
  path.setAttribute('d', d)
  path.setAttribute('fill-rule', 'evenodd')
  const ref = nodos[0] // estilo del de más abajo
  const fill = ref.style.fill || ref.getAttribute('fill') || '#38bdf8'
  path.style.fill = fill
  const stroke = ref.style.stroke || ref.getAttribute('stroke')
  if (stroke && stroke !== 'none') { path.setAttribute('stroke', stroke); path.setAttribute('stroke-width', ref.getAttribute('stroke-width') || '2'); path.setAttribute('stroke-linejoin', 'round') }
  path.setAttribute('data-agregado', 'figura')
  path.setAttribute('data-colormode', 'fill')
  const top = nodoManip(nodos[nodos.length - 1])
  top.parentNode!.insertBefore(path, top.nextSibling)
  for (const n of nodos) nodoManip(n).remove()
  grafSeleccion = [path]
  dibujarSelGraf(); registrarHistorial(); autoguardar()
}

// Popover con las operaciones de buscatrazos.
function abrirPanelBuscatrazos(): void {
  const panel = crearPopover('Buscatrazos')
  const ops: [string, OpBool][] = [['Unir', 'unir'], ['Restar', 'restar'], ['Intersecar', 'intersecar'], ['Excluir', 'excluir']]
  const grid = document.createElement('div'); grid.className = 'bt-grid'
  for (const [txt, op] of ops) {
    const b = document.createElement('button'); b.textContent = txt
    b.addEventListener('click', (e) => { e.stopPropagation(); buscatrazos(op) })
    grid.append(b)
  }
  panel.append(grid)
}

// Popover "Más": capas (frente/atrás/subir/bajar) y, si hay varios, alinear y
// buscatrazos. Mantiene la barra principal despejada.
function abrirPanelMas(): void {
  const multi = grafSeleccion.length > 1
  const panel = crearPopover('Más')
  const cont = document.createElement('div'); cont.className = 'mas-cont'
  const capas: [string, 'arriba' | 'abajo' | 'tope' | 'fondo'][] = [
    ['↟ Traer al frente', 'tope'], ['↑ Subir una capa', 'arriba'],
    ['↓ Bajar una capa', 'abajo'], ['↡ Enviar al fondo', 'fondo'],
  ]
  for (const [txt, modo] of capas) {
    const b = document.createElement('button'); b.className = 'mas-btn'; b.textContent = txt
    b.addEventListener('click', (e) => { e.stopPropagation(); reordenarSel(modo) })
    cont.append(b)
  }
  if (multi) {
    const a = document.createElement('button'); a.className = 'mas-btn'; a.textContent = '⊟ Alinear / distribuir'
    a.addEventListener('click', (e) => { e.stopPropagation(); abrirPanelAlinear() })
    cont.append(a)
    const bt = document.createElement('button'); bt.className = 'mas-btn'; bt.textContent = '◳ Buscatrazos'
    bt.addEventListener('click', (e) => { e.stopPropagation(); abrirPanelBuscatrazos() })
    cont.append(bt)
  }
  panel.append(cont)
}

// Dibuja recuadro(s) de selección + mini-barra (relleno, contorno, agrupar/desagrupar, borrar).
function dibujarSelGraf(): void {
  limpiarGraf()
  if (!grafSeleccion.length || !svgEl) return
  const base = lienzo.getBoundingClientRect()
  const rects = grafSeleccion.map((el) => {
    const rb = el.getBoundingClientRect()
    return { left: rb.left - base.left, top: rb.top - base.top, width: rb.width, height: rb.height }
  })
  for (const r of rects) {
    const box = document.createElement('div')
    box.className = 'graf-sel'
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
    lienzo.appendChild(box)
  }
  const minL = Math.min(...rects.map((r) => r.left))
  const minT = Math.min(...rects.map((r) => r.top))
  const maxR = Math.max(...rects.map((r) => r.left + r.width))
  const maxB = Math.max(...rects.map((r) => r.top + r.height))
  const uni: Rect = { left: minL, top: minT, width: maxR - minL, height: maxB - minT }

  const tools = document.createElement('div')
  tools.className = 'graf-tools'
  Object.assign(tools.style, { left: uni.left + 'px', top: Math.max(0, uni.top - 34) + 'px' })
  tools.addEventListener('pointerdown', (e) => e.stopPropagation())

  const multi = grafSeleccion.length > 1
  const cs = getComputedStyle(grafSeleccion[0])
  // Swatch con color + botón "∅" para vaciarlo (sin relleno / sin contorno).
  const swatch = (titulo: string, esStroke: boolean, cur: string, def: string, set: (v: string) => void): HTMLLabelElement => {
    const vacio = !cur || cur === 'none' || cur === 'rgba(0, 0, 0, 0)' || cur === 'transparent'
    const lab = document.createElement('label'); lab.title = titulo
    lab.className = 'graf-color' + (esStroke ? ' graf-stroke' : '') + (vacio ? ' vacio' : '')
    const inp = document.createElement('input'); inp.type = 'color'
    inp.value = !vacio ? aHex(cur) : def
    inp.addEventListener('input', () => {
      lab.classList.remove('vacio')
      set(inp.value)
      registrarHistorial(); autoguardar()
    })
    const x = document.createElement('button'); x.className = 'graf-vaciar'; x.textContent = '∅'
    x.title = esStroke ? 'Sin contorno' : 'Relleno transparente'
    x.addEventListener('pointerdown', (e) => e.stopPropagation())
    x.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation()
      lab.classList.add('vacio')
      set('none')
      registrarHistorial(); autoguardar()
    })
    lab.append(inp, x)
    return lab
  }
  const fill = swatch('Relleno', false, cs.fill, '#ffffff', (v) => { for (const el of grafSeleccion) el.style.fill = v })
  const stroke = swatch('Contorno', true, cs.stroke, '#000000', (v) => { for (const el of grafSeleccion) el.style.stroke = v })
  tools.append(fill, stroke)

  // Opacidad (0 = transparente, 1 = sólido). Aplica a toda la selección.
  const opac = document.createElement('label'); opac.className = 'graf-opac'; opac.title = 'Opacidad'
  const oi = document.createElement('input'); oi.type = 'range'; oi.min = '0'; oi.max = '1'; oi.step = '0.01'
  const op0 = parseFloat(getComputedStyle(grafSeleccion[0]).opacity || '1')
  oi.value = String(isNaN(op0) ? 1 : op0)
  oi.addEventListener('input', () => { for (const el of grafSeleccion) el.style.opacity = oi.value })
  oi.addEventListener('change', () => { registrarHistorial(); autoguardar() })
  oi.addEventListener('pointerdown', (e) => e.stopPropagation())
  opac.append('◑', oi)
  tools.append(opac)

  // Degradado de relleno
  const grad = document.createElement('button'); grad.className = 'graf-btn graf-grad'; grad.textContent = '▦'; grad.title = 'Degradado de relleno'
  grad.addEventListener('click', (e) => { e.stopPropagation(); abrirPanelDegradado([...grafSeleccion]) })
  tools.append(grad)

  if (multi) {
    const grp = document.createElement('button'); grp.className = 'graf-btn'; grp.textContent = 'Agrupar'; grp.title = 'Agrupar (Ctrl+G)'
    grp.addEventListener('click', (e) => { e.stopPropagation(); agruparSel() })
    tools.appendChild(grp)
    const rec = document.createElement('button'); rec.className = 'graf-btn'; rec.textContent = '✂ Recortar'; rec.title = 'Crear máscara de recorte: la forma de arriba recorta al resto (Ctrl+7)'
    rec.addEventListener('click', (e) => { e.stopPropagation(); recortarConMascara() })
    tools.appendChild(rec)
  } else if (grupoRecorteDe(grafSeleccion[0])) {
    const rg = grupoRecorteDe(grafSeleccion[0])!
    if (rg.querySelector('[data-foto], image')) {
      const ref = document.createElement('button'); ref.className = 'graf-btn'; ref.textContent = '⤢ Reencuadrar'; ref.title = 'Mover/zoomear la foto dentro del recorte (marco fijo)'
      ref.addEventListener('click', (e) => { e.stopPropagation(); entrarReencuadre(rg) })
      tools.appendChild(ref)
    }
    const lib = document.createElement('button'); lib.className = 'graf-btn'; lib.textContent = '✂ Quitar recorte'; lib.title = 'Liberar la máscara de recorte (Ctrl+Alt+7)'
    lib.addEventListener('click', (e) => { e.stopPropagation(); liberarRecorte() })
    tools.appendChild(lib)
  } else if (grafSeleccion[0].getAttribute('data-agregado') != null && esFormaRecorte(grafSeleccion[0]) && hayFotoBajo(grafSeleccion[0])) {
    // Una forma tuya sobre la foto de fondo (que no se puede clickear): recortar
    // la foto con esta forma directamente, sin tener que seleccionar la foto.
    const rec = document.createElement('button'); rec.className = 'graf-btn'; rec.textContent = '✂ Recortar foto'; rec.title = 'Recortar la foto del fondo con esta forma (Ctrl+7)'
    rec.addEventListener('click', (e) => { e.stopPropagation(); recortarConMascara() })
    tools.appendChild(rec)
  } else if (grafSeleccion[0].tagName.toLowerCase() === 'g') {
    const ung = document.createElement('button'); ung.className = 'graf-btn'; ung.textContent = 'Desagrupar'; ung.title = 'Desagrupar (Ctrl+Shift+G)'
    ung.addEventListener('click', (e) => { e.stopPropagation(); desagruparSel() })
    tools.appendChild(ung)
  }

  // Editar puntos: solo para un path (trazo) suelto.
  if (!multi && grafSeleccion[0].tagName.toLowerCase() === 'path') {
    const ep = document.createElement('button'); ep.className = 'graf-btn'; ep.textContent = '✎ Puntos'; ep.title = 'Editar los puntos del trazo (mover anclas y manijas)'
    ep.addEventListener('click', (e) => { e.stopPropagation(); entrarEditarPuntos(grafSeleccion[0] as SVGPathElement) })
    tools.appendChild(ep)
  }

  // Secundarios (capas, alinear, buscatrazos) en un menú "Más" para no saturar.
  const mas = document.createElement('button'); mas.className = 'graf-btn'; mas.textContent = '⋯ Más'; mas.title = 'Capas, alinear, buscatrazos'
  mas.addEventListener('click', (e) => { e.stopPropagation(); abrirPanelMas() })
  tools.appendChild(mas)

  const del = document.createElement('button'); del.className = 'graf-del'; del.textContent = '✕'; del.title = 'Eliminar'
  del.addEventListener('click', (e) => { e.stopPropagation(); borrarGraf() })
  tools.appendChild(del)
  lienzo.appendChild(tools)
  // Mantener el toolbar dentro del lienzo (overflow:hidden lo cortaría en los bordes).
  const maxL = Math.max(4, lienzo.clientWidth - tools.offsetWidth - 4)
  tools.style.left = Math.max(4, Math.min(uni.left, maxL)) + 'px'
  if (uni.top - 34 < 0) tools.style.top = Math.min(uni.top + uni.height + 6, lienzo.clientHeight - tools.offsetHeight - 4) + 'px'

  if (!multi) {
    lienzo.appendChild(crearTiradorEscalaGraf(uni, 'x'))  // ancho
    lienzo.appendChild(crearTiradorEscalaGraf(uni, 'y'))  // alto
    lienzo.appendChild(crearTiradorEscalaGraf(uni, 'xy')) // proporcional (esquina)
  }
}

// Calcula (sx, sy) de un tirador de escala: esquina (xy) o Shift = proporcional;
// costados (x/y) = libre en un solo eje. El pivote/transform los pone el llamador.
function calcularEscalaTirador(
  eje: 'x' | 'y' | 'xy', accX: number, accY: number,
  sx0: number, sy0: number, bw: number, bh: number, k: number, shift: boolean,
): { sx: number; sy: number } {
  if (eje === 'xy' || shift) {
    const denom = eje === 'y' ? Math.max(bh * sy0 * k, 1) : Math.max(bw * sx0 * k, 1)
    const delta = eje === 'y' ? accY : accX
    const f = Math.max(0.04, 1 + delta / denom)
    return { sx: Math.max(0.04, sx0 * f), sy: Math.max(0.04, sy0 * f) }
  }
  return {
    sx: eje !== 'y' ? Math.max(0.04, sx0 + accX / (bw * k)) : sx0,
    sy: eje !== 'x' ? Math.max(0.04, sy0 + accY / (bh * k)) : sy0,
  }
}

// Tirador de escala para la selección de modo Gráficos: escala el WRAPPER del
// elemento (preserva matrices de Illustrator). Delega en crearTiradorEscala.
function crearTiradorEscalaGraf(r: Rect, eje: 'x' | 'y' | 'xy' = 'xy'): HTMLDivElement {
  return crearTiradorEscala(r, grafSeleccion[0], eje, {
    wrap: true,
    onFin: () => { registrarHistorial(); autoguardar(); dibujarSelGraf() },
  })
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
      if (Math.abs(dxs) + Math.abs(dys) > 3 && !movido) {
        movido = true
        // Al empezar a mover: ocultar los overlays de los DEMÁS para que no
        // queden líneas punteadas flotando sobre lo que estás arrastrando.
        lienzo.classList.add('arrastrando'); hit.classList.add('activo')
      }
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
      lienzo.classList.remove('arrastrando'); hit.classList.remove('activo')
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

// Lee el scale del transform como par {sx, sy}. scale(s) → sx=sy=s.
function leerScale(tr: string): { sx: number; sy: number } {
  const m = tr.match(/scale\(\s*([-\d.]+)(?:[\s,]+([-\d.]+))?\s*\)/)
  if (!m) return { sx: 1, sy: 1 }
  const sx = +m[1]
  return { sx, sy: m[2] != null ? +m[2] : sx }
}

// Tirador de redimensión (figuras/íconos/imágenes/recortes/grupos). Escala el
// `el` (o su wrapper si opts.wrap) con pivote fijo en la esquina sup-izq del bbox.
// eje 'xy' = esquina (proporcional), 'x'/'y' = costado (libre). Shift = proporcional.
function crearTiradorEscala(
  r: Rect, el: SVGElement, eje: 'x' | 'y' | 'xy' = 'xy',
  opts?: { wrap?: boolean; onFin?: () => void },
): HTMLDivElement {
  const h = document.createElement('div')
  h.className = 'resize-handle resize-handle-' + eje
  const left = eje === 'y' ? r.left + r.width / 2 - 7 : r.left + r.width - 7
  const top = eje === 'x' ? r.top + r.height / 2 - 7 : r.top + r.height - 7
  Object.assign(h.style, { left: left + 'px', top: top + 'px' })
  h.addEventListener('pointerdown', (e) => {
    if (!svgEl || !el) return
    e.preventDefault(); e.stopPropagation()
    const target = opts?.wrap ? wrapperGraf(el) : el
    const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
    const tr = target.getAttribute('transform') ?? ''
    const tm = tr.match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)/)
    const cx0 = tm ? +tm[1] : 0, cy0 = tm ? +tm[2] : 0
    const s0 = leerScale(tr)
    const sx0 = s0.sx, sy0 = s0.sy
    let baseW = 100, baseH = 100, bx = 0, by = 0
    try { const bb = (target as SVGGraphicsElement).getBBox(); baseW = bb.width || 100; baseH = bb.height || 100; bx = bb.x; by = bb.y } catch { /* default */ }
    const ax = cx0 + sx0 * bx, ay = cy0 + sy0 * by // posición fija del pivote (esquina sup-izq del bbox)
    const hx0 = parseFloat(h.style.left), hy0 = parseFloat(h.style.top)
    const startX = e.clientX, startY = e.clientY
    const onMove = (ev: PointerEvent) => {
      const { sx, sy } = calcularEscalaTirador(eje, ev.clientX - startX, ev.clientY - startY, sx0, sy0, baseW, baseH, k, ev.shiftKey)
      target.setAttribute('transform', `translate(${ax - sx * bx} ${ay - sy * by}) scale(${sx.toFixed(4)} ${sy.toFixed(4)})`)
      h.style.left = hx0 + (sx - sx0) * baseW * k + 'px'
      h.style.top = hy0 + (sy - sy0) * baseH * k + 'px'
    }
    const onUp = () => { h.removeEventListener('pointermove', onMove); (opts?.onFin ?? construirOverlays)() }
    try { h.setPointerCapture(e.pointerId) } catch { /* igual escala */ }
    h.addEventListener('pointermove', onMove)
    h.addEventListener('pointerup', onUp, { once: true })
    h.addEventListener('pointercancel', onUp, { once: true })
  })
  return h
}

// Selector de color para una figura/ícono (relleno o borde según data-colormode).
// Swatch de color para 'fill' (relleno) o 'stroke' (contorno) de una figura/ícono.
function crearSwatch(r: Rect, el: SVGElement, prop: 'fill' | 'stroke', idx: number): HTMLLabelElement {
  const wrap = document.createElement('label')
  wrap.className = 'swatch-figura swatch-' + prop
  wrap.title = prop === 'fill' ? 'Color de relleno' : 'Color de contorno'
  Object.assign(wrap.style, { left: r.left - 2 + idx * 84 + 'px', top: r.top - 30 + 'px' })
  const actual = el.getAttribute(prop) || ''
  const sinColor = !actual || actual === 'none'
  if (sinColor) wrap.classList.add('vacio')
  const inp = document.createElement('input')
  inp.type = 'color'
  inp.value = sinColor ? (prop === 'fill' ? '#38bdf8' : '#06121c') : aHex(actual)
  inp.addEventListener('input', () => {
    wrap.classList.remove('vacio')
    el.setAttribute(prop, inp.value)
    // El contorno necesita un ancho para verse; si no lo tiene, darle uno.
    if (prop === 'stroke' && !el.getAttribute('stroke-width')) el.setAttribute('stroke-width', '4')
    registrarHistorial()
  })
  inp.addEventListener('pointerdown', (e) => e.stopPropagation())
  const cap = document.createElement('span')
  cap.className = 'swatch-cap'
  cap.textContent = prop === 'fill' ? 'Relleno' : 'Contorno'
  // Botón para vaciar: relleno transparente / sin contorno.
  const x = document.createElement('button')
  x.className = 'swatch-vaciar'; x.textContent = '∅'
  x.title = prop === 'fill' ? 'Relleno transparente' : 'Sin contorno'
  x.addEventListener('pointerdown', (e) => e.stopPropagation())
  x.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation()
    wrap.classList.add('vacio')
    el.setAttribute(prop, 'none')
    registrarHistorial()
  })
  wrap.appendChild(inp)
  wrap.appendChild(cap)
  wrap.appendChild(x)
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
  lienzo.querySelectorAll('.hit, .foto-tools, .btn-eliminar, .resize-handle, .btn-candado, .resize-ancho, .resize-caja, .guia, .swatch-figura, .mascara-wrap, .mask-handle').forEach((n) => n.remove())
  zoomSlider = null
  const base = lienzo.getBoundingClientRect()

  // Fotos primero (quedan DEBAJO de los textos). Una por cada hueco de la plantilla.
  for (const img of Array.from(svgEl.querySelectorAll('[data-foto]'))) {
    const id = img.getAttribute('data-foto')!
    // Foto YA recortada: en modo normal se mueve/elimina el RECORTE COMPLETO (no se
    // reencuadra). El reencuadre se hace con el botón "Reencuadrar" en modo Gráficos.
    const rec = img.closest('[data-recorte]') as SVGElement | null
    if (rec) {
      const rr = rectUnion([rec], base)
      if (!rr) continue
      const hit = crearHit(rr, 'recorte', () => {})
      hit.classList.add('hit-agregado')
      hit.title = 'Arrastrá para mover el recorte (para reencuadrar: Gráficos → Reencuadrar)'
      habilitarArrastreEl(hit, rec)
      lienzo.appendChild(hit)
      const ctrls = [
        crearBotonEliminar(rr, () => { rec.remove(); construirOverlays() }),
        crearTiradorEscala(rr, rec, 'x'),  // ancho
        crearTiradorEscala(rr, rec, 'y'),  // alto
        crearTiradorEscala(rr, rec, 'xy'), // proporcional (esquina)
      ]
      for (const c of ctrls) lienzo.appendChild(c)
      revelarAlHover(hit, ctrls)
      continue
    }
    const r = rectFotoVisible(img, base)
    if (!r) continue
    const tieneFoto = !!fotos[id]
    const hit = crearHit(r, 'foto', () => { if (!fotos[id]) { fotoActiva = id; inFoto.click() } })
    hit.classList.add('hit-foto')
    hit.title = tieneFoto ? 'Arrastrá para encuadrar · rueda para zoom' : 'Subir foto'
    lienzo.appendChild(hit)
    if (tieneFoto && framesFoto[id]) {
      habilitarPanZoom(hit, id)
      construirFotoTools(id, r)
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
    const ctrls: HTMLElement[] = [crearBotonCandado(rCaja, c.nombre)]
    if (libre) {
      hit.classList.add('hit-agregado')
      habilitarArrastreTexto(hit, c.nombre)
      ctrls.push(
        crearTiradorCaja(rCaja, c.nombre, 'x'),
        crearTiradorCaja(rCaja, c.nombre, 'y'),
        crearTiradorCaja(rCaja, c.nombre, 'xy'),
      )
    }
    if (agregado) ctrls.push(crearBotonEliminar(rCaja, () => eliminarCampo(c.nombre)))
    for (const c2 of ctrls) lienzo.appendChild(c2)
    revelarAlHover(hit, ctrls)
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
    const ctrls = [
      crearBotonEliminar(r, () => { im.remove(); construirOverlays() }),
      crearTiradorResize(r, im),
      crearBotonMascara(r, im),
      crearBotonQuitarFondo(r,
        () => im.getAttribute('href') || im.getAttributeNS(XLINK, 'href') || '',
        (foto) => { im.setAttribute('href', foto.dataUrl); im.setAttributeNS(XLINK, 'xlink:href', foto.dataUrl) }),
      ...handlesMascara(im, base),
    ]
    for (const c of ctrls) lienzo.appendChild(c)
    revelarAlHover(hit, ctrls)
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
    const ctrls = [
      crearBotonEliminar(r, () => { el.remove(); construirOverlays() }),
      crearTiradorEscala(r, el, 'x'),  // ancho
      crearTiradorEscala(r, el, 'y'),  // alto
      crearTiradorEscala(r, el, 'xy'), // ambos (esquina)
      crearSwatch(r, el, 'fill', 0),
      crearSwatch(r, el, 'stroke', 1),
    ]
    for (const c of ctrls) lienzo.appendChild(c)
    revelarAlHover(hit, ctrls)
  }
  registrarHistorial()
  autoguardar()
}

// Muestra los controles (swatches, tiradores, ✕, candado) de un elemento SOLO
// mientras el mouse está sobre él o sus controles, para no saturar la mesa.
function revelarAlHover(hit: HTMLElement, ctrls: HTMLElement[]): void {
  if (!ctrls.length) return
  for (const c of ctrls) c.classList.add('ov-ctrl')
  const grupo: HTMLElement[] = [hit, ...ctrls]
  let temporizador = 0
  const mostrar = (): void => { clearTimeout(temporizador); for (const c of ctrls) c.classList.add('ov-visible') }
  const ocultar = (): void => {
    clearTimeout(temporizador)
    temporizador = window.setTimeout(() => {
      if (!grupo.some((n) => n.matches(':hover'))) for (const c of ctrls) c.classList.remove('ov-visible')
    }, 160)
  }
  for (const n of grupo) {
    n.addEventListener('pointerenter', mostrar)
    n.addEventListener('pointerleave', ocultar)
  }
}

// Botón "Quitar fondo" (abajo-izquierda de la imagen). getSrc lee la URL actual;
// aplicar recibe la foto ya procesada (PNG con alfa) y la coloca donde corresponda.
function crearBotonQuitarFondo(r: Rect, getSrc: () => string, aplicar: (f: Foto) => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'btn-quitarfondo'
  b.textContent = 'Quitar fondo'
  b.title = 'Quitar el fondo de la imagen (IA, corre en tu navegador)'
  Object.assign(b.style, { left: r.left - 2 + 'px', top: r.top + r.height + 4 + 'px' })
  b.addEventListener('click', (e) => { e.stopPropagation(); void ejecutarQuitarFondo(getSrc(), aplicar, b) })
  return b
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

// Arrastrar para reencuadrar la foto + rueda para zoom (por hueco de foto).
function habilitarPanZoom(hit: HTMLDivElement, id: string): void {
  hit.style.cursor = 'grab'
  hit.addEventListener('pointerdown', (e) => {
    const foto = fotos[id], fr = framesFoto[id]
    if (!foto || !fr || !svgEl) return
    e.preventDefault()
    try { hit.setPointerCapture(e.pointerId) } catch { /* sin captura: igual arrastra */ }
    hit.style.cursor = 'grabbing'
    const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
    const enc = encuadreDe(id)
    let sx = e.clientX, sy = e.clientY
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / k
      const dy = (ev.clientY - sy) / k
      sx = ev.clientX; sy = ev.clientY
      enc.ox += dx; enc.oy += dy
      const c = aplicarFotoDom(svgEl!, id, foto, fr, enc)
      enc.ox = c.ox; enc.oy = c.oy
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
    const foto = fotos[id], fr = framesFoto[id]
    if (!foto || !fr || !svgEl) return
    e.preventDefault()
    const enc = encuadreDe(id)
    const f = e.deltaY < 0 ? 1.08 : 1 / 1.08
    enc.zoom = Math.min(5, Math.max(1, enc.zoom * f))
    const c = aplicarFotoDom(svgEl, id, foto, fr, enc)
    enc.ox = c.ox; enc.oy = c.oy
    if (zoomSlider) zoomSlider.value = String(enc.zoom)
  }, { passive: false })
}

// Mini-barra de la foto: cambiar y zoom. Se posiciona sobre cada hueco.
function construirFotoTools(id: string, r: Rect): void {
  const enc = encuadreDe(id)
  const tools = document.createElement('div')
  tools.className = 'foto-tools'
  Object.assign(tools.style, { right: 'auto', left: r.left + 8 + 'px', top: r.top + 8 + 'px' })
  const imgFoto = svgEl?.querySelector(`[data-foto="${id}"]`)
  const op0 = imgFoto?.getAttribute('opacity') ?? '1'
  tools.innerHTML =
    `<button class="ft-cambiar mini">Cambiar foto</button>` +
    `<label class="ft-zoom">Zoom <input class="ft-in-zoom" type="range" min="1" max="5" step="0.01" value="${enc.zoom}"></label>` +
    `<label class="ft-zoom" title="Opacidad">Opac. <input class="ft-in-opac" type="range" min="0" max="1" step="0.01" value="${op0}"></label>`
  tools.querySelector('.ft-cambiar')!.addEventListener('click', () => { fotoActiva = id; inFoto.click() })
  const slider = tools.querySelector<HTMLInputElement>('.ft-in-zoom')!
  slider.addEventListener('input', () => {
    const foto = fotos[id], fr = framesFoto[id]
    if (!foto || !fr || !svgEl) return
    enc.zoom = parseFloat(slider.value)
    const c = aplicarFotoDom(svgEl, id, foto, fr, enc)
    enc.ox = c.ox; enc.oy = c.oy
  })
  const opac = tools.querySelector<HTMLInputElement>('.ft-in-opac')!
  opac.addEventListener('input', () => { imgFoto?.setAttribute('opacity', opac.value) })
  opac.addEventListener('change', () => { registrarHistorial(); autoguardar() })
  zoomSlider = slider
  if (fotos[id]) {
    const qf = document.createElement('button')
    qf.className = 'mini ft-fondo'; qf.textContent = 'Quitar fondo'
    qf.title = 'Quitar el fondo de la foto (IA, corre en tu navegador)'
    qf.addEventListener('click', () => void ejecutarQuitarFondo(fotos[id].dataUrl, (foto) => {
      fotos[id] = foto
      const fr = framesFoto[id], enc = encuadreDe(id)
      if (fr && svgEl) { const c = aplicarFotoDom(svgEl, id, foto, fr, enc); enc.ox = c.ox; enc.oy = c.oy }
    }, qf))
    tools.appendChild(qf)
  }
  lienzo.appendChild(tools)
}

// ---------------------------------------------------------------
//  Editor en vivo (sin recuadro: el texto cambia sobre la imagen)
// ---------------------------------------------------------------
// Texto actual de un campo en el DOM. Una línea = una baseline: los <tspan> hoja
// que comparten el mismo `y` son una sola línea (Illustrator parte una línea en
// varios tspan con `x` propio para hacer kerning manual). Un `y` nuevo (o un `dy`)
// abre una línea. Varios <text> sueltos aportan cada uno su(s) línea(s).
// Líneas reales de un campo: agrupa los <tspan> hoja por baseline (los fragmentos
// kerneados de Illustrator con el mismo `y` son UNA línea). Un `y` nuevo o un `dy`
// abre línea; cada <text> suelto aporta su(s) línea(s).
function lineasDeNodos(nodos: NodeListOf<Element> | Element[]): string[] {
  const lineas: string[] = []
  for (const te of Array.from(nodos)) {
    const hojas = Array.from(te.querySelectorAll('tspan')).filter((t) => !t.querySelector('tspan'))
    const src: Element[] = hojas.length ? hojas : [te]
    let linea = '', curY: string | null = null, abierta = false
    for (const t of src) {
      const y = t.getAttribute('y')
      const dy = t.getAttribute('dy')
      const nueva = !abierta ? true : dy != null || (y != null && y !== curY)
      if (nueva && abierta) { lineas.push(linea); linea = '' }
      if (y != null) curY = y
      linea += t.textContent ?? ''
      abierta = true
    }
    if (abierta) lineas.push(linea)
  }
  return lineas
}

function textoActualCampo(nodos: NodeListOf<Element> | Element[]): string {
  return lineasDeNodos(nodos).join('\n').replace(/\s+$/g, '')
}

function abrirEditor(nombre: string): void {
  if (!svgEl) return
  cerrarEditor()
  const m = metricas[nombre]
  if (!m) return
  const base = lienzo.getBoundingClientRect()
  const r = rectUnion(svgEl.querySelectorAll(`[data-campo="${nombre}"]`), base) ?? rectsIniciales[nombre]
  if (!r) return
  const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
  // Si el campo aún no tiene valor, sembramos el texto que ya trae la plantilla
  // (salvo que sea un placeholder con llaves, que se edita desde cero).
  let valorPrevio = valores[nombre]
  if (valorPrevio == null) {
    const actual = textoActualCampo(svgEl.querySelectorAll(`[data-campo="${nombre}"]`))
    valorPrevio = /[{}]/.test(actual) ? '' : actual
  }

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
  // +4px de holgura: maxWidthUser es el ancho EXACTO del texto (sin margen), y el
  // textarea (layout del navegador) redondea distinto que la medición SVG → sin
  // holgura, la última letra se cae a otra línea.
  ta.style.width = Math.max(m.maxWidthUser * k + 4, 60) + 'px'
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
    aplicarEstiloTextarea(nombre) // recalcular shrink en vivo (envuelve como el render)
  })
  ta.addEventListener('blur', (e) => {
    // Si el foco va a la barra de controles (ej. el selector de fuente),
    // NO cerramos el editor: queremos seguir editando ese campo.
    const rt = e.relatedTarget as HTMLElement | null
    if (rt && (barraTexto.contains(rt) || rt.closest('#panel-gfonts'))) return
    commitEditor()
  })
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelarEditor() }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur() }
  })
}

// Aplica el estilo efectivo del campo al textarea (vista en vivo durante la edición).
// Reproduce el auto-shrink del render: si el texto no entra a tamaño completo,
// achica la fuente igual que pintarCampo, para que el textarea envuelva como va a
// quedar (si no, durante la edición se "cae" la última palabra/letra).
function aplicarEstiloTextarea(nombre: string): void {
  const ta = document.querySelector<HTMLTextAreaElement>('.editor-text')
  if (!ta || !svgEl) return
  const m = metricas[nombre]
  if (!m) return
  const ef = estiloEfectivo(nombre)
  const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
  const mEf: Metrica = { ...m, fontSizeUser: ef.fontSize, weight: ef.weight, family: ef.family, italic: ef.italic }
  const escala = ef.manual || !ta.value ? 1 : ajustar(ta.value, mEf).escala
  ta.style.fontSize = ef.fontSize * escala * k + 'px'
  ta.style.fontWeight = ef.weight
  ta.style.fontStyle = ef.italic ? 'italic' : 'normal'
  ta.style.fontFamily = ef.family
  ta.style.lineHeight = m.lh * (ef.fontSize / m.fontSizeUser) * ef.lineHeight * escala * k + 'px'
  ta.style.textAlign = ef.align === 'middle' ? 'center' : ef.align === 'end' ? 'right' : 'left'
  ta.style.color = ef.color
  ta.style.caretColor = ef.color
  autoCrecer(ta)
}

// Refleja en la barra los valores actuales del campo y la muestra.
function sincronizarBarra(nombre: string): void {
  const ef = estiloEfectivo(nombre)
  btSize.textContent = String(Math.round(ef.fontSize))
  btLh.textContent = ef.lineHeight.toFixed(1)
  btBold.classList.toggle('activo', ef.weight === '700')
  btItalic.classList.toggle('activo', ef.italic)
  btColor.value = aHex(ef.color)
  btFamily.value = ef.family
  // Variantes/pesos disponibles para la familia actual.
  const pesos = pesosDisponibles(ef.family)
  btWeight.innerHTML = pesos.map((p) => `<option value="${p}">${NOMBRE_PESO[p] ?? p}</option>`).join('')
  btWeight.value = pesos.includes(+ef.weight) ? ef.weight : String(pesos[0])
  btWeight.disabled = pesos.length < 2
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

// Un cambio de estilo es una modificación: siembra el texto actual del textarea
// en `valores` y marca el campo como tocado, para que commitEditor lo repinte
// aunque no se haya editado el contenido (si no, el cambio se pierde al salir).
function marcarCampoEditado(): void {
  if (!editorActivo) return
  valores[editorActivo.nombre] = editorActivo.ta.value
  editorActivo.tocado = true
}

// Controles de la barra (operan sobre el campo en edición).
barraTexto.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('[data-bt]')
  if (!b || !editorActivo) return
  const nombre = editorActivo.nombre
  const bt = b.getAttribute('data-bt')!
  const ef = estiloEfectivo(nombre)
  const est = (estilos[nombre] ??= {})
  if (bt === 'size-') est.fontSize = Math.max(4, Math.round(ef.fontSize) - 1)
  else if (bt === 'size+') est.fontSize = Math.round(ef.fontSize) + 1
  else if (bt === 'lh-') est.lineHeight = Math.max(0.5, Math.round((ef.lineHeight - 0.1) * 10) / 10)
  else if (bt === 'lh+') est.lineHeight = Math.min(3, Math.round((ef.lineHeight + 0.1) * 10) / 10)
  else if (bt.startsWith('al:')) est.align = bt.slice(3) as EstiloCampo['align']
  else if (bt === 'bold') { est.weight = ef.weight === '700' ? 400 : 700; delete est.bold } // N = atajo a Bold
  else if (bt === 'italic') est.italic = !ef.italic
  aplicarEstiloTextarea(nombre)
  sincronizarBarra(nombre)
  marcarCampoEditado()
})
btFamily.addEventListener('change', () => {
  if (!editorActivo) return
  ;(estilos[editorActivo.nombre] ??= {}).family = btFamily.value
  aplicarEstiloTextarea(editorActivo.nombre)
  sincronizarBarra(editorActivo.nombre) // refrescar variantes de la familia nueva
  marcarCampoEditado()
  editorActivo.ta.focus() // volver a editar tras elegir fuente
})
btWeight.addEventListener('change', () => {
  if (!editorActivo) return
  const est = (estilos[editorActivo.nombre] ??= {})
  est.weight = +btWeight.value; delete est.bold
  aplicarEstiloTextarea(editorActivo.nombre)
  sincronizarBarra(editorActivo.nombre)
  marcarCampoEditado()
  editorActivo.ta.focus()
})
btColor.addEventListener('input', () => {
  if (!editorActivo) return
  ;(estilos[editorActivo.nombre] ??= {}).color = btColor.value
  aplicarEstiloTextarea(editorActivo.nombre)
  marcarCampoEditado()
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
  const id = fotoActiva ?? idsFoto()[0]
  if (!file || id == null) { inFoto.value = ''; return }
  try {
    fotos[id] = await leerFoto(file)
    encuadres[id] = { zoom: 1, ox: 0, oy: 0 } // foto nueva: encuadre por defecto (cover centrado)
    await montarPlantilla()
  } catch (err) {
    estado.textContent = '❌ ' + (err instanceof Error ? err.message : String(err))
  }
  fotoActiva = null
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
//  Quitar fondo (segmentación con IA, 100% en el navegador)
// ---------------------------------------------------------------
// Usa @imgly/background-removal (modelo U2Net). Se importa de forma diferida para
// no inflar el bundle; la 1ª vez descarga el modelo (~40 MB) y lo cachea. La
// imagen nunca sale del navegador. Devuelve un PNG con alfa (vía leerFoto).
let quitandoFondo = false
async function ejecutarQuitarFondo(src: string, aplicar: (foto: Foto) => void, btn?: HTMLButtonElement): Promise<void> {
  if (quitandoFondo) return
  if (!src) { alert('No hay imagen para procesar.'); return }
  quitandoFondo = true
  const txt = btn?.textContent ?? ''
  if (btn) { btn.disabled = true; btn.textContent = 'Quitando…' }
  estado.textContent = 'Quitando el fondo… (la 1.ª vez descarga el modelo, puede tardar)'
  try {
    const { removeBackground } = await import('@imgly/background-removal')
    const blob = await removeBackground(src)
    const foto = await leerFoto(new File([blob], 'sinfondo.png', { type: 'image/png' }))
    aplicar(foto)
    registrarHistorial(); autoguardar()
    estado.textContent = 'Fondo quitado ✓'
  } catch (e) {
    console.error('quitar fondo:', e)
    estado.textContent = 'No se pudo quitar el fondo'
    alert('No se pudo quitar el fondo: ' + (e as Error).message)
  } finally {
    quitandoFondo = false
    if (btn) { btn.disabled = false; btn.textContent = txt }
  }
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
    // Ancho de export = ancho del lienzo (viewBox), acotado para no exagerar.
    const vbW = svgEl.viewBox.baseVal.width || 1080
    const anchoExport = Math.round(Math.min(2480, Math.max(1080, vbW)))
    const blob = await renderResvg(svg, facesPack.map((f) => f.bytes), anchoExport)
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

// --- ZIP (modo store, sin compresión: los PNG ya están comprimidos) ---
function crc32(buf: Uint8Array): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function crearZip(archivos: { nombre: string; datos: Uint8Array }[]): Blob {
  const enc = new TextEncoder()
  const partes: BlobPart[] = []
  const central: BlobPart[] = []
  let offset = 0
  for (const { nombre, datos } of archivos) {
    const nb = enc.encode(nombre), crc = crc32(datos)
    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true)
    lh.setUint32(14, crc, true); lh.setUint32(18, datos.length, true); lh.setUint32(22, datos.length, true)
    lh.setUint16(26, nb.length, true)
    partes.push(lh.buffer.slice(0), nb, datos as BlobPart)
    const ch = new DataView(new ArrayBuffer(46))
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true)
    ch.setUint32(16, crc, true); ch.setUint32(20, datos.length, true); ch.setUint32(24, datos.length, true)
    ch.setUint16(28, nb.length, true); ch.setUint32(42, offset, true)
    central.push(ch.buffer.slice(0), nb)
    offset += 30 + nb.length + datos.length
  }
  const centralSize = central.reduce((a, b) => a + (b as ArrayBuffer | Uint8Array).byteLength, 0)
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, archivos.length, true); eocd.setUint16(10, archivos.length, true)
  eocd.setUint32(12, centralSize, true); eocd.setUint32(16, offset, true)
  return new Blob([...partes, ...central, eocd.buffer], { type: 'application/zip' })
}

// Exporta TODAS las mesas a PNG y las baja en un ZIP.
async function exportarTodas(): Promise<void> {
  cerrarEditor()
  guardarMesaActiva()
  if (!mesas.length) return
  estado.textContent = `Exportando ${mesas.length} mesas…`
  const fuentes = facesPack.map((f) => f.bytes)
  const archivos: { nombre: string; datos: Uint8Array }[] = []
  const usados = new Set<string>()
  for (let i = 0; i < mesas.length; i++) {
    const m = mesas[i]
    const vbW = parseFloat(m.svg.match(/viewBox="0 0 ([\d.]+)/)?.[1] ?? '1080') || 1080
    const ancho = Math.round(Math.min(2480, Math.max(1080, vbW)))
    try {
      const blob = await renderResvg(m.svg, fuentes, ancho)
      let nombre = (m.nombre || `Mesa ${i + 1}`).replace(/[^\w\dáéíóúñÁÉÍÓÚÑ .-]+/g, '_').trim() || `Mesa ${i + 1}`
      if (usados.has(nombre)) nombre = `${nombre} (${i + 1})`
      usados.add(nombre)
      archivos.push({ nombre: `${nombre}.png`, datos: new Uint8Array(await blob.arrayBuffer()) })
    } catch (e) { console.error('[exportarTodas]', e) }
  }
  if (!archivos.length) { estado.textContent = '❌ No se pudo exportar'; return }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(crearZip(archivos))
  a.download = `${nombreCorto(plantillaActual)}-mesas.zip`
  a.click()
  estado.textContent = `${archivos.length} mesa(s) exportada(s) en ZIP.`
}

// ---------------------------------------------------------------
//  Guardar / cargar proyecto
// ---------------------------------------------------------------
interface Proyecto {
  v: number
  plantilla: string
  nombre?: string // nombre de la mesa (artboard)
  valores: Record<string, string>
  estilos: Record<string, EstiloCampo>
  bloqueado: Record<string, boolean>
  cajaAlto: Record<string, number>
  metricas: Record<string, Metrica>
  fotos?: Record<string, Foto>
  encuadres?: Record<string, Encuadre>
  foto?: Foto | null // formato viejo (1 sola foto) — se migra al cargar
  encuadre?: Encuadre
  contador: number
  svg: string
}

function snapshotProyecto(): Proyecto {
  return {
    v: 2,
    plantilla: plantillaActual,
    valores, estilos, bloqueado, cajaAlto, metricas,
    fotos, encuadres,
    contador: contadorAgregados,
    svg: svgEl ? new XMLSerializer().serializeToString(svgEl) : '',
  }
}

// Aplica un snapshot al DOM y estado (sin tocar el historial).
async function aplicarSnapshot(p: Proyecto): Promise<void> {
  cerrarEditor()
  plantillaActual = p.plantilla
  if ([...selPlantilla.options].some((o) => o.value === p.plantilla)) selPlantilla.value = p.plantilla
  valores = p.valores ?? {}
  estilos = p.estilos ?? {}
  bloqueado = p.bloqueado ?? {}
  cajaAlto = p.cajaAlto ?? {}
  metricas = p.metricas ?? {}
  // Multi-foto (v2). Migrar saves viejos (v1: una sola foto → hueco "0").
  if (p.fotos || p.encuadres) {
    fotos = p.fotos ?? {}
    encuadres = p.encuadres ?? {}
  } else {
    fotos = p.foto ? { '0': p.foto } : {}
    encuadres = p.encuadre ? { '0': p.encuadre } : {}
  }
  contadorAgregados = p.contador ?? 0

  svgActual = p.svg
  lienzo.innerHTML = p.svg
  svgEl = lienzo.querySelector('svg')
  if (svgEl) { svgEl.style.width = '100%'; svgEl.style.height = 'auto'; svgEl.style.display = 'block' }

  await document.fonts.ready
  camposActuales = Array.from(svgEl?.querySelectorAll('[data-campo][data-anchor]') ?? [])
    .map((el) => ({ nombre: el.getAttribute('data-campo')!, etiqueta: el.getAttribute('data-campo')! }))
  framesFoto = {}
  for (const id of idsFoto()) { const fr = frameVisibleUser(id); if (fr) framesFoto[id] = fr }
  rectsIniciales = {}
  const base = lienzo.getBoundingClientRect()
  for (const c of camposActuales) {
    const r = rectUnion(svgEl!.querySelectorAll(`[data-campo="${c.nombre}"]`), base)
    if (r) rectsIniciales[c.nombre] = r
  }
  // innerHTML reemplazó el nodo <svg>: si el modo gráficos estaba activo, se
  // perdió su listener de selección. Re-engancharlo al nuevo svg y limpiar la
  // selección vieja (apuntaba a un nodo ya descartado).
  grafSeleccion = []
  limpiarGraf()
  if (modoGrafico && svgEl) svgEl.addEventListener('pointerdown', grafPointerDown)

  suprimirHistorial = true
  construirOverlays()
  suprimirHistorial = false
}

// Carga un proyecto (Cargar / auto-restaurar): aplica + reinicia el historial.
async function restaurarProyecto(p: Proyecto): Promise<void> {
  await aplicarSnapshot(p)
  reiniciarHistorial()
  iniciarMesas()
  estado.textContent = 'Proyecto cargado.'
}

// ---------------------------------------------------------------
//  Mesas / artboards (varias placas en un mismo proyecto)
// ---------------------------------------------------------------
let mesas: Proyecto[] = []
let mesaActiva = 0
// Historial (undo/redo) por mesa, EN MEMORIA (no se serializa: sería enorme).
// Se mantiene alineado con `mesas` (mismos splice). undefined = aún sin historial
// (se inicializa al visitar la mesa).
let histPorMesa: ({ stack: string[]; idx: number } | undefined)[] = []
function guardarHistorialActivo(): void { histPorMesa[mesaActiva] = { stack: historial, idx: histIdx } }
function restaurarHistorialActivo(): void {
  const h = histPorMesa[mesaActiva]
  if (h) { historial = h.stack; histIdx = h.idx; actualizarBotonesHistorial() }
  else reiniciarHistorial() // captura el estado actual como punto inicial de esa mesa
}

// Vuelca el estado vivo actual en la mesa activa (preservando su nombre).
function guardarMesaActiva(): void {
  if (!mesas.length) return
  mesas[mesaActiva] = { ...snapshotProyecto(), nombre: mesas[mesaActiva]?.nombre }
}
// (Re)inicia el proyecto con una sola mesa = el lienzo actual (montaje fresco).
function iniciarMesas(): void {
  mesas = [{ ...snapshotProyecto(), nombre: 'Mesa 1' }]
  mesaActiva = 0
  histPorMesa = [{ stack: historial, idx: histIdx }]
  renderMesas()
}
async function irAMesa(i: number): Promise<void> {
  if (i === mesaActiva || i < 0 || i >= mesas.length) return
  guardarMesaActiva(); guardarHistorialActivo()
  mesaActiva = i
  await aplicarSnapshot(mesas[mesaActiva])
  restaurarHistorialActivo()
  aplicarZoom()
  renderMesas()
}
async function agregarMesa(duplicar: boolean): Promise<void> {
  guardarMesaActiva(); guardarHistorialActivo()
  const w = svgEl ? Math.round(svgEl.viewBox.baseVal.width) : 1080
  const h = svgEl ? Math.round(svgEl.viewBox.baseVal.height) : 1080
  const nueva: Proyecto = duplicar
    ? JSON.parse(JSON.stringify(mesas[mesaActiva]))
    : { v: 2, plantilla: `enblanco-${w}x${h}`, valores: {}, estilos: {}, bloqueado: {}, cajaAlto: {}, metricas: {}, fotos: {}, encuadres: {}, contador: 0, svg: svgEnBlanco(w, h) }
  nueva.nombre = `Mesa ${mesas.length + 1}`
  mesas.splice(mesaActiva + 1, 0, nueva)
  histPorMesa.splice(mesaActiva + 1, 0, undefined)
  mesaActiva += 1
  await aplicarSnapshot(mesas[mesaActiva])
  restaurarHistorialActivo() // mesa nueva (undefined) → historial nuevo desde su estado
  aplicarZoom()
  renderMesas()
  autoguardar()
}
async function borrarMesa(i: number): Promise<void> {
  if (mesas.length <= 1) return
  guardarHistorialActivo()
  mesas.splice(i, 1)
  histPorMesa.splice(i, 1)
  if (mesaActiva > i || mesaActiva >= mesas.length) mesaActiva = Math.max(0, mesaActiva - 1)
  await aplicarSnapshot(mesas[mesaActiva])
  restaurarHistorialActivo()
  aplicarZoom()
  renderMesas()
  autoguardar()
}
function renombrarMesa(i: number, nomSpan: HTMLElement): void {
  const inp = document.createElement('input')
  inp.className = 'mesa-rename'; inp.value = mesas[i].nombre || `Mesa ${i + 1}`
  nomSpan.replaceWith(inp); inp.focus(); inp.select()
  inp.addEventListener('click', (e) => e.stopPropagation())
  inp.addEventListener('blur', () => { mesas[i].nombre = inp.value.trim() || `Mesa ${i + 1}`; renderMesas(); autoguardar() })
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); else if (e.key === 'Escape') renderMesas() })
}
// Mueve una mesa de una posición a otra (reordenar por arrastre).
let arrastrandoMesa = -1
function moverMesa(from: number, to: number): void {
  if (from === to || from < 0 || from >= mesas.length || to < 0 || to >= mesas.length) return
  const activaObj = mesas[mesaActiva]
  const [m] = mesas.splice(from, 1); mesas.splice(to, 0, m)
  const [hist] = histPorMesa.splice(from, 1); histPorMesa.splice(to, 0, hist)
  mesaActiva = mesas.indexOf(activaObj)
  renderMesas(); autoguardar()
}
function renderMesas(): void {
  const tira = document.querySelector<HTMLDivElement>('#tira-mesas')
  if (!tira) return
  if (mesas.length) guardarMesaActiva() // miniatura de la mesa activa al día
  tira.innerHTML = ''
  mesas.forEach((m, i) => {
    const tab = document.createElement('button')
    tab.className = 'mesa-tab' + (i === mesaActiva ? ' activa' : '')
    tab.title = 'Clic: ir · doble clic: renombrar · arrastrar: reordenar'
    tab.draggable = true
    const thumb = document.createElement('img'); thumb.className = 'mesa-thumb'
    thumb.src = 'data:image/svg+xml,' + encodeURIComponent(m.svg); thumb.alt = ''
    const nom = document.createElement('span'); nom.className = 'mesa-nom'; nom.textContent = m.nombre || `Mesa ${i + 1}`
    tab.append(thumb, nom)
    tab.addEventListener('click', () => void irAMesa(i))
    tab.addEventListener('dblclick', () => renombrarMesa(i, nom))
    tab.addEventListener('dragstart', () => { arrastrandoMesa = i })
    tab.addEventListener('dragover', (e) => e.preventDefault())
    tab.addEventListener('drop', (e) => { e.preventDefault(); moverMesa(arrastrandoMesa, i); arrastrandoMesa = -1 })
    if (mesas.length > 1) {
      const x = document.createElement('span'); x.className = 'mesa-del'; x.textContent = '✕'; x.title = 'Borrar mesa'
      x.addEventListener('click', (e) => { e.stopPropagation(); void borrarMesa(i) })
      tab.appendChild(x)
    }
    tira.appendChild(tab)
  })
  const add = document.createElement('button'); add.className = 'mesa-btn'; add.textContent = '＋'; add.title = 'Nueva mesa en blanco'
  add.addEventListener('click', () => void agregarMesa(false))
  const dup = document.createElement('button'); dup.className = 'mesa-btn'; dup.textContent = '⧉'; dup.title = 'Duplicar mesa actual'
  dup.addEventListener('click', () => void agregarMesa(true))
  tira.append(add, dup)
  if (mesas.length > 1) {
    const carr = document.createElement('button'); carr.className = 'mesa-btn' + (vistaCarrusel ? ' activa' : ''); carr.textContent = '▦'; carr.title = 'Ver todas las mesas (carrusel)'
    carr.addEventListener('click', () => toggleCarrusel())
    const zip = document.createElement('button'); zip.className = 'mesa-btn'; zip.textContent = '⬇'; zip.title = 'Exportar todas las mesas (ZIP)'
    zip.addEventListener('click', () => void exportarTodas())
    tira.append(carr, zip)
  }
  if (vistaCarrusel) renderCarrusel()
}

// ---- Vista carrusel: todas las mesas pegadas, click para editar, drag para reordenar ----
let vistaCarrusel = false
function aplicarVistaCarrusel(): void {
  const lz = document.querySelector<HTMLElement>('#lienzo')!
  const vc = document.querySelector<HTMLElement>('#vista-carrusel')!
  const zc = document.querySelector<HTMLElement>('#zoom-ctrl')
  lz.hidden = vistaCarrusel
  vc.hidden = !vistaCarrusel
  if (zc) zc.style.display = vistaCarrusel ? 'none' : ''
  if (vistaCarrusel) renderCarrusel()
}
function toggleCarrusel(): void {
  if (!vistaCarrusel) guardarMesaActiva()
  vistaCarrusel = !vistaCarrusel
  aplicarVistaCarrusel()
  renderMesas()
}
function renderCarrusel(): void {
  const vc = document.querySelector<HTMLDivElement>('#vista-carrusel')
  if (!vc) return
  if (mesas.length) guardarMesaActiva()
  vc.innerHTML = ''
  mesas.forEach((m, i) => {
    const item = document.createElement('div'); item.className = 'carr-item' + (i === mesaActiva ? ' activa' : '')
    item.draggable = true; item.title = 'Clic: editar · arrastrar: reordenar'
    const img = document.createElement('img'); img.src = 'data:image/svg+xml,' + encodeURIComponent(m.svg); img.alt = ''
    const label = document.createElement('span'); label.className = 'carr-label'; label.textContent = m.nombre || `Mesa ${i + 1}`
    item.append(img, label)
    item.addEventListener('click', () => { vistaCarrusel = false; aplicarVistaCarrusel(); renderMesas(); void irAMesa(i) })
    item.addEventListener('dragstart', () => { arrastrandoMesa = i })
    item.addEventListener('dragover', (e) => e.preventDefault())
    item.addEventListener('drop', (e) => { e.preventDefault(); moverMesa(arrastrandoMesa, i); arrastrandoMesa = -1 })
    vc.appendChild(item)
  })
}

// Restaura un guardado que puede ser multi-mesa { multi, mesas, mesaActiva } o
// un proyecto viejo de una sola placa.
async function restaurarGuardado(data: unknown): Promise<void> {
  const d = data as { multi?: boolean; mesas?: Proyecto[]; mesaActiva?: number }
  if (d && d.multi && Array.isArray(d.mesas) && d.mesas.length) {
    mesas = d.mesas
    mesaActiva = Math.min(d.mesaActiva ?? 0, mesas.length - 1)
    histPorMesa = mesas.map(() => undefined) // historial nuevo por mesa (no se guarda en el archivo)
    await aplicarSnapshot(mesas[mesaActiva])
    reiniciarHistorial()
    histPorMesa[mesaActiva] = { stack: historial, idx: histIdx }
    aplicarZoom()
    renderMesas()
    estado.textContent = 'Proyecto cargado.'
  } else {
    await restaurarProyecto(data as Proyecto)
  }
}

// ---------------------------------------------------------------
//  Historial (deshacer / rehacer)
// ---------------------------------------------------------------
let historial: string[] = []
let histIdx = -1
let suprimirHistorial = false

function reiniciarHistorial(): void {
  historial = [JSON.stringify(snapshotProyecto())]
  histIdx = 0
  actualizarBotonesHistorial()
}

function registrarHistorial(): void {
  if (suprimirHistorial) return
  const snap = JSON.stringify(snapshotProyecto())
  if (historial[histIdx] === snap) return
  historial = historial.slice(0, histIdx + 1)
  historial.push(snap)
  histIdx++
  // Tope por tamaño total (≈120 MB) — soporta muchos chicos o pocos grandes.
  let total = historial.reduce((a, s) => a + s.length, 0)
  while (historial.length > 1 && total > 120_000_000) { total -= historial[0].length; historial.shift(); histIdx-- }
  actualizarBotonesHistorial()
}

async function deshacer(): Promise<void> {
  if (histIdx <= 0) return
  histIdx--
  await aplicarSnapshot(JSON.parse(historial[histIdx]))
  actualizarBotonesHistorial()
  estado.textContent = 'Deshacer.'
}
async function rehacer(): Promise<void> {
  if (histIdx >= historial.length - 1) return
  histIdx++
  await aplicarSnapshot(JSON.parse(historial[histIdx]))
  actualizarBotonesHistorial()
  estado.textContent = 'Rehacer.'
}
function actualizarBotonesHistorial(): void {
  const u = document.querySelector<HTMLButtonElement>('#btn-deshacer')
  const r = document.querySelector<HTMLButtonElement>('#btn-rehacer')
  if (u) u.disabled = histIdx <= 0
  if (r) r.disabled = histIdx >= historial.length - 1
}

let tGuardar: number | undefined
function autoguardar(): void {
  clearTimeout(tGuardar)
  tGuardar = window.setTimeout(() => {
    try {
      guardarMesaActiva()
      const data = mesas.length ? { multi: true, mesaActiva, mesas } : snapshotProyecto()
      const json = JSON.stringify(data)
      // No autoguardar si pesa mucho (placas con fotos embebidas grandes):
      // evita saturar localStorage y pisar un proyecto chico bueno.
      if (json.length > 8_000_000) return
      localStorage.setItem('gastonart-proyecto', json)
    } catch { /* quota: ignorar */ }
  }, 600)
}

document.querySelector('#btn-guardar')!.addEventListener('click', () => {
  cerrarEditor()
  guardarMesaActiva()
  const data = mesas.length ? { multi: true, mesaActiva, mesas } : snapshotProyecto()
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${nombreCorto(plantillaActual)}.gastonart.json`
  a.click()
  estado.textContent = `Proyecto guardado (${mesas.length} mesa${mesas.length > 1 ? 's' : ''}).`
})
const inProyecto = document.querySelector<HTMLInputElement>('#in-proyecto')!
document.querySelector('#btn-cargar')!.addEventListener('click', () => inProyecto.click())
inProyecto.addEventListener('change', async () => {
  const file = inProyecto.files?.[0]
  if (!file) return
  try {
    await restaurarGuardado(JSON.parse(await file.text()))
  } catch (err) {
    estado.textContent = '❌ No se pudo cargar: ' + (err instanceof Error ? err.message : String(err))
  }
  inProyecto.value = ''
})
document.querySelector('#btn-guardar-plantilla')!.addEventListener('click', () => {
  const sug = rutasUsuario.has(plantillaActual) ? nombreCorto(plantillaActual) : ''
  const nombre = prompt('Nombre de la plantilla:', sug || 'Mi plantilla')
  if (nombre) guardarComoPlantilla(nombre)
})
document.querySelector('#btn-nuevo')!.addEventListener('click', () => mostrarInicio())
document.querySelector('#btn-deshacer')!.addEventListener('click', () => void deshacer())
document.querySelector('#btn-rehacer')!.addEventListener('click', () => void rehacer())
document.querySelector('#btn-copiar')!.addEventListener('click', () => copiarSeleccion())
document.querySelector('#btn-pegar')!.addEventListener('click', () => pegarPortapapeles())
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return
  // Mientras se edita texto (o el foco está en un input), dejar la copia NATIVA.
  const ae = document.activeElement
  const editando = !!editorActivo || (ae != null && /^(input|textarea|select)$/i.test(ae.tagName))
  const k = e.key.toLowerCase()
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); void deshacer() }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); void rehacer() }
  else if (!editando && k === 'c' && grafSeleccion.length) { e.preventDefault(); copiarSeleccion() }
  else if (!editando && k === 'v' && portapapeles.length) { e.preventDefault(); pegarPortapapeles() }
  else if (!editando && k === 'd' && grafSeleccion.length) { e.preventDefault(); duplicarSeleccion() }
})

// ---------------------------------------------------------------
//  Eventos varios
// ---------------------------------------------------------------
selPlantilla.addEventListener('change', () => {
  plantillaActual = selPlantilla.value
  svgActual = plantillas[plantillaActual]
  valores = {}
  estilos = {}
  fotos = {}; encuadres = {}; fotoActiva = null
  void montarPlantilla()
})

// ---------------------------------------------------------------
//  Pantalla de inicio: imagen en blanco / plantilla / cargar SVG
// ---------------------------------------------------------------
interface PresetTamano { nombre: string; w: number; h: number; grupo: string }
const PRESETS_TAMANO: PresetTamano[] = [
  { nombre: 'Instagram · Post', w: 1080, h: 1080, grupo: 'Redes' },
  { nombre: 'Instagram · Retrato', w: 1080, h: 1350, grupo: 'Redes' },
  { nombre: 'Instagram · Historia', w: 1080, h: 1920, grupo: 'Redes' },
  { nombre: 'Facebook · Post', w: 1200, h: 1200, grupo: 'Redes' },
  { nombre: 'Facebook · Portada', w: 1640, h: 624, grupo: 'Redes' },
  { nombre: 'X / Twitter · Post', w: 1600, h: 900, grupo: 'Redes' },
  { nombre: 'YouTube · Miniatura', w: 1280, h: 720, grupo: 'Redes' },
  { nombre: 'LinkedIn · Post', w: 1200, h: 1500, grupo: 'Redes' },
  { nombre: 'A4 · Vertical', w: 2480, h: 3508, grupo: 'Impresión (300 dpi)' },
  { nombre: 'A4 · Horizontal', w: 3508, h: 2480, grupo: 'Impresión (300 dpi)' },
  { nombre: 'A5 · Vertical', w: 1748, h: 2480, grupo: 'Impresión (300 dpi)' },
  { nombre: 'A5 · Horizontal', w: 2480, h: 1748, grupo: 'Impresión (300 dpi)' },
]

// SVG mínimo en blanco con fondo (fuente del lienzo "de cero").
function svgEnBlanco(w: number, h: number, fondo = '#ffffff'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">` +
    `<rect x="0" y="0" width="${w}" height="${h}" fill="${fondo}"/></svg>`
}

// Monta un lienzo "de cero" con el tamaño dado.
function nuevaPlacaEnBlanco(w: number, h: number, fondo = '#ffffff'): void {
  try { localStorage.removeItem('gastonart-proyecto') } catch { /* ignorar */ }
  svgActual = svgEnBlanco(w, h, fondo)
  plantillaActual = `enblanco-${w}x${h}`
  valores = {}; estilos = {}; fotos = {}; encuadres = {}; fotoActiva = null
  void montarPlantilla().then(() => { estado.textContent = `Lienzo ${w}×${h} px` })
}

// Cambia el tamaño de la mesa actual (viewBox) preservando el contenido. Si hay
// un rect de fondo que cubría toda la placa, también se redimensiona.
function redimensionarMesa(w: number, h: number): void {
  if (!svgEl) return
  cerrarEditor()
  const vb = svgEl.viewBox.baseVal
  const oldW = vb.width || 1080, oldH = vb.height || 1350
  for (const rect of Array.from(svgEl.querySelectorAll<SVGRectElement>('rect'))) {
    const rx = parseFloat(rect.getAttribute('x') ?? '0'), ry = parseFloat(rect.getAttribute('y') ?? '0')
    const rw = parseFloat(rect.getAttribute('width') ?? '0'), rh = parseFloat(rect.getAttribute('height') ?? '0')
    if (rx <= 1 && ry <= 1 && rw >= oldW * 0.98 && rh >= oldH * 0.98) {
      rect.setAttribute('width', String(w)); rect.setAttribute('height', String(h))
    }
  }
  svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`)
  svgEl.removeAttribute('width'); svgEl.removeAttribute('height')
  aplicarZoom() // recalcula el ancho de display + overlays con el nuevo viewBox
  registrarHistorial(); autoguardar()
  estado.textContent = `Mesa: ${w}×${h} px`
}

// Monta una plantilla del paquete por su clave (ruta).
function usarPlantilla(ruta: string): void {
  try { localStorage.removeItem('gastonart-proyecto') } catch { /* ignorar */ }
  plantillaActual = ruta
  svgActual = plantillas[ruta]
  if ([...selPlantilla.options].some((o) => o.value === ruta)) selPlantilla.value = ruta
  valores = {}; estilos = {}; fotos = {}; encuadres = {}; fotoActiva = null
  void montarPlantilla()
}

// Registra una plantilla en el sistema (selector + pantalla de inicio) y devuelve
// su clave. Al cargar un SVG nuevo se suma como una plantilla más, con su propio
// nombre (sin pisar las efemérides existentes).
function registrarPlantilla(nombre: string, svg: string): string {
  const base = nombre.replace(/\.svg$/i, '').trim() || 'plantilla'
  const existentes = new Set(rutasPlantilla.map(nombreCorto))
  let nom = base, n = 2
  while (existentes.has(nom)) nom = `${base} (${n++})`
  const ruta = `./assets/templates/${nom}.svg`
  plantillas[ruta] = svg
  rutasPlantilla.push(ruta)
  const opt = document.createElement('option')
  opt.value = ruta
  opt.textContent = nom
  selPlantilla.appendChild(opt)
  return ruta
}

// --- Plantillas guardadas por el usuario (persistidas en el navegador) ---
const LS_PLANTILLAS = 'gastonart-plantillas-usuario'
const rutasUsuario = new Set<string>() // plantillas guardadas por el usuario (borrables, persistidas)

function persistirPlantillas(): void {
  const data: Record<string, string> = {}
  for (const ruta of rutasUsuario) data[nombreCorto(ruta)] = plantillas[ruta]
  try { localStorage.setItem(LS_PLANTILLAS, JSON.stringify(data)) }
  catch (e) { estado.textContent = '⚠ No se pudieron guardar las plantillas (sin espacio)'; console.error('[persistirPlantillas]', e) }
}

function cargarPlantillasUsuario(): void {
  let data: Record<string, string> = {}
  try { data = JSON.parse(localStorage.getItem(LS_PLANTILLAS) || '{}') } catch { /* ignorar */ }
  for (const [nombre, svg] of Object.entries(data)) {
    if (typeof svg !== 'string') continue
    rutasUsuario.add(registrarPlantilla(nombre, svg))
  }
}

// --- Plantillas del paquete ocultadas por el usuario (restaurables) ---
const LS_OCULTAS = 'gastonart-plantillas-ocultas'
const ocultas = new Set<string>() // nombreCorto de plantillas del paquete que el usuario borró

function persistirOcultas(): void {
  try { localStorage.setItem(LS_OCULTAS, JSON.stringify([...ocultas])) } catch { /* ignorar */ }
}

function cargarOcultas(): void {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_OCULTAS) || '[]')
    if (Array.isArray(arr)) for (const n of arr) if (typeof n === 'string') ocultas.add(n)
  } catch { /* ignorar */ }
  // Quitar del listado las plantillas del paquete ocultadas (no las del usuario).
  for (const ruta of [...rutasPlantilla]) {
    if (!rutasUsuario.has(ruta) && ocultas.has(nombreCorto(ruta))) quitarDelListado(ruta)
  }
}

// Saca una plantilla del selector y del array (no toca el dato en `plantillas`).
function quitarDelListado(ruta: string): void {
  const i = rutasPlantilla.indexOf(ruta)
  if (i >= 0) rutasPlantilla.splice(i, 1)
  selPlantilla.querySelector(`option[value="${CSS.escape(ruta)}"]`)?.remove()
}

// Guarda el lienzo actual como plantilla reutilizable. Sobreescribe si ya existe
// una plantilla del usuario con ese nombre.
function guardarComoPlantilla(nombre: string): string | null {
  const nom = nombre.trim()
  if (!nom || !svgEl) return null
  const svg = new XMLSerializer().serializeToString(svgEl)
  const previa = [...rutasUsuario].find((r) => nombreCorto(r) === nom)
  let ruta: string
  if (previa) { plantillas[previa] = svg; ruta = previa }
  else { ruta = registrarPlantilla(nom, svg); rutasUsuario.add(ruta) }
  persistirPlantillas()
  plantillaActual = ruta
  if ([...selPlantilla.options].some((o) => o.value === ruta)) selPlantilla.value = ruta
  estado.textContent = `Plantilla guardada: ${nombreCorto(ruta)}`
  return ruta
}

// Borra una plantilla del listado. Las del usuario se eliminan; las del paquete
// se ocultan (restaurables borrando el dato de localStorage).
function borrarPlantilla(ruta: string): void {
  if (rutasUsuario.has(ruta)) {
    delete plantillas[ruta]
    rutasUsuario.delete(ruta)
    persistirPlantillas()
  } else {
    ocultas.add(nombreCorto(ruta)) // del paquete: ocultar
    persistirOcultas()
  }
  quitarDelListado(ruta)
  if (plantillaActual === ruta) {
    if (rutasPlantilla[0]) usarPlantilla(rutasPlantilla[0])
    else nuevaPlacaEnBlanco(1080, 1080)
  }
  estado.textContent = 'Plantilla borrada'
}

// Monta un SVG importado por el usuario como lienzo editable.
function usarSvgImportado(texto: string, nombre: string): void {
  // Validación rápida: que parsee y tenga raíz <svg>.
  const doc = new DOMParser().parseFromString(texto, 'image/svg+xml')
  if (doc.querySelector('parsererror') || !doc.querySelector('svg')) {
    estado.textContent = '❌ El archivo no es un SVG válido'
    return
  }
  try { localStorage.removeItem('gastonart-proyecto') } catch { /* ignorar */ }
  plantillaActual = registrarPlantilla(nombre, texto)
  svgActual = texto
  selPlantilla.value = plantillaActual
  valores = {}; estilos = {}; fotos = {}; encuadres = {}; fotoActiva = null
  void montarPlantilla()
}

function cerrarInicio(): void {
  document.querySelector('#pantalla-inicio')?.remove()
}

function mostrarInicio(): void {
  cerrarInicio()
  const grupos = [...new Set(PRESETS_TAMANO.map((p) => p.grupo))]
  const seccionesTamano = grupos.map((g) => `
    <div class="ini-grupo-tit">${g}</div>
    <div class="ini-presets">
      ${PRESETS_TAMANO.filter((p) => p.grupo === g).map((p) =>
        `<button class="ini-preset" data-w="${p.w}" data-h="${p.h}">
           <span class="ini-preset-nom">${escAttr(p.nombre)}</span>
           <span class="ini-preset-dim">${p.w}×${p.h}</span>
         </button>`).join('')}
    </div>`).join('')

  const opcionesPlantilla = rutasPlantilla.map((r) =>
    `<span class="ini-plantilla-wrap">
      <button class="ini-plantilla" data-ruta="${escAttr(r)}">${escAttr(nombreCorto(r))}</button>
      <button class="ini-plantilla-del" data-ruta="${escAttr(r)}" title="Borrar plantilla">✕</button>
    </span>`).join('')

  // ¿Hay un trabajo guardado para ofrecer "Seguir editando"?
  const autosave = (() => { try { const g = localStorage.getItem('gastonart-proyecto'); return g && g.length <= 4_000_000 ? g : null } catch { return null } })()
  const seguirHtml = autosave ? `<button id="ini-seguir" class="ini-btn-acc ini-seguir">▶ Seguir editando lo último</button>` : ''

  const ov = document.createElement('div')
  ov.id = 'pantalla-inicio'
  ov.innerHTML = `
    <div class="ini-card">
      <div class="ini-head">
        <strong>GastonART</strong>
        <span>¿Cómo querés empezar?</span>
        <button id="ini-cerrar" class="mini" title="Cerrar">✕</button>
      </div>
      <div class="ini-cols">
        <section class="ini-col">
          <h3>Imagen en blanco</h3>
          ${seccionesTamano}
          <div class="ini-grupo-tit">Personalizado</div>
          <div class="ini-custom">
            <input type="number" id="ini-w" min="16" max="8000" value="1080" aria-label="Ancho"> ×
            <input type="number" id="ini-h" min="16" max="8000" value="1080" aria-label="Alto"> px
            <button id="ini-crear-custom" class="ini-btn-acc">Crear</button>
          </div>
        </section>
        <section class="ini-col">
          ${seguirHtml}
          <h3>Usar plantilla</h3>
          <div class="ini-plantillas">${opcionesPlantilla}</div>
          <h3 style="margin-top:18px">Cargar plantilla SVG</h3>
          <button id="ini-cargar-svg" class="ini-btn-acc">Elegir archivo .svg…</button>
        </section>
      </div>
    </div>`
  document.body.appendChild(ov)

  ov.querySelector('#ini-cerrar')!.addEventListener('click', () => cerrarInicio())
  ov.querySelectorAll<HTMLButtonElement>('.ini-preset').forEach((b) =>
    b.addEventListener('click', () => { cerrarInicio(); nuevaPlacaEnBlanco(+b.dataset.w!, +b.dataset.h!) }))
  ov.querySelector('#ini-crear-custom')!.addEventListener('click', () => {
    const w = Math.max(16, Math.min(8000, +(ov.querySelector<HTMLInputElement>('#ini-w')!.value) || 1080))
    const h = Math.max(16, Math.min(8000, +(ov.querySelector<HTMLInputElement>('#ini-h')!.value) || 1080))
    cerrarInicio(); nuevaPlacaEnBlanco(w, h)
  })
  ov.querySelectorAll<HTMLButtonElement>('.ini-plantilla').forEach((b) =>
    b.addEventListener('click', () => { cerrarInicio(); usarPlantilla(b.dataset.ruta!) }))
  ov.querySelectorAll<HTMLButtonElement>('.ini-plantilla-del').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      if (confirm(`¿Borrar la plantilla «${nombreCorto(b.dataset.ruta!)}»?`)) { borrarPlantilla(b.dataset.ruta!); mostrarInicio() }
    }))
  ov.querySelector('#ini-cargar-svg')!.addEventListener('click', () => inSvgPlantilla.click())
  ov.querySelector('#ini-seguir')?.addEventListener('click', () => {
    if (!autosave) return
    cerrarInicio()
    try { void restaurarGuardado(JSON.parse(autosave)) }
    catch (e) { estado.textContent = '❌ No se pudo restaurar el último trabajo'; console.error('[seguir]', e) }
  })
}

const inSvgPlantilla = document.querySelector<HTMLInputElement>('#in-svg-plantilla')!
inSvgPlantilla.addEventListener('change', async () => {
  const file = inSvgPlantilla.files?.[0]
  if (file) {
    cerrarInicio()
    try { usarSvgImportado(await file.text(), file.name) }
    catch (e) { estado.textContent = '❌ ' + (e instanceof Error ? e.message : String(e)) }
  }
  inSvgPlantilla.value = ''
})

// ============ Zoom del lienzo (mesa de trabajo) ============
// El zoom cambia el ANCHO DE DISPLAY del lienzo (no un transform), así el factor
// k y los overlays se recalculan correctos. 100% = ajustado a la vista.
let zoomLienzo = 1
const escenario = document.querySelector<HTMLDivElement>('#escenario')!
const zoomVal = document.querySelector<HTMLButtonElement>('#zoom-val')!
function anchoBaseLienzo(): number {
  return Math.min(680, Math.max(140, escenario.clientWidth - 36))
}
function aplicarZoom(): void {
  lienzo.style.maxWidth = 'none'
  lienzo.style.width = Math.round(anchoBaseLienzo() * zoomLienzo) + 'px'
  zoomVal.textContent = Math.round(zoomLienzo * 100) + '%'
  construirOverlays()
  if (modoGrafico && grafSeleccion.length) dibujarSelGraf()
}
function setZoom(z: number): void {
  zoomLienzo = Math.max(0.25, Math.min(4, Math.round(z * 100) / 100))
  aplicarZoom()
}
document.querySelector('#zoom-menos')!.addEventListener('click', () => setZoom(zoomLienzo - 0.1))
document.querySelector('#zoom-mas')!.addEventListener('click', () => setZoom(zoomLienzo + 0.1))
document.querySelector('#zoom-val')!.addEventListener('click', () => setZoom(1))
document.querySelector('#zoom-fit')!.addEventListener('click', () => setZoom(1))
escenario.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return // Ctrl + rueda = zoom
  e.preventDefault()
  setZoom(zoomLienzo + (e.deltaY < 0 ? 0.1 : -0.1))
}, { passive: false })

let tResize: number | undefined
window.addEventListener('resize', () => {
  clearTimeout(tResize)
  tResize = window.setTimeout(() => aplicarZoom(), 150)
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
  poblarFamilias()
  cargarPlantillasUsuario() // sumar al listado las plantillas que el usuario guardó
  cargarOcultas()           // quitar del listado las plantillas del paquete que borró
  void cargarFuentesGuardadas() // re-baja las fuentes de Google agregadas (async)
  // La app SIEMPRE arranca en la pantalla de inicio (formatos + plantillas). El
  // último trabajo, si existe, se ofrece desde ahí ("Seguir editando").
  await montarPlantilla() // lienzo por defecto debajo
  mostrarInicio()
})()
