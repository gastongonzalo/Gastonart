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
  bytesABase64,
  type FontFace,
} from './font'
import { renderResvg } from './render-resvg'
import type { jsPDF } from 'jspdf'
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
let cajaManual: Record<string, boolean> = {} // el usuario redimensionó la caja a mano → no autoajustar al texto
// Cada <image> de la plantilla es un hueco de foto editable, identificado por su
// id (data-foto="0","1",…). El estado de foto/encuadre se guarda por id.
let fotos: Record<string, Foto> = {}
let framesFoto: Record<string, FrameFoto> = {}
let encuadres: Record<string, Encuadre> = {}
let fotoActiva: string | null = null // slot al que se sube/cambia la foto
// Si está seteado, la próxima imagen elegida (banco/subida) REEMPLAZA a esta
// (mantiene tamaño/posición/recorte/opacidad/filtro; solo cambia el href).
let reemplazarDestino: SVGImageElement | null = null
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
      <span class="tb-menu-wrap">
        <button id="btn-menu" class="mini" title="Archivo">☰ Archivo</button>
        <div id="menu-archivo" class="menu-archivo" hidden>
          <button id="btn-nuevo" class="tb-menu-item">＋ Nuevo diseño</button>
          <button id="btn-guardar" class="tb-menu-item">💾 Guardar proyecto</button>
          <button id="btn-cargar" class="tb-menu-item">📂 Abrir proyecto</button>
          <button id="btn-guardar-plantilla" class="tb-menu-item" title="Guardar el lienzo actual como plantilla reutilizable">🗂 Guardar como plantilla</button>
          <button id="btn-import-font" class="tb-menu-item" title="Importar tipografía (.ttf / .otf)">＋ Importar tipografía</button>
        </div>
      </span>
      <strong>GastonART</strong>
      <input id="tb-nombre" class="tb-nombre" type="text" placeholder="Mi diseño" aria-label="Nombre del proyecto" spellcheck="false">
      <select id="sel-plantilla" hidden>
        ${rutasPlantilla.map((r) => `<option value="${escAttr(r)}">${escAttr(nombreCorto(r))}</option>`).join('')}
      </select>
    </div>
    <div class="tb-centro">
      <button id="btn-deshacer" class="tb-icono" title="Deshacer (Ctrl+Z)" disabled>↶</button>
      <button id="btn-rehacer" class="tb-icono" title="Rehacer (Ctrl+Y)" disabled>↷</button>
      <span class="tb-div"></span>
      <button id="btn-copiar" class="tb-icono" title="Copiar (Ctrl+C)" disabled>⧉</button>
      <button id="btn-pegar" class="tb-icono" title="Pegar (Ctrl+V)" disabled>📋</button>
    </div>
    <div class="tb-acciones">
      <div class="modo-wrap">
        <span class="modo-tit">Modo de trabajo</span>
        <div class="modo-switch" role="group">
          <button data-modo="completa" class="activo" title="Edición completa: todo disponible">✎ Completo</button>
          <button data-modo="plantilla" title="Modo plantilla: solo cambiar textos y reemplazar fotos">🗂 Plantilla</button>
        </div>
      </div>
      <button id="btn-export" class="tb-export">⬇ Descargar</button>
    </div>
  </header>
  <span class="estado" id="estado" hidden></span>
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

  <div id="panel-tamano" hidden>
    <div class="pg-head">
      <strong>Tamaño de la mesa</strong>
      <button id="pt-cerrar" class="mini" title="Cerrar">✕</button>
    </div>
    <div id="pt-presets" class="pt-presets"></div>
    <div class="pt-custom">
      <input id="pt-w" type="number" min="0.1" max="20000" step="any" aria-label="Ancho"> ×
      <input id="pt-h" type="number" min="0.1" max="20000" step="any" aria-label="Alto">
      <select id="pt-unidad" class="unidad-sel" aria-label="Unidad">
        <option value="px">px</option>
        <option value="mm">mm</option>
        <option value="cm">cm</option>
      </select>
      <button id="pt-aplicar" class="ini-btn-acc">Aplicar</button>
    </div>
    <div class="pt-nota">Cambia el tamaño de la placa actual. El contenido queda en su lugar.</div>
  </div>

  <div id="panel-nueva-mesa" hidden>
    <div class="pg-head">
      <strong>Nueva mesa</strong>
      <button id="nm-cerrar" class="mini" title="Cerrar">✕</button>
    </div>
    <button id="nm-igual" class="ini-btn-acc nm-igual">Igual que la actual (<span id="nm-actual"></span>)</button>
    <div class="pt-nota" style="margin:10px 0 4px">…o de otra medida:</div>
    <div class="pt-custom">
      <input id="nm-w" type="number" min="0.1" max="20000" step="any" aria-label="Ancho"> ×
      <input id="nm-h" type="number" min="0.1" max="20000" step="any" aria-label="Alto">
      <select id="nm-unidad" aria-label="Unidad">
        <option value="px">px</option>
        <option value="mm">mm</option>
        <option value="cm">cm</option>
      </select>
      <button id="nm-crear" class="ini-btn-acc">Crear</button>
    </div>
  </div>

  <div class="cuerpo">
    <nav class="rail" aria-label="Categorías">
      <button class="rail-item" data-cat="plantillas" title="Plantillas"><span class="rail-ic">▦</span><span>Plantillas</span></button>
      <button class="rail-item" data-cat="texto" title="Texto"><span class="rail-ic">T</span><span>Texto</span></button>
      <button class="rail-item" data-cat="elementos" title="Formas, íconos y vectores"><span class="rail-ic">◇</span><span>Elementos</span></button>
      <button class="rail-item" data-cat="subir" title="Imágenes (subir o del banco)"><span class="rail-ic">▣</span><span>Imágenes</span></button>
      <button class="rail-item" data-cat="dibujar" title="Pluma y nodos"><span class="rail-ic">✎</span><span>Dibujar</span></button>
      <button class="rail-item" data-cat="marca" title="Tipografías"><span class="rail-ic">Aa</span><span>Fuentes</span></button>
    </nav>
    <aside id="panel-lateral" aria-label="Contenido" hidden>
      <div class="pl-head">
        <strong id="pl-titulo">Plantillas</strong>
        <button id="pl-cerrar" class="mini" title="Cerrar">✕</button>
      </div>
      <div class="pl-body">
        <section class="pl-view" data-cat="plantillas" hidden>
          <div id="pl-plantillas" class="pl-tpl-grid"></div>
        </section>

        <section class="pl-view" data-cat="texto" hidden>
          <button id="btn-add-texto" class="pl-accion">＋ Agregar cuadro de texto</button>
          <div class="pl-sub">Presets</div>
          <button class="pl-preset" data-preset="titulo" style="font-size:20px; font-weight:700;">Título</button>
          <button class="pl-preset" data-preset="subtitulo" style="font-size:15px; font-weight:600;">Subtítulo</button>
          <button class="pl-preset" data-preset="cuerpo" style="font-size:13px;">Cuerpo de texto</button>
        </section>

        <section class="pl-view" data-cat="elementos" hidden>
          <div class="pl-sub">Formas</div>
          <div id="menu-figura" class="menu-figs"></div>
          <div class="pl-sub">Íconos y vectores</div>
          <div class="pg-buscar">
            <input id="pi-input" type="text" placeholder="Buscar (inglés): heart, arrow, star…" autocomplete="off">
            <button id="pi-buscar" class="ini-btn-acc">Buscar</button>
          </div>
          <div id="pi-estado" class="pg-estado"></div>
          <div id="pi-grid" class="pi-grid"></div>
        </section>

        <section class="pl-view" data-cat="subir" hidden>
          <button id="pm-subir" class="pl-accion">⬆ Subir desde el dispositivo</button>
          <div class="pm-sep">o buscá en el banco de imágenes libres</div>
          <div class="pg-buscar">
            <input id="pm-input" type="text" placeholder="Escribí para buscar (ej. montaña, ciudad…)" autocomplete="off">
            <button id="pm-buscar" class="ini-btn-acc">Buscar</button>
          </div>
          <div id="pm-sugerencias" class="pg-sugerencias"></div>
          <div id="pm-estado" class="pg-estado"></div>
          <div id="pm-grid" class="pi-grid"></div>
        </section>

        <section class="pl-view" data-cat="marca" hidden>
          <button id="btn-import-font2" class="pl-accion">＋ Importar tipografía (.ttf / .otf)</button>
          <div class="pl-sub">Agregar de Google Fonts</div>
          <div class="pg-buscar">
            <input id="pg-input" type="text" placeholder="Nombre de la fuente (ej. Oswald)" autocomplete="off">
            <button id="pg-traer" class="ini-btn-acc">Agregar</button>
          </div>
          <div id="pg-estado" class="pg-estado"></div>
          <div class="pg-pop-tit">Populares</div>
          <div id="pg-populares" class="pg-populares"></div>
        </section>
      </div>
    </aside>
    <div id="menu-dibujar" class="menu-dibujar" hidden>
      <button id="btn-pluma" class="md-opcion">✒ Pluma</button>
      <button id="btn-nodos" class="md-opcion">⇲ Editar nodos</button>
    </div>
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
    <button id="btn-reglas" title="Reglas y guías (arrastrá desde las reglas)">📏</button>
    <button id="btn-recorte" title="Recortar a la mesa: ocultar lo que sobresale del borde">⬚</button>
  </div>
  <div id="tira-mesas"></div>
  <input type="file" id="in-foto" accept="image/*" hidden>
  <input type="file" id="in-img-nueva" accept="image/*" hidden>
  <input type="file" id="in-font" accept=".ttf,.otf,.woff,.woff2,font/*" multiple hidden>
  <input type="file" id="in-svg-plantilla" accept=".svg,image/svg+xml,.pdf,application/pdf,.ai,application/illustrator,application/postscript,image/*" hidden>

  <div id="panel-export" hidden>
    <div class="pe-head">
      <span>Exportar</span>
      <label class="pe-transp" title="Oculta el fondo a sangre de la placa para que el PNG quede transparente"><input type="checkbox" id="pe-transparente"> Fondo transparente</label>
      <a id="pe-descargar" class="pe-dl" download>⬇ PNG</a>
      <button id="pe-svg" class="pe-dl mini" title="Descargar SVG (vectorial, reabre en Illustrator/Figma)">⬇ SVG</button>
      <button id="pe-pdf" class="pe-dl mini" title="Descargar PDF vectorial">⬇ PDF</button>
      <button id="pe-carrusel" class="pe-dl" title="Cortar el carrusel en una imagen por slide (ZIP)" hidden>⬇ Carrusel (ZIP)</button>
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
const peCarrusel = document.querySelector<HTMLButtonElement>('#pe-carrusel')!
const peTransparente = document.querySelector<HTMLInputElement>('#pe-transparente')!
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
  b.addEventListener('click', () => insertarFigura(tipo))
  menuFigura.appendChild(b)
}
// Cierra los paneles FLOTANTES que quedan (solo Tamaño) excepto uno.
function cerrarPanelesFlotantes(excepto?: Element): void {
  for (const sel of ['#panel-tamano', '#panel-nueva-mesa']) {
    const p = document.querySelector<HTMLElement>(sel)
    if (p && p !== excepto) {
      if (p.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
      p.hidden = true
    }
  }
}

// --- Vista de íconos / formas / vectores (Iconify + favoritos empaquetados) ---
const piInput = document.querySelector<HTMLInputElement>('#pi-input')!
const piEstado = document.querySelector<HTMLDivElement>('#pi-estado')!
const piGrid = document.querySelector<HTMLDivElement>('#pi-grid')!

function mostrarIconosFavoritos(): void {
  piGrid.innerHTML = ''
  for (const raw of Object.values(iconosPack)) {
    const b = document.createElement('button'); b.className = 'pi-item'; b.innerHTML = raw
    // color oscuro vía `color` → resuelve currentColor de stroke Y de fill.
    const svg = b.querySelector('svg'); if (svg) (svg as SVGElement).style.color = '#1d2330'
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

let buscarIcoToken = 0
async function buscarIconos(q: string): Promise<void> {
  q = q.trim()
  if (!q) { piEstado.textContent = 'Favoritos'; mostrarIconosFavoritos(); return }
  const consulta = traducirBusqueda(q)
  const token = ++buscarIcoToken
  piEstado.textContent = 'Buscando…'; piGrid.innerHTML = ''
  let iconos: string[] = []
  try {
    const data = await (await fetchTimeout(`https://api.iconify.design/search?query=${encodeURIComponent(consulta)}&limit=120`)).json()
    iconos = (data as { icons?: string[] }).icons ?? []
  } catch { if (token === buscarIcoToken) piEstado.textContent = 'No se pudo buscar (¿sin conexión?)'; return }
  if (token !== buscarIcoToken) return
  if (!iconos.length) { piEstado.textContent = `Sin resultados para «${q}»`; return }
  piEstado.textContent = `${iconos.length} resultado(s)`
  piGrid.innerHTML = ''
  for (const nombre of iconos) {
    const b = document.createElement('button'); b.className = 'pi-item'; b.title = nombre
    const img = document.createElement('img')
    img.src = `https://api.iconify.design/${nombre}.svg?height=26&color=%231d2330`
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
document.querySelector('#pi-buscar')!.addEventListener('click', () => void buscarIconos(piInput.value))
piInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void buscarIconos(piInput.value) })
// Búsqueda EN VIVO de íconos: filtra al tipear desde la 3.ª letra; con <3 vuelve
// a Favoritos.
let tBuscarIco: number | undefined
piInput.addEventListener('input', () => {
  clearTimeout(tBuscarIco)
  const q = piInput.value.trim()
  if (q.length < 3) { if (!q) { piEstado.textContent = 'Favoritos'; mostrarIconosFavoritos() } return }
  tBuscarIco = window.setTimeout(() => void buscarIconos(q), 350)
})

// --- Vista de imagen: subir del dispositivo o banco de imágenes libres (Openverse) ---
const pmInput = document.querySelector<HTMLInputElement>('#pm-input')!
const pmEstado = document.querySelector<HTMLDivElement>('#pm-estado')!
const pmGrid = document.querySelector<HTMLDivElement>('#pm-grid')!
function abrirPanelImagen(): void {
  reemplazarDestino = null // por defecto inserta una imagen nueva
  abrirCategoria('subir')
  pmInput.focus()
}
let buscarImgToken = 0
async function buscarImagenes(q: string): Promise<void> {
  q = q.trim()
  if (!q) return
  const consulta = traducirBusqueda(q)
  const token = ++buscarImgToken // descarta resultados de búsquedas viejas (en vivo)
  pmEstado.textContent = 'Buscando…'; pmGrid.innerHTML = ''
  let resultados: { id: string; thumbnail?: string; title?: string }[] = []
  try {
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(consulta)}&page_size=20`
    const data = await (await fetchTimeout(url)).json()
    resultados = (data as { results?: typeof resultados }).results ?? []
  } catch { if (token === buscarImgToken) pmEstado.textContent = 'No se pudo buscar (¿sin conexión?)'; return }
  if (token !== buscarImgToken) return // llegó una búsqueda más nueva
  const conThumb = resultados.filter((r) => r.thumbnail)
  if (!conThumb.length) { pmEstado.textContent = `Sin resultados para «${q}»`; return }
  pmEstado.textContent = `${conThumb.length} imágenes`
  pmGrid.innerHTML = ''
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
    estado.textContent = 'Imagen agregada desde el banco'
  } catch { pmEstado.textContent = 'No se pudo agregar la imagen' }
}
document.querySelector('#pm-subir')!.addEventListener('click', () => inImgNueva.click())
document.querySelector('#pm-buscar')!.addEventListener('click', () => void buscarImagenes(pmInput.value))
pmInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void buscarImagenes(pmInput.value) })
// Búsqueda EN VIVO: filtra al tipear, a partir de la 3.ª letra (con un respiro
// para no disparar en cada tecla).
let tBuscarImg: number | undefined
pmInput.addEventListener('input', () => {
  clearTimeout(tBuscarImg)
  const q = pmInput.value.trim()
  if (q.length < 3) return
  tBuscarImg = window.setTimeout(() => void buscarImagenes(q), 350)
})

// Sugerencias al abrir Imágenes: chips de términos comunes + carga una por defecto
// para que la grilla no arranque vacía.
const SUGERENCIAS_IMG = ['naturaleza', 'ciudad', 'gente', 'comida', 'negocios', 'tecnología', 'abstracto', 'fondo']
let sugerenciasImgCargadas = false
function mostrarSugerenciasImg(): void {
  const cont = document.querySelector<HTMLDivElement>('#pm-sugerencias')
  if (!cont || cont.childElementCount) return
  for (const term of SUGERENCIAS_IMG) {
    const c = document.createElement('button'); c.className = 'pg-chip'; c.textContent = term
    c.addEventListener('click', () => { pmInput.value = term; void buscarImagenes(term) })
    cont.appendChild(c)
  }
  if (!sugerenciasImgCargadas) { sugerenciasImgCargadas = true; void buscarImagenes('naturaleza') }
}

// --- Panel de tamaño de mesa ---
const panelTamano = document.querySelector<HTMLDivElement>('#panel-tamano')!
const ptW = document.querySelector<HTMLInputElement>('#pt-w')!
const ptH = document.querySelector<HTMLInputElement>('#pt-h')!
const ptUnidad = document.querySelector<HTMLSelectElement>('#pt-unidad')!
let ptUnidadPrev = 'px'
function poblarPresetsTamano(): void {
  const cont = document.querySelector<HTMLDivElement>('#pt-presets')!
  if (cont.childElementCount) return
  for (const p of PRESETS_TAMANO) {
    const b = document.createElement('button'); b.className = 'pt-preset'
    b.innerHTML = `<span class="pt-preset-nom">${escAttr(p.nombre)}</span><span class="pt-preset-dim">${p.w}×${p.h}</span>`
    b.addEventListener('click', () => { ptUnidad.value = 'px'; ptUnidadPrev = 'px'; ptW.value = String(p.w); ptH.value = String(p.h); redimensionarMesa(p.w, p.h) })
    cont.appendChild(b)
  }
}
function clampDim(v: number): number { return Math.max(16, Math.min(8000, Math.round(v) || 16)) }
// Cuántos px vale 1 de la unidad (mm/cm a 300 DPI de impresión; 1 in = 25.4 mm = 300 px).
function pxPorUnidad(u: string): number { return u === 'mm' ? 300 / 25.4 : u === 'cm' ? 3000 / 25.4 : 1 }
// Mini-ícono SVG con la proporción real del formato (un rectángulo a escala).
function iconoProporcion(w: number, h: number): string {
  const max = 14
  let rw = max, rh = max
  if (w >= h) rh = Math.max(3, Math.round((max * h) / w)); else rw = Math.max(3, Math.round((max * w) / h))
  const x = ((16 - rw) / 2).toFixed(1), y = ((16 - rh) / 2).toFixed(1)
  return `<svg class="prop-ic" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="${x}" y="${y}" width="${rw}" height="${rh}" rx="1.5"/></svg>`
}
// El botón "Tamaño" vive en la tira de mesas (renderMesas lo crea y llama esto).
function togglePanelTamano(): void {
  const abrir = panelTamano.hidden
  cerrarPanelesFlotantes(panelTamano)
  if (abrir && svgEl) {
    poblarPresetsTamano()
    ptUnidad.value = 'px'; ptUnidadPrev = 'px'
    ptW.value = String(Math.round(svgEl.viewBox.baseVal.width)); ptH.value = String(Math.round(svgEl.viewBox.baseVal.height))
  }
  panelTamano.hidden = !abrir
}
document.querySelector('#pt-cerrar')!.addEventListener('click', () => { panelTamano.hidden = true })
ptUnidad.addEventListener('change', () => {
  const factor = pxPorUnidad(ptUnidadPrev) / pxPorUnidad(ptUnidad.value)
  const dec = ptUnidad.value === 'px' ? 0 : 1
  ptW.value = (parseFloat(ptW.value || '0') * factor).toFixed(dec)
  ptH.value = (parseFloat(ptH.value || '0') * factor).toFixed(dec)
  ptUnidadPrev = ptUnidad.value
})
document.querySelector('#pt-aplicar')!.addEventListener('click', () => {
  const f = pxPorUnidad(ptUnidad.value)
  redimensionarMesa(clampDim((parseFloat(ptW.value) || 0) * f), clampDim((parseFloat(ptH.value) || 0) * f))
})
panelTamano.addEventListener('click', (e) => e.stopPropagation())

// --- Diálogo "Nueva mesa": misma medida que la actual o una nueva (px/mm/cm) ---
const panelNuevaMesa = document.querySelector<HTMLDivElement>('#panel-nueva-mesa')!
const nmW = document.querySelector<HTMLInputElement>('#nm-w')!
const nmH = document.querySelector<HTMLInputElement>('#nm-h')!
const nmUnidad = document.querySelector<HTMLSelectElement>('#nm-unidad')!
let nmUnidadPrev = 'px'
function abrirNuevaMesa(disparador: HTMLElement): void {
  const abrir = panelNuevaMesa.hidden
  cerrarPanelesFlotantes(panelNuevaMesa)
  if (!abrir) { panelNuevaMesa.hidden = true; return }
  const w = svgEl ? Math.round(svgEl.viewBox.baseVal.width) : 1080
  const h = svgEl ? Math.round(svgEl.viewBox.baseVal.height) : 1080
  document.querySelector('#nm-actual')!.textContent = `${w} × ${h} px`
  nmUnidad.value = 'px'; nmUnidadPrev = 'px'
  nmW.value = String(w); nmH.value = String(h)
  // Posicionar el panel cerca del botón "＋".
  const r = disparador.getBoundingClientRect()
  panelNuevaMesa.style.left = Math.round(r.left) + 'px'
  panelNuevaMesa.style.bottom = Math.round(window.innerHeight - r.top + 8) + 'px'
  panelNuevaMesa.hidden = false
}
// Al cambiar de unidad, convertir los valores mostrados (igual que en la pantalla de inicio).
nmUnidad.addEventListener('change', () => {
  const factor = pxPorUnidad(nmUnidadPrev) / pxPorUnidad(nmUnidad.value)
  const dec = nmUnidad.value === 'px' ? 0 : 1
  nmW.value = (parseFloat(nmW.value || '0') * factor).toFixed(dec)
  nmH.value = (parseFloat(nmH.value || '0') * factor).toFixed(dec)
  nmUnidadPrev = nmUnidad.value
})
document.querySelector('#nm-cerrar')!.addEventListener('click', () => { panelNuevaMesa.hidden = true })
document.querySelector('#nm-igual')!.addEventListener('click', () => { panelNuevaMesa.hidden = true; void agregarMesa(false) })
document.querySelector('#nm-crear')!.addEventListener('click', () => {
  const f = pxPorUnidad(nmUnidad.value)
  const w = clampDim((parseFloat(nmW.value) || 0) * f), h = clampDim((parseFloat(nmH.value) || 0) * f)
  panelNuevaMesa.hidden = true
  void agregarMesa(false, w, h)
})
panelNuevaMesa.addEventListener('click', (e) => e.stopPropagation())
document.querySelector('#btn-pluma')!.addEventListener('click', (e) => {
  e.stopPropagation()
  grafSeleccion = []; limpiarGraf() // la pluma pone su propia capa por encima
  if (plumaActiva) desactivarPluma()
  else activarPluma()
})
document.querySelector('#btn-nodos')!.addEventListener('click', (e) => {
  e.stopPropagation()
  if (modoNodos) desactivarNodos()
  else activarNodos()
})
// Switch de modo de edición (Completa / Plantilla)
for (const b of document.querySelectorAll<HTMLButtonElement>('.modo-switch button')) {
  b.addEventListener('click', () => {
    const m = b.dataset.modo as ModoEdicion
    if (m === modoEdicion) return
    cerrarEditor()
    modoEdicion = m
    aplicarModo()
    autoguardar()
  })
}
// Cerrar los paneles flotantes al hacer clic fuera de ellos (si no, el input de
// búsqueda queda con foco y su cursor parpadea arriba a la izquierda). Se excluye
// cada panel y su botón disparador para no cerrarlos en el mismo clic que los abre.
const SEL_PANELES = '#panel-tamano, #panel-nueva-mesa'
const SEL_DISPARADORES = '#btn-tamano, #btn-nueva-mesa'
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

// --- Vista de Google Fonts (categoría Marca) ---
const pgInput = document.querySelector<HTMLInputElement>('#pg-input')!
const pgEstado = document.querySelector<HTMLDivElement>('#pg-estado')!
let popularesCargadas = false
function cargarPopularesGfonts(): void {
  if (popularesCargadas) return
  popularesCargadas = true
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
}
function abrirGfonts(): void {
  abrirCategoria('marca') // carga las populares vía abrirCategoria
  pgInput.focus()
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
document.querySelector('#btn-import-font2')!.addEventListener('click', () => inFont.click())
document.querySelector('#pg-traer')!.addEventListener('click', () => { if (pgInput.value.trim()) void agregarGfont(pgInput.value.trim()) })
pgInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && pgInput.value.trim()) void agregarGfont(pgInput.value.trim()) })

// ============ Riel de categorías + panel acoplado (estilo Express) ============
const panelLateral = document.querySelector<HTMLElement>('#panel-lateral')!
const TITULOS_CAT: Record<string, string> = {
  plantillas: 'Plantillas', texto: 'Texto', elementos: 'Elementos',
  subir: 'Imágenes', dibujar: 'Dibujar', marca: 'Fuentes',
}
let categoriaActiva: string | null = null
function abrirCategoria(cat: string): void {
  categoriaActiva = cat
  panelLateral.hidden = false
  const tit = document.querySelector('#pl-titulo'); if (tit) tit.textContent = TITULOS_CAT[cat] ?? cat
  for (const v of Array.from(panelLateral.querySelectorAll<HTMLElement>('.pl-view'))) v.hidden = v.dataset.cat !== cat
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('.rail-item'))) b.classList.toggle('activo', b.dataset.cat === cat)
  // Cargas perezosas por categoría.
  if (cat === 'elementos' && !piGrid.childElementCount) { piEstado.textContent = 'Favoritos'; mostrarIconosFavoritos() }
  if (cat === 'plantillas') renderPanelPlantillas()
  if (cat === 'marca') cargarPopularesGfonts()
  if (cat === 'subir') mostrarSugerenciasImg()
}
function cerrarCategoria(): void {
  categoriaActiva = null
  panelLateral.hidden = true
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('.rail-item'))) b.classList.remove('activo')
}
// "Dibujar" no abre el panel grande: solo un popover chico con las 2 opciones.
const menuDibujar = document.querySelector<HTMLElement>('#menu-dibujar')!
function cerrarMenuDibujar(): void {
  menuDibujar.hidden = true
  document.querySelector('.rail-item[data-cat="dibujar"]')?.classList.remove('activo')
}
function abrirMenuDibujar(item: HTMLElement): void {
  cerrarCategoria() // si había un panel abierto, se cierra
  const r = item.getBoundingClientRect()
  menuDibujar.style.top = Math.round(r.top) + 'px'
  menuDibujar.style.left = Math.round(r.right + 6) + 'px'
  menuDibujar.hidden = false
  item.classList.add('activo')
}
menuDibujar.addEventListener('click', () => cerrarMenuDibujar()) // al elegir Pluma/Nodos se cierra
for (const b of Array.from(document.querySelectorAll<HTMLElement>('.rail-item'))) {
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    const cat = b.dataset.cat!
    if (cat === 'dibujar') { menuDibujar.hidden ? abrirMenuDibujar(b) : cerrarMenuDibujar(); return }
    cerrarMenuDibujar()
    if (categoriaActiva === cat) cerrarCategoria(); else abrirCategoria(cat)
  })
}
document.querySelector('#pl-cerrar')!.addEventListener('click', cerrarCategoria)
// Cerrar el popover de Dibujar al clic afuera.
document.addEventListener('pointerdown', (e) => {
  if (menuDibujar.hidden) return
  const t = e.target as Element | null
  if (t && !t.closest('#menu-dibujar') && !t.closest('.rail-item[data-cat="dibujar"]')) cerrarMenuDibujar()
}, true)

// Grilla de plantillas dentro del panel (misma idea que la pantalla de inicio).
function renderPanelPlantillas(): void {
  const cont = document.querySelector<HTMLDivElement>('#pl-plantillas')!
  cont.innerHTML = ''
  for (const ruta of rutasPlantilla) {
    const svg = plantillas[ruta] || ''
    const thumb = svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(miniaturaSvg(svg))}` : ''
    const b = document.createElement('button'); b.className = 'pl-tpl'
    b.innerHTML = `<span class="pl-tpl-thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : ''}</span><span class="pl-tpl-nom">${escHtml(nombreCorto(ruta))}</span>`
    b.addEventListener('click', () => usarPlantilla(ruta))
    cont.appendChild(b)
  }
}

// Presets de texto (Título / Subtítulo / Cuerpo): agregan un cuadro y fijan tamaño.
function agregarTextoPreset(mult: number): void {
  agregarTexto()
  if (!editorActivo) return
  const nombre = editorActivo.nombre
  const base = metricas[nombre]?.fontSizeUser ?? 48
  ;(estilos[nombre] ??= {}).fontSize = Math.max(8, Math.round(base * mult))
  aplicarEstiloTextarea(nombre); sincronizarBarra(nombre); marcarCampoEditado()
}
for (const b of Array.from(document.querySelectorAll<HTMLElement>('.pl-preset'))) {
  b.addEventListener('click', () => {
    const p = b.dataset.preset
    agregarTextoPreset(p === 'titulo' ? 1.7 : p === 'subtitulo' ? 1.1 : 0.7)
  })
}

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
  grafSeleccion = []; limpiarGraf()
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
  aplicarModo() // engancha la capa de selección al nuevo svg + construye overlays
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
  cajaManual = {}
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
// terminan en guion. Prefiere cortar por sílabas (español); si una sílaba no
// entra NI SOLA (p.ej. una tira sin vocales como "ddddd…"), la parte por
// CARACTERES para que nunca se desborde.
function partirPalabra(palabra: string, m: Metrica, escala: number): string[] {
  const guion = medirAncho('-', m, escala)
  // Tokens a acomodar: sílabas que entran; las que no, divididas en caracteres.
  const tokens: string[] = []
  for (const sil of silabas(palabra)) {
    if (medirAncho(sil, m, escala) + guion <= m.maxWidthUser) tokens.push(sil)
    else for (const ch of Array.from(sil)) tokens.push(ch)
  }
  const piezas: string[] = []
  let actual = ''
  for (const tok of tokens) {
    const cand = actual + tok
    // Reservamos el ancho del guion: así `actual + '-'` siempre entra.
    if (actual !== '' && medirAncho(cand, m, escala) + guion > m.maxWidthUser) {
      piezas.push(actual + '-')
      actual = tok
    } else {
      actual = cand
    }
  }
  if (actual) piezas.push(actual)
  return piezas.length ? piezas : [palabra]
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

  // Caja de alto FIJADO A MANO → recortar las líneas que no entran. Las cajas
  // automáticas (no manuales) dejan fluir el texto y se ajustan a él.
  if (cajaManual[nombre] && cajaAlto[nombre] !== undefined) {
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
  const vh = vb.height || 1080
  // Tamaño/posición PROPORCIONALES al lienzo: con valores fijos (48px, x0=90) el
  // texto desbordaba la caja en lienzos chicos → el render quedaba en 1 línea
  // pero el textarea lo envolvía en 2 (el texto "saltaba" al editar). Así la caja
  // siempre es bastante más ancha que el texto por defecto.
  const fs = Math.max(12, Math.round(vw * 0.045))
  const x0 = Math.round(vw * 0.08)
  const y0 = Math.round(vh * 0.17) + (contadorAgregados % 6) * Math.round(fs * 0.9)

  const t = document.createElementNS(SVGNS, 'text')
  t.setAttribute('data-campo', nombre)
  t.setAttribute('data-anchor', '1')
  t.setAttribute('data-agregado', 'texto')
  t.setAttribute('transform', `translate(${x0} ${y0})`)
  t.style.fontFamily = "'Poppins'"
  t.style.fontWeight = '600'
  t.style.fontSize = fs + 'px'
  t.style.fill = '#141930'
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
    maxWidthUser: Math.max(fs * 4, vw - x0 * 2),
    boxLines: 50,
  }
  valores[nombre] = 'Texto nuevo'
  bloqueado[nombre] = false // los cuadros agregados nacen movibles

  // Renderizar por la ruta estándar (envolver/ajustar): así el layout inicial es
  // idéntico al que produce la edición → al abrir el editor el texto no se mueve.
  pintarCampo(nombre)
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
  if (reemplazarDestino) {
    const im = reemplazarDestino; reemplazarDestino = null
    im.setAttribute('href', f.dataUrl); im.setAttributeNS(XLINK, 'xlink:href', f.dataUrl)
    registrarHistorial(); autoguardar(); dibujarSelGraf()
    estado.textContent = 'Imagen reemplazada'
    return
  }
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
  seleccionarAgregado(img)
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

// Tras insertar un elemento agregado: reconstruye overlays, lo deja SELECCIONADO
// (caja + panel de propiedades) y registra historial/autoguardado. Antes el
// recién agregado no quedaba seleccionado y tampoco se anotaba en el historial.
function seleccionarAgregado(el: SVGElement): void {
  construirOverlays()
  if (modoGrafico) { grafSeleccion = [graficoSeleccionable(el) ?? el]; dibujarSelGraf() }
  registrarHistorial(); autoguardar()
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
  seleccionarAgregado(el)
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
  seleccionarAgregado(g)
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
let plumaResumePath: SVGPathElement | null = null // trazo abierto que se está continuando
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
  desactivarNodos()
  plumaActiva = true
  plumaAnclas = []
  plumaResumePath = null
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
  plumaResumePath = null
  lienzo.querySelectorAll('.pluma-pt, .pluma-manija').forEach((n) => n.remove())
  document.removeEventListener('keydown', plumaKey)
  plumaAnclas = []
}

function plumaKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') desactivarPluma()
  else if (e.key === 'Enter') finalizarPluma(false)
}

// Si el clic (con la pluma recién activada, sin puntos) cae sobre el EXTREMO de un
// trazo abierto existente, lo carga para continuarlo (estilo Illustrator). Pasa
// las anclas a espacio de usuario (vía CTM, baked) y, si tocó el extremo inicial,
// invierte el orden para seguir agregando por el final. Devuelve true si retomó.
function resumirTrazo(clientX: number, clientY: number): boolean {
  if (!svgEl || plumaAnclas.length) return false
  const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
  const base = svgEl.getBoundingClientRect()
  for (const path of Array.from(svgEl.querySelectorAll<SVGPathElement>('path[data-agregado="figura"]'))) {
    const r = parsearD(path.getAttribute('d') || '')
    if (!r || r.cerrado || r.anclas.length < 2) continue
    const sctm = path.getScreenCTM(); if (!sctm) continue
    // local -> pantalla (hit) y local -> usuario (viewBox) para seguir editando.
    const screenOf = (x: number, y: number) => { const p = svgEl!.createSVGPoint(); p.x = x; p.y = y; const s = p.matrixTransform(sctm); return { sx: s.x, sy: s.y } }
    const userOf = (x: number, y: number) => { const s = screenOf(x, y); return { x: (s.sx - base.left) / k, y: (s.sy - base.top) / k } }
    const vecUser = (vx: number, vy: number) => ({ x: (sctm.a * vx + sctm.c * vy) / k, y: (sctm.b * vx + sctm.d * vy) / k })
    const iN = r.anclas.length - 1
    const s0 = screenOf(r.anclas[0].x, r.anclas[0].y)
    const sN = screenOf(r.anclas[iN].x, r.anclas[iN].y)
    const d0 = Math.hypot(s0.sx - clientX, s0.sy - clientY)
    const dN = Math.hypot(sN.sx - clientX, sN.sy - clientY)
    if (Math.min(d0, dN) > 12) continue
    // Anclas a espacio de usuario (baked el transform del path, incluido scale).
    let anclas: Ancla[] = r.anclas.map((a) => {
      const u = userOf(a.x, a.y), hi = vecUser(a.hix, a.hiy), ho = vecUser(a.hox, a.hoy)
      return { x: u.x, y: u.y, hix: hi.x, hiy: hi.y, hox: ho.x, hoy: ho.y }
    })
    // Si tocó el extremo INICIAL, invertir para continuar desde ese lado (las
    // manijas in/out se intercambian al invertir el sentido del trazo).
    if (d0 <= dN) {
      anclas = anclas.reverse().map((a) => ({ x: a.x, y: a.y, hix: a.hox, hiy: a.hoy, hox: a.hix, hoy: a.hiy }))
    }
    plumaAnclas = anclas
    plumaResumePath = path
    const last = anclas[anclas.length - 1]
    plumaCursor = { x: last.x, y: last.y }
    dibujarPluma()
    dibujarPreviewPluma()
    return true
  }
  return false
}

function plumaPointerDown(e: PointerEvent): void {
  if (!svgEl || !plumaCapa) return
  e.preventDefault()
  // Sin puntos aún: si se clickea el extremo de un trazo abierto, retomarlo.
  if (!plumaAnclas.length && resumirTrazo(e.clientX, e.clientY)) return
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
  if (plumaResumePath) {
    // Continuación de un trazo: heredar su estilo y reemplazarlo en su lugar.
    for (const a of Array.from(plumaResumePath.attributes)) {
      if (a.name === 'd' || a.name === 'transform') continue
      p.setAttribute(a.name, a.value)
    }
    p.setAttribute('transform', `translate(${minX} ${minY}) scale(1)`)
    plumaResumePath.parentNode!.replaceChild(p, plumaResumePath)
  } else {
    p.setAttribute('fill', 'none')
    p.setAttribute('stroke', COLOR_PLUMA)
    p.setAttribute('stroke-width', '4')
    p.setAttribute('stroke-linecap', 'round')
    p.setAttribute('stroke-linejoin', 'round')
    p.setAttribute('transform', `translate(${minX} ${minY}) scale(1)`)
    p.setAttribute('data-agregado', 'figura')
    p.setAttribute('data-colormode', 'stroke')
    svgEl.appendChild(p)
  }
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
let editTools: HTMLDivElement | null = null
let editSel: number | null = null // ancla seleccionada (para Borrar / Esquina-Curva)
let editModoAgregar = false // ON = clic sobre el trazo inserta un punto

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

// Convierte una forma de segmentos rectos (polygon/polyline/line) en un <path>
// editable equivalente, preservando estilo/transform/data-* (mismo render). Un
// <path> se devuelve tal cual. Otras formas (rect/circle/ellipse) → null (no se
// editan por nodos para no alterarlas: se decidió "solo path y polígonos").
function formaAEditablePath(el: SVGElement): SVGPathElement | null {
  const tag = el.tagName.toLowerCase()
  if (tag === 'path') return el as SVGPathElement
  let d = ''
  if (tag === 'polygon' || tag === 'polyline') {
    const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number).filter((n) => !isNaN(n))
    if (pts.length < 4) return null
    d = `M ${pts[0]} ${pts[1]}`
    for (let i = 2; i + 1 < pts.length; i += 2) d += ` L ${pts[i]} ${pts[i + 1]}`
    if (tag === 'polygon') d += ' Z'
  } else if (tag === 'line') {
    const g = (n: string) => +(el.getAttribute(n) || '0') || 0
    d = `M ${g('x1')} ${g('y1')} L ${g('x2')} ${g('y2')}`
  } else {
    return null
  }
  const path = document.createElementNS(SVGNS, 'path')
  for (const a of Array.from(el.attributes)) {
    if (['points', 'x1', 'y1', 'x2', 'y2'].includes(a.name)) continue
    path.setAttribute(a.name, a.value)
  }
  path.setAttribute('d', d)
  el.parentNode!.replaceChild(path, el)
  const i = grafSeleccion.indexOf(el); if (i >= 0) grafSeleccion[i] = path
  return path
}

function entrarEditarPuntos(el: SVGElement): void {
  const path = formaAEditablePath(el)
  if (!path) { alert('Esta forma no se edita por nodos (solo trazos y polígonos). Convertila a trazo primero.'); return }
  const r = parsearD(path.getAttribute('d') || '')
  if (!r) { alert('Este trazo no se puede editar punto a punto (tiene varios subtrazos o arcos).'); return }
  cerrarEditorPuntos()
  editPath = path
  editAnclas = r.anclas
  editCerrado = r.cerrado
  editSel = null
  editModoAgregar = false
  limpiarGraf()
  editLineas = document.createElementNS(SVGNS, 'svg') as unknown as SVGSVGElement
  editLineas.setAttribute('class', 'edit-svg')
  lienzo.appendChild(editLineas)
  editCapa = document.createElement('div')
  editCapa.className = 'edit-capa'
  editCapa.addEventListener('pointerdown', editPointerDown)
  editCapa.addEventListener('dblclick', editDblClick)
  lienzo.appendChild(editCapa)
  crearEditTools()
  document.addEventListener('keydown', editKey)
  dibujarEditor()
}

// Barra flotante con acciones visibles del editor de puntos (agregar/borrar/
// esquina↔curva/listo), para no depender solo de atajos.
function crearEditTools(): void {
  editTools = document.createElement('div')
  editTools.className = 'edit-tools'
  editTools.addEventListener('pointerdown', (e) => e.stopPropagation())
  const btn = (txt: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button'); b.className = 'graf-btn'; b.textContent = txt; b.title = title
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick() })
    editTools!.appendChild(b); return b
  }
  btn('➕ Agregar', 'Modo agregar: clic sobre el trazo inserta un punto', () => {
    editModoAgregar = !editModoAgregar
    if (editCapa) editCapa.style.cursor = editModoAgregar ? 'crosshair' : 'default'
    dibujarEditor()
  }).dataset.rol = 'agregar'
  btn('🗑 Borrar', 'Borrar el punto seleccionado (Supr)', () => borrarNodoSel()).dataset.rol = 'borrar'
  btn('⌣ Curva / ◇ Esquina', 'Alternar el punto seleccionado entre esquina y curva (doble clic)', () => {
    if (editSel != null) { alternarTipoNodo(editSel); dibujarEditor() }
  }).dataset.rol = 'tipo'
  btn('✓ Listo', 'Terminar de editar puntos (Enter / Esc)', () => salirEditarPuntos())
  const hint = document.createElement('span'); hint.className = 'edit-hint'
  hint.textContent = 'Arrastrá los nodos · doble clic = esquina/curva'
  editTools.appendChild(hint)
  lienzo.appendChild(editTools)
}

function borrarNodoSel(): void {
  if (editSel == null || editAnclas.length <= 2) return
  editAnclas.splice(editSel, 1)
  editSel = null
  dibujarEditor()
}

// Alterna un ancla entre esquina (sin manijas) y curva (manijas según vecinos).
function alternarTipoNodo(i: number): void {
  const n = editAnclas.length, a = editAnclas[i]
  if (tieneIn(a) || tieneOut(a)) { a.hix = a.hiy = a.hox = a.hoy = 0 } // -> esquina
  else { // -> curva: manijas según la dirección de los vecinos
    const prev = editAnclas[(i - 1 + n) % n], next = editAnclas[(i + 1) % n]
    const vx = next.x - prev.x, vy = next.y - prev.y
    const len = Math.hypot(vx, vy) || 1
    const mag = Math.min(Math.hypot(a.x - prev.x, a.y - prev.y), Math.hypot(next.x - a.x, next.y - a.y)) / 3
    a.hox = (vx / len) * mag; a.hoy = (vy / len) * mag
    a.hix = -a.hox; a.hiy = -a.hoy
  }
}

// Refleja el estado en los botones de la barra (habilitado/activo).
function actualizarEditTools(): void {
  if (!editTools) return
  const get = (rol: string) => editTools!.querySelector<HTMLButtonElement>(`[data-rol="${rol}"]`)
  const hayNodos = editAnclas.length > 2
  const agregar = get('agregar'); if (agregar) agregar.classList.toggle('activo', editModoAgregar)
  const borrar = get('borrar'); if (borrar) borrar.disabled = editSel == null || !hayNodos
  const tipo = get('tipo'); if (tipo) tipo.disabled = editSel == null
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
  editAnclas.forEach((a, i) => {
    const s = localAPx(a.x, a.y)
    if (tieneIn(a)) { const h = localAPx(a.x + a.hix, a.y + a.hiy); linea(s.left, s.top, h.left, h.top); dot(h.left, h.top, 'pluma-manija') }
    if (tieneOut(a)) { const h = localAPx(a.x + a.hox, a.y + a.hoy); linea(s.left, s.top, h.left, h.top); dot(h.left, h.top, 'pluma-manija') }
    dot(s.left, s.top, 'pluma-pt' + (i === editSel ? ' sel' : ''))
  })
  actualizarEditTools()
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

// Inserta un ancla nueva sobre el trazo en el punto más cercano al clic (estilo
// "agregar punto" de Illustrator). Divide el tramo (recta o Bézier, con De
// Casteljau) conservando la forma. Devuelve true si insertó.
function insertarPuntoEditor(clientX: number, clientY: number): boolean {
  const base = lienzo.getBoundingClientRect()
  const px = clientX - base.left, py = clientY - base.top
  const n = editAnclas.length
  if (n < 2) return false
  const segs: [number, number][] = []
  for (let i = 0; i < n - 1; i++) segs.push([i, i + 1])
  if (editCerrado) segs.push([n - 1, 0])
  let best: { i0: number; t: number } | null = null, bestD = 14
  for (const [i0, i1] of segs) {
    const A0 = editAnclas[i0], A1 = editAnclas[i1]
    const cubic = tieneOut(A0) || tieneIn(A1)
    const c1x = A0.x + A0.hox, c1y = A0.y + A0.hoy, c2x = A1.x + A1.hix, c2y = A1.y + A1.hiy
    const N = 24
    for (let s = 0; s <= N; s++) {
      const t = s / N, u = 1 - t
      const lx = cubic ? u * u * u * A0.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * A1.x : A0.x + (A1.x - A0.x) * t
      const ly = cubic ? u * u * u * A0.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * A1.y : A0.y + (A1.y - A0.y) * t
      const p = localAPx(lx, ly), d = Math.hypot(p.left - px, p.top - py)
      if (d < bestD) { bestD = d; best = { i0, t } }
    }
  }
  if (!best) return false
  const { i0, t } = best
  const A0 = editAnclas[i0], A1 = editAnclas[(i0 + 1) % n]
  let nueva: Ancla
  if (tieneOut(A0) || tieneIn(A1)) {
    const c1x = A0.x + A0.hox, c1y = A0.y + A0.hoy, c2x = A1.x + A1.hix, c2y = A1.y + A1.hiy
    const L = (ax: number, ay: number, bx: number, by: number) => ({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t })
    const A = L(A0.x, A0.y, c1x, c1y), B = L(c1x, c1y, c2x, c2y), C = L(c2x, c2y, A1.x, A1.y)
    const D = L(A.x, A.y, B.x, B.y), E = L(B.x, B.y, C.x, C.y), F = L(D.x, D.y, E.x, E.y)
    A0.hox = A.x - A0.x; A0.hoy = A.y - A0.y
    A1.hix = C.x - A1.x; A1.hiy = C.y - A1.y
    nueva = { x: F.x, y: F.y, hix: D.x - F.x, hiy: D.y - F.y, hox: E.x - F.x, hoy: E.y - F.y }
  } else {
    nueva = { x: A0.x + (A1.x - A0.x) * t, y: A0.y + (A1.y - A0.y) * t, hix: 0, hiy: 0, hox: 0, hoy: 0 }
  }
  editAnclas.splice(i0 + 1, 0, nueva)
  return true
}

function editPointerDown(e: PointerEvent): void {
  if (!editCapa) return
  const hit = editHit(e.clientX, e.clientY)
  // Modo agregar: el clic sobre el trazo inserta un punto (no arrastra/selecciona).
  if (editModoAgregar) {
    e.preventDefault()
    if (!hit && insertarPuntoEditor(e.clientX, e.clientY)) dibujarEditor()
    return
  }
  if (!hit) {
    // Clic en vacío: deseleccionar (NO salir: se sale con Listo / Enter / Esc).
    e.preventDefault(); editSel = null; dibujarEditor(); return
  }
  e.preventDefault()
  const a = editAnclas[hit.i]
  if (hit.tipo === 'a') { editSel = hit.i; dibujarEditor() } // seleccionar para los botones
  // Alt + clic sobre un ANCLA (sin arrastrar) = eliminar el punto.
  if (hit.tipo === 'a' && e.altKey && editAnclas.length > 2) {
    let movido = false
    const onMv = () => { movido = true }
    const onUp = () => {
      editCapa!.removeEventListener('pointermove', onMv)
      if (!movido) { editAnclas.splice(hit.i, 1); editSel = null; dibujarEditor() }
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

// Doble clic sobre un ancla: alterna entre esquina (sin manijas) y curva.
function editDblClick(e: MouseEvent): void {
  const hit = editHit(e.clientX, e.clientY)
  if (!hit || hit.tipo !== 'a') return
  e.preventDefault()
  editSel = hit.i
  alternarTipoNodo(hit.i)
  dibujarEditor()
}

function editKey(e: KeyboardEvent): void {
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); borrarNodoSel(); return }
  if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); salirEditarPuntos() }
}

function salirEditarPuntos(): void {
  if (!editPath) return
  editPath.setAttribute('d', dPluma(editAnclas, editCerrado))
  const path = editPath
  cerrarEditorPuntos()
  registrarHistorial(); autoguardar()
  if (modoNodos) { grafSeleccion = []; limpiarGraf(); ponerNodosCapa() } // seguir eligiendo nodos
  else if (modoGrafico) { grafSeleccion = [path]; dibujarSelGraf() }
  else construirOverlays()
}

function editandoPuntos(): boolean { return editPath != null }

// ============ Puntero blanco (modo nodos): editar puntos de cualquier trazo ============
// Herramienta global: clic en un trazo/polígono lo abre en el editor de puntos
// (sin tener que seleccionarlo y apretar "✎ Puntos"). Estilo selección directa.
let modoNodos = false
let nodosCapa: HTMLDivElement | null = null

function ponerNodosCapa(): void {
  if (nodosCapa || !modoNodos || !svgEl) return
  nodosCapa = document.createElement('div')
  nodosCapa.className = 'nodos-capa'
  nodosCapa.addEventListener('pointerdown', nodosPointerDown)
  lienzo.appendChild(nodosCapa)
}
function quitarNodosCapa(): void { nodosCapa?.remove(); nodosCapa = null }

function activarNodos(): void {
  if (!svgEl) return
  desactivarPluma()
  cerrarEditor()
  grafSeleccion = []; limpiarGraf()
  modoNodos = true
  document.querySelector('#btn-nodos')!.classList.add('activo-pluma')
  ponerNodosCapa()
}
function desactivarNodos(): void {
  if (!modoNodos && !nodosCapa) return
  modoNodos = false
  document.querySelector('#btn-nodos')?.classList.remove('activo-pluma')
  quitarNodosCapa()
  if (editandoPuntos()) salirEditarPuntos()
}

function nodosPointerDown(e: PointerEvent): void {
  if (!nodosCapa || !svgEl) return
  e.preventDefault()
  // Buscar el elemento bajo el puntero (la capa tapa el svg → la apagamos un instante).
  nodosCapa.style.pointerEvents = 'none'
  const bajo = document.elementFromPoint(e.clientX, e.clientY) as Element | null
  nodosCapa.style.pointerEvents = ''
  const u = bajo ? graficoSeleccionable(bajo) : null
  if (!u) return
  const tag = u.tagName.toLowerCase()
  if (!['path', 'polygon', 'polyline', 'line'].includes(tag)) {
    estado.textContent = 'El puntero blanco edita trazos y polígonos; esta forma no.'
    return
  }
  quitarNodosCapa() // que la capa del editor de puntos tome el control
  entrarEditarPuntos(u)
}

function cerrarEditorPuntos(): void {
  editCapa?.remove(); editCapa = null
  editLineas?.remove(); editLineas = null
  editTools?.remove(); editTools = null
  lienzo.querySelectorAll('.pluma-pt, .pluma-manija').forEach((n) => n.remove())
  document.removeEventListener('keydown', editKey)
  editPath = null; editAnclas = []; editCerrado = false
  editSel = null; editModoAgregar = false
}

// ---------------------------------------------------------------
//  Modo Gráficos: seleccionar/editar vectores e imágenes de la plantilla
// ---------------------------------------------------------------
const TAGS_GRAFICO = new Set(['rect', 'circle', 'ellipse', 'path', 'polygon', 'polyline', 'line', 'image', 'use'])
let modoGrafico = false
let grafSeleccion: SVGElement[] = []

// Modo de edición de alto nivel: 'completa' = todo; 'plantilla' = restringido
// (solo editar texto + reemplazar/reencuadrar fotos). Se persiste por mesa.
type ModoEdicion = 'completa' | 'plantilla'
let modoEdicion: ModoEdicion = 'completa'

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
  // luego el elemento AGREGADO (p.ej. un ícono es un <g data-agregado="icono"> con
  // varios paths → se selecciona el grupo, no un path suelto, y se mueve/escala
  // proporcionado); si no, el grupo recortado (clip-path) más externo.
  let grupo: SVGElement | null = null
  let agregado: SVGElement | null = null
  let recortado: SVGElement | null = null
  let a: Element | null = hallado
  // Área de la placa para no tratar como "pieza" a un grupo recortado que cubre
  // casi todo (esos son contenedores de la plantilla, no logos): si lo eligiéramos,
  // un recorte borraría la placa entera.
  const pr = svgEl!.getBoundingClientRect()
  const areaPlaca = Math.max(1, pr.width * pr.height)
  while (a && a !== svgEl) {
    if (a.getAttribute && a.getAttribute('data-grupo') === '1') grupo = a as SVGElement
    else if (a.getAttribute && a.getAttribute('data-agregado') != null) agregado = a as SVGElement
    else if (!(a.getAttribute && a.getAttribute('data-graf-wrap') === '1')) {
      const cp = getComputedStyle(a).clipPath
      if (cp && cp !== 'none') {
        const ab = (a as SVGGraphicsElement).getBoundingClientRect()
        if ((ab.width * ab.height) / areaPlaca < 0.6) recortado = a as SVGElement // solo piezas chicas
      }
    }
    a = a.parentElement
  }
  return grupo ?? agregado ?? recortado ?? hallado
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

// Punto central que sincroniza la UI según `modoEdicion`.
//  - 'completa': UNA sola superficie. La clase .modo-grafico apaga los overlays
//    normales y el svg captura todos los clics (se puede seleccionar cualquier
//    vector, incluso sobre la foto de fondo). La edición de texto y el manejo de
//    fotos se injertan en grafPointerDown.
//  - 'plantilla': overlays normales filtrados (solo texto + foto), sin selección
//    de vectores.
function aplicarModo(): void {
  document.body.classList.toggle('modo-plantilla', modoEdicion === 'plantilla')
  document.querySelectorAll<HTMLElement>('.modo-switch button').forEach((b) => {
    b.classList.toggle('activo', b.dataset.modo === modoEdicion)
  })
  // Re-set idempotente de la capa de selección (el svg pudo haber cambiado).
  svgEl?.removeEventListener('pointerdown', grafPointerDown)
  document.removeEventListener('keydown', grafKey)
  grafSeleccion = []
  limpiarGraf()
  if (modoEdicion === 'completa') {
    modoGrafico = true
    lienzo.classList.add('modo-grafico')
    if (svgEl) svgEl.addEventListener('pointerdown', grafPointerDown)
    document.addEventListener('keydown', grafKey)
  } else {
    modoGrafico = false
    lienzo.classList.remove('modo-grafico')
  }
  construirOverlays()
}

function grafKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (reframeG) { salirReencuadre(); return }
    if (grafSeleccion.length) { grafSeleccion = []; limpiarGraf() }
    // En completa la selección está siempre activa: Escape solo deselecciona.
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
  // Las barras flotantes (graf-tools, foto-tools) viven en <body>; el resto de
  // overlays (cajas, tiradores, marquee) en el lienzo.
  document.querySelectorAll('.graf-tools, .foto-tools').forEach((n) => n.remove())
  lienzo.querySelectorAll('.graf-sel, .resize-handle, .btn-eliminar, .graf-marquee, .grad-panel, .alinear-panel').forEach((n) => n.remove())
  actualizarBotonesEdicion()
  actualizarPanelProps()
}

// Panel de propiedades (derecha): contextual según lo seleccionado. Fase 1:
// estado vacío con acciones de la placa + cabecera del elemento seleccionado.
// Sin panel de propiedades: con selección los controles flotan (dibujarSelGraf);
// sin selección se muestran las barras flotantes de cada hueco de foto (la foto a
// sangre suele estar tapada por overlays y no se puede clickear). Las acciones de
// placa (Tamaño / Guardar plantilla / Exportar) viven en la barra superior.
function actualizarPanelProps(): void {
  if (!svgEl || grafSeleccion.length) return
  const huecos = idsFoto().filter((id) => { const im = svgEl!.querySelector(`[data-foto="${id}"]`); return im && !im.closest('[data-recorte]') })
  for (const id of huecos) construirFotoTools(id)
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
  const tgt = e.target as Element
  const aditivo = e.ctrlKey || e.metaKey
  // Confirmar cualquier texto en edición ANTES de procesar el clic: como abajo
  // hacemos e.preventDefault() (para no seleccionar texto del SVG), el textarea no
  // pierde el foco solo → sin esto, su editor quedaba abierto tapando el hit y el
  // recién agregado no se podía arrastrar hasta abrir otro editor.
  const campoEl = tgt.closest?.('[data-campo]')
  if (editorActivo && editorActivo.nombre !== campoEl?.getAttribute('data-campo')) cerrarEditor()
  // Texto: clic SIMPLE abre el editor inline. Pero con Ctrl/Cmd (selección
  // aditiva) el clic en un cuadro de texto agregado lo SUMA a la selección
  // gráfica (para alinear/agrupar/mover junto con formas) en vez de editarlo:
  // cae al camino de graficoSeleccionable de más abajo.
  if (campoEl && !aditivo) { e.preventDefault(); abrirEditor(campoEl.getAttribute('data-campo')!); return }
  // Foto de hueco suelto (no recorte): vacío → subir; cargada → arrastrar reencuadra.
  // (La mini-barra Cambiar/Zoom/Opac/Editar/Quitar fondo la arma construirOverlays.)
  const fotoEl = tgt.closest?.('[data-foto]') as SVGElement | null
  if (fotoEl && !fotoEl.closest('[data-recorte]')) {
    e.preventDefault()
    const fid = fotoEl.getAttribute('data-foto')!
    grafSeleccion = []; limpiarGraf() // panel muestra los controles de la foto (placa)
    if (!fotos[fid]) { fotoActiva = fid; inFoto.click() }
    else iniciarPanFoto(e, fid)
    return
  }
  const el = graficoSeleccionable(e.target as Element)
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
    const t = g.getAttribute('transform') ?? ''
    const tm = t.match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)/)
    // Preservar el resto del transform (p.ej. scale de un resize previo): si solo
    // se reemplazaba el translate, se perdía el scale y el elemento "saltaba".
    const resto = tm ? (t.slice(0, tm.index) + t.slice(tm.index! + tm[0].length)).trim() : t.trim()
    return { g, tx0: tm ? +tm[1] : 0, ty0: tm ? +tm[2] : 0, resto }
  })
  // Para imantar: caja-unión de la selección (px del lienzo) y excluirla del imán.
  const base0 = lienzo.getBoundingClientRect()
  const rect0 = rectUnion(grafSeleccion, base0)
  snapExcluirSet = new Set(grafSeleccion)
  let sx = e.clientX, sy = e.clientY, accX = 0, accY = 0, movido = false
  const onMove = (ev: PointerEvent) => {
    accX += (ev.clientX - sx) / k; accY += (ev.clientY - sy) / k
    sx = ev.clientX; sy = ev.clientY
    if (Math.abs(accX) + Math.abs(accY) > 1) movido = true
    // Guías inteligentes: imantar a centro/bordes de la placa y de otros elementos.
    let dx = 0, dy = 0
    if (rect0) {
      const base = lienzo.getBoundingClientRect()
      const rawBox: Rect = { left: rect0.left + accX * k, top: rect0.top + accY * k, width: rect0.width, height: rect0.height }
      const snap = calcularSnap(rawBox, base)
      dx = snap.dx / k; dy = snap.dy / k
      dibujarGuias(snap.guias)
    }
    for (const w of wraps) w.g.setAttribute('transform', `translate(${w.tx0 + accX + dx} ${w.ty0 + accY + dy}) ${w.resto}`.trim())
    dibujarSelGraf() // no borra las .guia (limpiarGraf no las incluye)
  }
  const onUp = () => {
    svgEl!.removeEventListener('pointermove', onMove)
    snapExcluirSet = null
    limpiarGuias()
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
  // Propagar a cada hijo los atributos de presentación HEREDABLES del grupo (p.ej.
  // el fill/stroke del ícono): los hijos los heredaban del <g>, y al sacarlos del
  // grupo los perderían (un ícono de contorno se volvía mancha negra rellena).
  const heredables = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity', 'fill-opacity', 'stroke-opacity', 'color']
  const estiloGrupo: Record<string, string> = {}
  for (const a of heredables) { const v = grupo.getAttribute(a); if (v != null) estiloGrupo[a] = v }
  const hijos = Array.from(grupo.children) as SVGElement[]
  for (const kid of hijos) {
    for (const a in estiloGrupo) if (kid.getAttribute(a) == null) kid.setAttribute(a, estiloGrupo[a])
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
// Opciones de "Ordenar" (capas + alinear/buscatrazos) como contenedor inline,
// para desplegarse DEBAJO del botón dentro del panel de propiedades.
function construirOrdenarCont(): HTMLElement {
  const multi = grafSeleccion.length > 1
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
  return cont
}

// Dibuja recuadro(s) de selección + mini-barra (relleno, contorno, agrupar/desagrupar, borrar).
// ============ Barra contextual flotante (estilo Express) ============
// Reemplaza al panel de propiedades: los controles del elemento seleccionado
// (o del texto en edición) flotan en una barra ENCIMA del elemento.
// Centra `el` arriba de `target` (px del lienzo); si no entra arriba va abajo /
// pegado al borde superior, y se clampa al ancho del lienzo.
// Desplazamiento manual de la barra flotante (si el usuario la arrastró).
// Se reinicia al cambiar de selección (ver dibujarSelGraf).
let barraOffset = { dx: 0, dy: 0 }
let barraSelFirma: SVGElement | null = null

// La barra flota en coordenadas de VIEWPORT (position: fixed, anexada a <body>),
// así puede salir de la mesa de trabajo y moverse libre por toda la pantalla.
// `target` viene en coords relativas al lienzo → se convierte a viewport.
function posicionarFlotante(el: HTMLElement, target: Rect, align: 'center' | 'left' = 'center'): void {
  const lr = lienzo.getBoundingClientRect()
  const tx = target.left + lr.left, ty = target.top + lr.top
  const bw = el.offsetWidth, bh = el.offsetHeight
  const W = window.innerWidth, H = window.innerHeight
  // 'left': el borde izq de la barra arranca en el del elemento (queda "pegada"
  // al inicio del texto, como Canva). 'center': centrada sobre el elemento.
  let left = align === 'left' ? tx : tx + target.width / 2 - bw / 2
  // Preferimos ARRIBA del elemento; si no entra, DEBAJO (no tapar el contenido);
  // si tampoco, pegada al borde superior.
  let top = ty - bh - 10
  if (top < 4) {
    const abajo = ty + target.height + 10
    top = abajo + bh <= H - 4 ? abajo : Math.max(4, Math.min(ty + 6, H - bh - 4))
  }
  left = Math.max(4, Math.min(left, W - bw - 4))
  // Guardamos la posición AUTOMÁTICA para medir el offset manual del arrastre.
  el.dataset.autoLeft = String(Math.round(left))
  el.dataset.autoTop = String(Math.round(top))
  let fl = left + barraOffset.dx, ft = top + barraOffset.dy
  fl = Math.max(4, Math.min(fl, W - bw - 4))
  ft = Math.max(4, Math.min(ft, H - bh - 4))
  el.style.left = Math.round(fl) + 'px'
  el.style.top = Math.round(ft) + 'px'
}

// Arranca el arrastre de la barra flotante desde su manija (grip).
function iniciarArrastreBarra(tools: HTMLElement, e: PointerEvent): void {
  const startX = e.clientX, startY = e.clientY
  const baseLeft = parseFloat(tools.style.left) || 0
  const baseTop = parseFloat(tools.style.top) || 0
  const autoLeft = parseFloat(tools.dataset.autoLeft || '0')
  const autoTop = parseFloat(tools.dataset.autoTop || '0')
  const onMove = (ev: PointerEvent) => {
    const W = window.innerWidth, H = window.innerHeight
    const bw = tools.offsetWidth, bh = tools.offsetHeight
    let nl = baseLeft + (ev.clientX - startX)
    let nt = baseTop + (ev.clientY - startY)
    nl = Math.max(4, Math.min(nl, W - bw - 4))
    nt = Math.max(4, Math.min(nt, H - bh - 4))
    tools.style.left = Math.round(nl) + 'px'
    tools.style.top = Math.round(nt) + 'px'
    barraOffset = { dx: nl - autoLeft, dy: nt - autoTop }
  }
  const onUp = () => {
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
  }
  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onUp)
}

function dibujarSelGraf(): void {
  limpiarGraf()
  if (!grafSeleccion.length || !svgEl) return
  // Al cambiar de elemento seleccionado, la barra vuelve a su posición automática.
  const firma = grafSeleccion[0] ?? null
  if (firma !== barraSelFirma) { barraOffset = { dx: 0, dy: 0 }; barraSelFirma = firma }
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
  tools.className = 'graf-tools' // se anexa al panel de propiedades (no flota)
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

  // Grosor del contorno/trazo (en unidades del lienzo).
  const grosor = document.createElement('label'); grosor.className = 'graf-grosor'; grosor.title = 'Grosor del contorno/trazo'
  const gwi = document.createElement('input'); gwi.type = 'number'; gwi.min = '0'; gwi.max = '400'; gwi.step = '1'
  const sw0 = parseFloat(getComputedStyle(grafSeleccion[0]).strokeWidth)
  gwi.value = String(isNaN(sw0) ? 0 : Math.round(sw0))
  gwi.addEventListener('input', () => { for (const el of grafSeleccion) el.style.strokeWidth = gwi.value })
  gwi.addEventListener('change', () => { registrarHistorial(); autoguardar() })
  gwi.addEventListener('pointerdown', (e) => e.stopPropagation())
  grosor.append('〜', gwi)
  tools.append(grosor)

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
  const grad = document.createElement('button'); grad.className = 'graf-btn'; grad.textContent = 'Degradado'; grad.title = 'Degradado de relleno'
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

  // Imagen agregada: editar / quitar fondo / máscara (tools ricas dentro de la selección).
  if (!multi && grafSeleccion[0].tagName.toLowerCase() === 'image' && grafSeleccion[0].getAttribute('data-agregado') === 'imagen') {
    const im = grafSeleccion[0]
    const getHref = () => im.getAttribute('href') || im.getAttributeNS(XLINK, 'href') || ''
    const setFoto = (f: Foto) => {
      im.setAttribute('href', f.dataUrl); im.setAttributeNS(XLINK, 'xlink:href', f.dataUrl)
      const W = parseFloat(im.getAttribute('width') || '0')
      if (W) im.setAttribute('height', String(W * f.h / f.w))
      registrarHistorial(); autoguardar(); dibujarSelGraf()
    }
    const rep = document.createElement('button'); rep.className = 'graf-btn'; rep.textContent = '🔁 Reemplazar'; rep.title = 'Reemplazar por otra imagen (subir o del banco) manteniendo tamaño, recorte y opacidad'
    rep.addEventListener('click', (e) => { e.stopPropagation(); abrirPanelImagen(); reemplazarDestino = im as unknown as SVGImageElement })
    const ed = document.createElement('button'); ed.className = 'graf-btn destacado'; ed.textContent = '✎ Editar imagen'; ed.title = 'Editar la imagen (color, borrador, filtros, recorte…)'
    ed.addEventListener('click', (e) => { e.stopPropagation(); abrirEditorImagen(getHref(), setFoto) })
    const qf = document.createElement('button'); qf.className = 'graf-btn'; qf.textContent = 'Quitar fondo'; qf.title = 'Quitar el fondo de la imagen (IA, en tu navegador)'
    qf.addEventListener('click', (e) => { e.stopPropagation(); void ejecutarQuitarFondo(getHref(), setFoto, qf) })
    const mw = document.createElement('div'); mw.className = 'graf-mascara'
    const mb = document.createElement('button'); mb.className = 'graf-btn'; mb.textContent = '✂ Máscara'; mb.title = 'Recortar la imagen con una forma'
    const mp = document.createElement('div'); mp.className = 'menu-pop mascara-pop'; mp.hidden = true
    for (const [tipo, label] of [['ninguna', '⊘'], ['circulo', '●'], ['elipse', '⬭'], ['redondeado', '▢'], ['triangulo', '▲'], ['hexagono', '⬡'], ['estrella', '★']] as [string, string][]) {
      const b = document.createElement('button'); b.textContent = label; b.title = tipo
      b.addEventListener('click', (e) => { e.stopPropagation(); aplicarMascara(im, tipo); mp.hidden = true; dibujarSelGraf() })
      mp.appendChild(b)
    }
    mb.addEventListener('click', (e) => { e.stopPropagation(); mp.hidden = !mp.hidden })
    mw.append(mb, mp)
    tools.append(rep, qf, mw)
    tools.prepend(ed) // "Editar imagen" destacado, arriba de todo
  }

  // Secundarios (capas, alinear, buscatrazos) en un menú "Más" para no saturar.
  const mas = document.createElement('button'); mas.className = 'graf-btn'; mas.textContent = '↕ Ordenar'; mas.title = 'Capas, alinear, buscatrazos'
  const masCont = construirOrdenarCont(); masCont.hidden = true
  mas.addEventListener('click', (e) => { e.stopPropagation(); masCont.hidden = !masCont.hidden })
  tools.appendChild(mas); tools.appendChild(masCont)

  const del = document.createElement('button'); del.className = 'graf-del'; del.textContent = '🗑'; del.title = 'Eliminar'
  del.addEventListener('click', (e) => { e.stopPropagation(); borrarGraf() })
  tools.appendChild(del)
  // Manija para mover la barra (queda primera, aunque otros botones hagan prepend).
  const grip = document.createElement('button'); grip.className = 'graf-grip'; grip.textContent = '⠿'
  grip.title = 'Arrastrá para mover esta barra'
  grip.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); iniciarArrastreBarra(tools, e) })
  grip.addEventListener('click', (e) => e.stopPropagation())
  tools.prepend(grip)
  // Los controles FLOTAN en una barra (fixed, en <body>) para poder moverse
  // libres por toda la pantalla, fuera de la mesa de trabajo.
  document.body.appendChild(tools); posicionarFlotante(tools, uni)

  if (!multi) {
    // 8 tiradores: 4 esquinas (proporcional) + 4 lados (un eje).
    for (const dir of DIRS_TIRADOR) lienzo.appendChild(crearTiradorEscalaGraf(uni, dir))
    // ✕ para eliminar, arriba a la derecha de la caja (por encima del tirador ne).
    const xDel = crearBotonEliminar(uni, () => borrarGraf())
    xDel.style.top = uni.top - 26 + 'px'
    lienzo.appendChild(xDel)
  }
}

// Las 8 direcciones de tiradores (esquinas + lados).
const DIRS_TIRADOR: DirTirador[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

// Tirador de escala para la selección de modo Gráficos: escala el WRAPPER del
// elemento (preserva matrices de Illustrator). Delega en crearTiradorEscala.
function crearTiradorEscalaGraf(r: Rect, dir: DirTirador = 'se'): HTMLDivElement {
  return crearTiradorEscala(r, grafSeleccion[0], dir, {
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
// Direcciones de tirador: 8 (4 esquinas + 4 lados). Aliases viejos: x=e, y=s, xy=se.
type DirTirador = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'x' | 'y' | 'xy'
function crearTiradorEscala(
  r: Rect, el: SVGElement, dir: DirTirador = 'se',
  opts?: { wrap?: boolean; onFin?: () => void },
): HTMLDivElement {
  const d = dir === 'x' ? 'e' : dir === 'y' ? 's' : dir === 'xy' ? 'se' : dir
  const hc = d.includes('e') ? 1 : d.includes('w') ? -1 : 0 // horizontal: -1 izq, +1 der
  const vc = d.includes('s') ? 1 : d.includes('n') ? -1 : 0 // vertical: -1 arriba, +1 abajo
  const h = document.createElement('div')
  h.className = 'resize-handle resize-handle-' + d
  const left = r.left + (hc < 0 ? 0 : hc > 0 ? r.width : r.width / 2) - 7
  const top = r.top + (vc < 0 ? 0 : vc > 0 ? r.height : r.height / 2) - 7
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
    let bw = 100, bh = 100, bx = 0, by = 0
    try { const bb = (target as SVGGraphicsElement).getBBox(); bw = bb.width || 100; bh = bb.height || 100; bx = bb.x; by = bb.y } catch { /* default */ }
    // Ancla = lado/esquina OPUESTO al tirador (queda fijo al escalar).
    const aBx = hc > 0 ? bx : bx + bw, aBy = vc > 0 ? by : by + bh
    const anchorWX = cx0 + sx0 * aBx, anchorWY = cy0 + sy0 * aBy
    const lienzoBox = lienzo.getBoundingClientRect()
    const startX = e.clientX, startY = e.clientY
    const onMove = (ev: PointerEvent) => {
      let sx = sx0, sy = sy0
      if (hc !== 0) sx = Math.max(0.04, sx0 + hc * (ev.clientX - startX) / k / bw)
      if (vc !== 0) sy = Math.max(0.04, sy0 + vc * (ev.clientY - startY) / k / bh)
      // Esquina o Shift = proporcional (la dirige el eje que cambia).
      if ((hc !== 0 && vc !== 0) || ev.shiftKey) {
        if (hc !== 0) sy = Math.max(0.04, sx * (sy0 / sx0 || 1))
        else if (vc !== 0) sx = Math.max(0.04, sy * (sx0 / sy0 || 1))
      }
      const cx = hc !== 0 ? anchorWX - sx * aBx : cx0
      const cy = vc !== 0 ? anchorWY - sy * aBy : cy0
      target.setAttribute('transform', `translate(${cx.toFixed(2)} ${cy.toFixed(2)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)})`)
      // El tirador sigue a su lado/esquina del nuevo bbox.
      const bb2 = el.getBoundingClientRect()
      h.style.left = (bb2.left - lienzoBox.left) + (hc < 0 ? 0 : hc > 0 ? bb2.width : bb2.width / 2) - 7 + 'px'
      h.style.top = (bb2.top - lienzoBox.top) + (vc < 0 ? 0 : vc > 0 ? bb2.height : bb2.height / 2) - 7 + 'px'
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
// Junta textos (cajas) + cualquier unidad graf (vectores, figuras, imágenes…),
// excluyendo lo que se está arrastrando (por nombre, por elemento o por set).
function rectsDeElementos(base: DOMRect): Rect[] {
  if (!svgEl) return []
  const out: Rect[] = []
  for (const c of camposActuales) {
    if (c.nombre === snapExcluir) continue
    const r = cajaScreen(c.nombre, base) ?? rectUnion(svgEl.querySelectorAll(`[data-campo="${c.nombre}"]`), base)
    if (r) out.push(r)
  }
  const vistos = new Set<SVGElement>()
  for (const leaf of Array.from(svgEl.querySelectorAll<SVGElement>(SEL_GRAF))) {
    const u = graficoSeleccionable(leaf)
    if (!u || vistos.has(u)) continue
    vistos.add(u)
    if (u.getAttribute('data-campo')) continue // textos ya cubiertos arriba
    if (u === excluirImg || snapExcluirSet?.has(u)) continue
    const r = rectUnion([u], base)
    if (r) out.push(r)
  }
  return out
}
let excluirImg: Element | null = null // imagen que se está arrastrando (no imantar consigo)
let snapExcluirSet: Set<SVGElement> | null = null // selección graf en arrastre (no imantar consigo)

interface Guia { tipo: 'v' | 'h'; pos: number }

// Calcula el ajuste (dx,dy en px) para imantar el box a centro/bordes de la
// placa y a otros elementos, y qué guías mostrar.
function calcularSnap(box: Rect, base: DOMRect): { dx: number; dy: number; guias: Guia[] } {
  const W = lienzo.clientWidth, H = lienzo.clientHeight
  const vT = [0, W / 2, W]
  const hT = [0, H / 2, H]
  for (const r of rectsDeElementos(base)) {
    vT.push(r.left, r.left + r.width / 2, r.left + r.width)
    hT.push(r.top, r.top + r.height / 2, r.top + r.height)
  }
  // Guías fijas (en unidades de la placa → px del lienzo).
  if (svgEl) {
    const kg = W / (svgEl.viewBox.baseVal.width || 1080)
    const kh = H / (svgEl.viewBox.baseVal.height || 1350)
    for (const x of guiasFijas.v) vT.push(x * kg)
    for (const y of guiasFijas.h) hT.push(y * kh)
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

// ============ Reglas y guías fijas ============
// Reglas (arriba/izquierda) en unidades de la placa + guías arrastrables que el
// usuario coloca y a las que los elementos imantan. Las guías se guardan por mesa
// (en unidades del viewBox). Las reglas son una preferencia global de la vista.
let mostrarReglas = false
let guiasFijas: { v: number[]; h: number[] } = { v: [], h: [] }
// Carrusel: cantidad de slides de la mesa activa (0 = no es carrusel). Es ancho =
// slideW × slides; al exportar se corta en una imagen por slide.
let carruselSlides = 0
// Los tiradores para redimensionar la mesa solo aparecen tras clic en la regla de
// medidas (evita redimensionados accidentales). Se apaga al cambiar de mesa.
let mesaResizeActivo = false
const ANCHO_REGLA = 18

// Paso "lindo" (1/2/5 ×10ⁿ) ≥ al mínimo dado, para los rótulos de la regla.
function pasoNice(min: number): number {
  if (min <= 0) return 1
  const base = Math.pow(10, Math.floor(Math.log10(min)))
  for (const m of [1, 2, 5, 10]) if (m * base >= min) return m * base
  return 10 * base
}

function dibujarReglas(): void {
  let top = lienzo.querySelector<HTMLCanvasElement>('.regla-top')
  let left = lienzo.querySelector<HTMLCanvasElement>('.regla-left')
  let corner = lienzo.querySelector<HTMLDivElement>('.regla-corner')
  if (!mostrarReglas || !svgEl) { top?.remove(); left?.remove(); corner?.remove(); return }
  const vb = svgEl.viewBox.baseVal
  const vbW = vb.width || 1080, vbH = vb.height || 1350
  const W = lienzo.clientWidth, H = svgEl.clientHeight
  const k = W / vbW
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const crear = (cls: string, horizontal: boolean): HTMLCanvasElement => {
    const c = document.createElement('canvas'); c.className = cls
    c.addEventListener('pointerdown', (e) => nuevaGuiaDesdeRegla(e, horizontal))
    lienzo.appendChild(c); return c
  }
  if (!top) top = crear('regla-top', true) // regla superior → guías horizontales (tirar hacia abajo)
  if (!left) left = crear('regla-left', false) // regla izquierda → guías verticales (tirar a la derecha)
  if (!corner) { corner = document.createElement('div'); corner.className = 'regla-corner'; lienzo.appendChild(corner) }
  Object.assign(top.style, { left: '0', top: -ANCHO_REGLA + 'px', width: W + 'px', height: ANCHO_REGLA + 'px' })
  Object.assign(left.style, { left: -ANCHO_REGLA + 'px', top: '0', width: ANCHO_REGLA + 'px', height: H + 'px' })
  Object.assign(corner.style, { left: -ANCHO_REGLA + 'px', top: -ANCHO_REGLA + 'px', width: ANCHO_REGLA + 'px', height: ANCHO_REGLA + 'px' })
  const paso = pasoNice(60 / k) // ≥60px entre rótulos
  pintarRegla(top, true, W, vbW, k, paso, dpr)
  pintarRegla(left, false, H, vbH, k, paso, dpr)
}

function pintarRegla(cv: HTMLCanvasElement, horizontal: boolean, lenPx: number, lenU: number, k: number, paso: number, dpr: number): void {
  const g = ANCHO_REGLA
  cv.width = Math.max(1, Math.round((horizontal ? lenPx : g) * dpr))
  cv.height = Math.max(1, Math.round((horizontal ? g : lenPx) * dpr))
  const ctx = cv.getContext('2d'); if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const w = horizontal ? lenPx : g, h = horizontal ? g : lenPx
  ctx.fillStyle = '#3a3f47'; ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = '#878d96'; ctx.fillStyle = '#c2c8d0'; ctx.lineWidth = 1; ctx.font = '9px system-ui, sans-serif'
  const menor = paso / 5
  for (let u = 0; u <= lenU + 0.001; u += menor) {
    const px = Math.round(u * k) + 0.5
    const major = Math.abs(((u / paso) % 1)) < 1e-6 || Math.abs(((u / paso) % 1) - 1) < 1e-6
    const largo = major ? g * 0.8 : g * 0.4
    ctx.beginPath()
    if (horizontal) { ctx.moveTo(px, g); ctx.lineTo(px, g - largo) } else { ctx.moveTo(g, px); ctx.lineTo(g - largo, px) }
    ctx.stroke()
    if (major && u > 0.001) {
      const lbl = String(Math.round(u))
      if (horizontal) { ctx.textBaseline = 'top'; ctx.fillText(lbl, u * k + 2, 1) }
      else { ctx.save(); ctx.translate(11, u * k - 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'top'; ctx.fillText(lbl, 0, 0); ctx.restore() }
    }
  }
}

function dibujarGuiasFijas(): void {
  lienzo.querySelectorAll('.guia-fija').forEach((n) => n.remove())
  if (!svgEl) return
  const vb = svgEl.viewBox.baseVal
  const W = lienzo.clientWidth, H = svgEl.clientHeight
  const kg = W / (vb.width || 1080), kh = H / (vb.height || 1350)
  const crear = (horizontal: boolean, idx: number, posU: number) => {
    const d = document.createElement('div')
    d.className = 'guia-fija ' + (horizontal ? 'guia-fija-h' : 'guia-fija-v')
    if (horizontal) Object.assign(d.style, { top: posU * kh + 'px', left: '0', width: W + 'px' })
    else Object.assign(d.style, { left: posU * kg + 'px', top: '0', height: H + 'px' })
    d.addEventListener('pointerdown', (e) => arrastrarGuiaFija(e, horizontal, idx))
    d.addEventListener('dblclick', (e) => { e.stopPropagation(); (horizontal ? guiasFijas.h : guiasFijas.v).splice(idx, 1); dibujarGuiasFijas(); registrarHistorial(); autoguardar() })
    lienzo.appendChild(d)
  }
  guiasFijas.v.forEach((x, i) => crear(false, i, x))
  guiasFijas.h.forEach((y, i) => crear(true, i, y))
}

// Guías de carrusel: líneas verticales (no arrastrables) en cada límite de slide,
// con el número de slide. Solo visuales: no se exportan.
function dibujarGuiasCarrusel(): void {
  lienzo.querySelectorAll('.guia-carrusel, .slide-num').forEach((n) => n.remove())
  if (!svgEl || carruselSlides < 2) return
  const vb = svgEl.viewBox.baseVal
  const W = lienzo.clientWidth, H = svgEl.clientHeight
  const kg = W / (vb.width || 1080)
  const sliceWv = (vb.width || 1080) / carruselSlides
  for (let i = 1; i < carruselSlides; i++) {
    const d = document.createElement('div'); d.className = 'guia-carrusel'
    Object.assign(d.style, { left: sliceWv * i * kg + 'px', top: '0', height: H + 'px' })
    lienzo.appendChild(d)
  }
  for (let i = 0; i < carruselSlides; i++) {
    const t = document.createElement('div'); t.className = 'slide-num'
    t.textContent = String(i + 1)
    t.style.left = (sliceWv * i + sliceWv / 2) * kg + 'px'
    lienzo.appendChild(t)
  }
}

// Coord. de usuario (unidad de la placa) bajo el puntero, en el eje de la guía.
function unidadGuia(ev: PointerEvent, horizontal: boolean): number {
  const base = lienzo.getBoundingClientRect()
  const vb = svgEl!.viewBox.baseVal
  if (horizontal) return (ev.clientY - base.top) / (svgEl!.clientHeight / (vb.height || 1350))
  return (ev.clientX - base.left) / (lienzo.clientWidth / (vb.width || 1080))
}

// Arrastra una guía desde la regla (crear) o una ya puesta (mover/quitar).
function arrastrarGuiaComun(arr: number[], idx: number, horizontal: boolean): void {
  const lim = horizontal ? (svgEl!.viewBox.baseVal.height || 1350) : (svgEl!.viewBox.baseVal.width || 1080)
  const onMove = (ev: PointerEvent) => { arr[idx] = unidadGuia(ev, horizontal); dibujarGuiasFijas() }
  const onUp = (ev: PointerEvent) => {
    document.removeEventListener('pointermove', onMove)
    const u = unidadGuia(ev, horizontal)
    if (u < 0 || u > lim) arr.splice(idx, 1) // soltada fuera de la placa → quitar
    else arr[idx] = Math.round(u)
    dibujarGuiasFijas(); registrarHistorial(); autoguardar()
  }
  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onUp, { once: true })
}
function arrastrarGuiaFija(e: PointerEvent, horizontal: boolean, idx: number): void {
  e.preventDefault(); e.stopPropagation()
  if (!svgEl) return
  arrastrarGuiaComun(horizontal ? guiasFijas.h : guiasFijas.v, idx, horizontal)
}
function nuevaGuiaDesdeRegla(e: PointerEvent, horizontal: boolean): void {
  e.preventDefault()
  if (!svgEl) return
  const arr = horizontal ? guiasFijas.h : guiasFijas.v
  arr.push(Math.max(0, unidadGuia(e, horizontal)))
  dibujarGuiasFijas()
  arrastrarGuiaComun(arr, arr.length - 1, horizontal)
}
function toggleReglas(): void {
  mostrarReglas = !mostrarReglas
  document.querySelector('#btn-reglas')?.classList.toggle('activo', mostrarReglas)
  dibujarReglas(); dibujarGuiasFijas()
}

function construirOverlays(): void {
  if (!svgEl) return
  lienzo.querySelectorAll('.hit, .btn-eliminar, .btn-quitarfondo, .resize-handle, .btn-candado, .resize-ancho, .resize-caja, .guia, .swatch-figura, .mascara-wrap, .mask-handle, .mesa-size-handle, .mesa-medidas').forEach((n) => n.remove())
  document.querySelectorAll('.foto-tools').forEach((n) => n.remove()) // foto-tools flotan en <body>
  zoomSlider = null
  dibujarReglas(); dibujarGuiasFijas(); dibujarGuiasCarrusel() // se redibujan al cambiar zoom/modo/contenido
  // Marco de la mesa SIEMPRE visible (para ver el límite aunque un elemento lo
  // sobrepase). Se recrea acá porque aplicarSnapshot reemplaza el HTML del lienzo.
  if (!lienzo.querySelector('.mesa-marco')) {
    const m = document.createElement('div'); m.className = 'mesa-marco'; m.setAttribute('aria-hidden', 'true')
    lienzo.appendChild(m)
  }
  // Regla de medidas: chip clickeable abajo de la mesa que muestra el tamaño y
  // ACTIVA los tiradores (así no se redimensiona sin querer). Solo en completa.
  if (modoEdicion === 'completa' && svgEl) {
    const vbR = svgEl.viewBox.baseVal
    const medidas = document.createElement('button')
    medidas.className = 'mesa-medidas' + (mesaResizeActivo ? ' activo' : '')
    medidas.textContent = `${Math.round(vbR.width)} × ${Math.round(vbR.height)} px`
    medidas.title = mesaResizeActivo ? 'Clic: ocultar tiradores' : 'Clic: mostrar tiradores para redimensionar'
    medidas.addEventListener('click', (ev) => { ev.stopPropagation(); mesaResizeActivo = !mesaResizeActivo; construirOverlays() })
    lienzo.appendChild(medidas)
    // Tiradores: borde derecho (ancho), borde inferior (alto), esquina (ambos).
    if (mesaResizeActivo) {
      for (const modo of ['e', 's', 'se'] as const) {
        const hdl = document.createElement('div')
        hdl.className = 'mesa-size-handle mesa-size-' + modo
        hdl.title = 'Arrastrar para cambiar el tamaño de la mesa'
        hdl.addEventListener('pointerdown', (ev) => arrastrarTamanoMesa(ev, modo))
        lienzo.appendChild(hdl)
      }
    }
  }
  const base = lienzo.getBoundingClientRect()
  // 'plantilla' = restringido (texto + foto). 'completa' = todo: el texto, las
  // fotos (solo la mini-barra; los vectores se seleccionan por la capa del svg) y
  // NADA de overlays de elementos agregados (esos van por la selección de vectores).
  const enPlantilla = modoEdicion === 'plantilla'
  const completa = modoEdicion === 'completa'

  // Fotos primero (quedan DEBAJO de los textos). Una por cada hueco de la plantilla.
  for (const img of Array.from(svgEl.querySelectorAll('[data-foto]'))) {
    const id = img.getAttribute('data-foto')!
    // Foto YA recortada: un hit la hace clickeable → al tocarla se SELECCIONA y el
    // panel muestra sus controles (Reencuadrar / Quitar recorte + tiradores de
    // tamaño); arrastrar el hit la mueve. Antes se saltaba en ambos modos (quedó
    // así al fusionar normal/Gráficos) → no se podía agrandar/mover el recorte.
    const rec = img.closest('[data-recorte]') as SVGElement | null
    if (rec) {
      const rr = rectUnion([rec], base)
      if (!rr) continue
      const hit = crearHit(rr, 'recorte', () => { grafSeleccion = [rec]; dibujarSelGraf() })
      hit.classList.add('hit-agregado')
      hit.title = 'Tocá para editar el recorte (mover, cambiar tamaño, reencuadrar)'
      habilitarArrastreEl(hit, rec)
      lienzo.appendChild(hit)
      continue
    }
    const r = rectFotoVisible(img, base)
    if (!r) continue
    // En completa la foto se clickea (grafPointerDown) → se selecciona y sus
    // controles van al PANEL. Sin hit a sangre, así los vectores sobre la foto
    // se pueden seleccionar.
    if (completa) continue
    const tieneFoto = !!fotos[id]
    const hit = crearHit(r, 'foto', () => { if (!fotos[id]) { fotoActiva = id; inFoto.click() } })
    hit.classList.add('hit-foto')
    hit.title = tieneFoto ? 'Tocá para editar · arrastrá para encuadrar' : 'Subir foto'
    lienzo.appendChild(hit)
    if (tieneFoto && framesFoto[id]) habilitarPanZoom(hit, id)
  }

  for (const c of camposActuales) {
    const el = svgEl.querySelector(`[data-campo="${c.nombre}"][data-anchor]`)
    const agregado = el?.getAttribute('data-agregado') === 'texto'
    const libre = !enPlantilla && !bloqueado[c.nombre] // desbloqueado → movible/redimensionable
    let r = rectUnion(svgEl.querySelectorAll(`[data-campo="${c.nombre}"]`), base)
    if (!r || r.height < 10) r = rectsIniciales[c.nombre] ?? r
    if (!r) continue
    // Caja del texto desbloqueado: salvo que el usuario la haya redimensionado a
    // mano, la AJUSTAMOS al texto en cada rebuild (si no, al cambiar tamaño/preset
    // el recuadro quedaba con el alto viejo y no coincidía con la tipografía).
    if (libre && !cajaManual[c.nombre]) {
      const bb = bboxCampoUser(c.nombre)
      if (bb) cajaAlto[c.nombre] = bb.h + 6
    }
    const rCaja = libre ? (cajaScreen(c.nombre, base) ?? r) : r

    const hit = crearHit(rCaja, c.nombre, () => abrirEditor(c.nombre))
    hit.title = enPlantilla ? `Clic para cambiar el texto: ${c.nombre}` : libre ? 'Arrastrá para mover · clic para editar' : `Editar: ${c.nombre}`
    lienzo.appendChild(hit)
    // En plantilla: solo el hit para editar el texto (sin candado/tiradores/eliminar).
    const ctrls: HTMLElement[] = enPlantilla ? [] : [crearBotonCandado(rCaja, c.nombre)]
    if (libre) {
      hit.classList.add('hit-agregado')
      habilitarArrastreTexto(hit, c.nombre)
      ctrls.push(
        crearTiradorCaja(rCaja, c.nombre, 'x'),
        crearTiradorCaja(rCaja, c.nombre, 'y'),
        crearTiradorCaja(rCaja, c.nombre, 'xy'),
      )
    }
    if (agregado && !enPlantilla) ctrls.push(crearBotonEliminar(rCaja, () => eliminarCampo(c.nombre)))
    for (const c2 of ctrls) lienzo.appendChild(c2)
    revelarAlHover(hit, ctrls)
  }

  // Imágenes agregadas (movibles, redimensionables, eliminables).
  // En completa van por la capa de selección de vectores, no por overlays HTML.
  if (!enPlantilla && !completa) for (const im of Array.from(svgEl.querySelectorAll<SVGElement>('image[data-agregado="imagen"]'))) {
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
      crearBotonEditarImg(r, () => abrirEditorImagen(im.getAttribute('href') || im.getAttributeNS(XLINK, 'href') || '', (foto) => {
        im.setAttribute('href', foto.dataUrl); im.setAttributeNS(XLINK, 'xlink:href', foto.dataUrl)
        // Si cambió el aspecto (recorte/rotación), mantener el ancho y ajustar el alto.
        const W = parseFloat(im.getAttribute('width') || '0')
        if (W) im.setAttribute('height', String(W * foto.h / foto.w))
      })),
      ...handlesMascara(im, base),
    ]
    for (const c of ctrls) lienzo.appendChild(c)
    revelarAlHover(hit, ctrls)
  }

  // Figuras e íconos agregados (mover, escalar, color, eliminar).
  if (!enPlantilla && !completa) for (const el of Array.from(svgEl.querySelectorAll<SVGElement>('[data-agregado="figura"], [data-agregado="icono"]'))) {
    const r = rectUnion([el], base)
    if (!r) continue
    const hit = crearHit(r, 'figura', () => {})
    hit.classList.add('hit-agregado')
    hit.title = 'Arrastrá para mover'
    habilitarArrastreEl(hit, el)
    lienzo.appendChild(hit)
    const ctrls = [
      crearBotonEliminar(r, () => { el.remove(); construirOverlays() }),
      ...DIRS_TIRADOR.map((dir) => crearTiradorEscala(r, el, dir)), // 4 esquinas + 4 lados
      crearSwatch(r, el, 'fill', 0),
      crearSwatch(r, el, 'stroke', 1),
    ]
    for (const c of ctrls) lienzo.appendChild(c)
    revelarAlHover(hit, ctrls)
  }
  // Barras flotantes de las fotos de la plantilla (se borraron arriba; rebuild al
  // final para que sobrevivan al clear y queden bien posicionadas tras el zoom).
  if (!grafSeleccion.length) actualizarPanelProps()
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

// Botón "Editar" de una imagen (abre el editor de imágenes). Debajo de "Quitar
// fondo", misma columna izquierda.
function crearBotonEditarImg(r: Rect, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'btn-quitarfondo btn-editarimg'
  b.textContent = '✎ Editar'
  b.title = 'Editar la imagen (borrador mágico, ajustes, filtros, recorte…)'
  Object.assign(b.style, { left: r.left - 2 + 'px', top: r.top + r.height + 28 + 'px' })
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick() })
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
      if (eje !== 'x') { cajaAlto[nombre] = Math.max(20, (cajaAlto[nombre] ?? 0) + dys / k); cajaManual[nombre] = true }
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
// Reencuadre por arrastre de una foto desde la capa de selección (modo completa),
// cuando se hace pointerdown sobre el hueco directamente (sin un vector encima).
function iniciarPanFoto(e: PointerEvent, id: string): void {
  const foto = fotos[id], fr = framesFoto[id]
  if (!foto || !fr || !svgEl) return
  e.preventDefault()
  try { svgEl.setPointerCapture(e.pointerId) } catch { /* igual arrastra */ }
  const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
  const enc = encuadreDe(id)
  let sx = e.clientX, sy = e.clientY
  const onMove = (ev: PointerEvent) => {
    enc.ox += (ev.clientX - sx) / k; enc.oy += (ev.clientY - sy) / k
    sx = ev.clientX; sy = ev.clientY
    const c = aplicarFotoDom(svgEl!, id, foto, fr, enc); enc.ox = c.ox; enc.oy = c.oy
  }
  const onUp = () => { svgEl!.removeEventListener('pointermove', onMove); registrarHistorial(); autoguardar() }
  svgEl.addEventListener('pointermove', onMove)
  svgEl.addEventListener('pointerup', onUp, { once: true })
  svgEl.addEventListener('pointercancel', onUp, { once: true })
}

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
function construirFotoTools(id: string): void {
  if (!svgEl) return
  const enc = encuadreDe(id)
  const tools = document.createElement('div')
  tools.className = 'foto-tools' // flota encima del hueco de foto
  tools.addEventListener('pointerdown', (e) => e.stopPropagation())
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
  // "Editar" y "Quitar fondo" son edición destructiva → solo en Modo completa.
  if (fotos[id] && modoEdicion !== 'plantilla') {
    const reaplicar = (foto: Foto) => {
      fotos[id] = foto
      const fr = framesFoto[id], enc = encuadreDe(id)
      if (fr && svgEl) { const c = aplicarFotoDom(svgEl, id, foto, fr, enc); enc.ox = c.ox; enc.oy = c.oy }
    }
    const ed = document.createElement('button')
    ed.className = 'mini ft-fondo'; ed.textContent = '✎ Editar'
    ed.title = 'Editar la foto (borrador mágico, ajustes, filtros, recorte…)'
    ed.addEventListener('click', () => abrirEditorImagen(fotos[id].dataUrl, reaplicar))
    tools.appendChild(ed)
    const qf = document.createElement('button')
    qf.className = 'mini ft-fondo'; qf.textContent = 'Quitar fondo'
    qf.title = 'Quitar el fondo de la foto (IA, corre en tu navegador)'
    qf.addEventListener('click', () => void ejecutarQuitarFondo(fotos[id].dataUrl, reaplicar, qf))
    tools.appendChild(qf)
  }
  document.body.appendChild(tools) // flota libre (fixed), como la barra de selección
  // Posicionar la barra encima del marco visible del hueco.
  const base = lienzo.getBoundingClientRect()
  let rect = imgFoto ? rectFotoVisible(imgFoto, base) : null
  if (!rect && imgFoto) { const rb = imgFoto.getBoundingClientRect(); rect = { left: rb.left - base.left, top: rb.top - base.top, width: rb.width, height: rb.height } }
  if (rect) posicionarFlotante(tools, rect)
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
  // data-corrido (p.ej. párrafos importados de un PDF) = texto que fluye: las
  // líneas se unen con espacio para que al editar reacomode solo según el ancho.
  const corrido = Array.from(nodos).some((n) => (n as Element).getAttribute?.('data-corrido') != null)
  return lineasDeNodos(nodos).join(corrido ? ' ' : '\n').replace(/\s+$/g, '')
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
  // Línea base de la 1.ª línea del render (ancla fija) ANTES de ocultar el texto.
  const anchorEl = (els.find((e) => (e as Element).hasAttribute('data-anchor')) ?? els[0]) as SVGElement | undefined
  const baseBaseline = anchorEl ? baselineCampoScreenY(anchorEl, base) : null
  for (const el of els) (el as SVGElement).style.opacity = '0'

  const ta = document.createElement('textarea')
  ta.className = 'editor-text'
  ta.value = valorPrevio
  ta.spellcheck = false
  ta.style.left = r.left + 'px'
  ta.style.top = r.top - 1 + 'px'
  ta.dataset.baseTop = String(r.top - 1) // top sin compensar; aplicarEstiloTextarea ajusta por interlineado
  if (baseBaseline != null) ta.dataset.baseBaseline = String(baseBaseline) // ancla por baseline (preciso)
  // +4px de holgura: maxWidthUser es el ancho EXACTO del texto (sin margen), y el
  // textarea (layout del navegador) redondea distinto que la medición SVG → sin
  // holgura, la última letra se cae a otra línea.
  ta.style.width = Math.max(m.maxWidthUser * k + 4, 60) + 'px'
  ta.style.color = m.color
  ta.style.caretColor = m.color
  lienzo.appendChild(ta)
  aplicarEstiloTextarea(nombre) // tamaño/peso/cursiva/familia/alineación (recorta el textarea si la caja es manual)
  ta.focus()
  ta.setSelectionRange(ta.value.length, ta.value.length)

  editorActivo = { nombre, ta, valorPrevio, tocado: false, els }
  sincronizarBarra(nombre)
  // La barra de formato flota encima del texto en edición (fixed, en <body>),
  // alineada al inicio del texto (no centrada en una caja ancha → no "corrida").
  document.body.appendChild(barraTexto)
  posicionarFlotante(barraTexto, r, 'left')
  ta.addEventListener('input', () => {
    editorActivo!.tocado = true
    valores[nombre] = ta.value
    aplicarEstiloTextarea(nombre) // recalcular shrink en vivo (envuelve como el render)
  })
  ta.addEventListener('blur', (e) => {
    // Si el foco va a la barra de controles (ej. el selector de fuente),
    // NO cerramos el editor: queremos seguir editando ese campo.
    const rt = e.relatedTarget as HTMLElement | null
    if (rt && (barraTexto.contains(rt) || rt.closest('#panel-lateral'))) return
    commitEditor()
  })
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelarEditor() }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur() }
  })
}

// Contexto de canvas reutilizable para medir métricas de fuente.
const ctxMedir = document.createElement('canvas').getContext('2d')

// Ascenso/descenso de la caja de fuente (px) para un estilo dado. Es lo que el
// navegador usa para repartir el interlineado de una línea; permite alinear el
// textarea por LÍNEA BASE con el render SVG (el modelo de medio interlineado
// dejaba ~3px de error que variaban según la fuente).
function metricasFuenteTA(fsPx: number, weight: string, italic: boolean, family: string): { asc: number; desc: number } {
  if (ctxMedir) {
    ctxMedir.font = `${italic ? 'italic ' : ''}${weight} ${fsPx}px ${family}`
    const tm = ctxMedir.measureText('Hg')
    const asc = tm.fontBoundingBoxAscent, desc = tm.fontBoundingBoxDescent
    if (asc != null && desc != null && asc + desc > 0) return { asc, desc }
  }
  return { asc: fsPx * 0.8, desc: fsPx * 0.2 } // fallback aproximado
}

// Y (px, relativa al lienzo) de la línea base de la PRIMERA línea del campo en el
// render SVG. La baseline no se mueve con el tamaño/escala (el primer tspan
// conserva su `y`), así que sirve de ancla fija para posicionar el textarea.
function baselineCampoScreenY(anchor: SVGElement, base: DOMRect): number | null {
  const ctm = (anchor as SVGGraphicsElement).getScreenCTM?.()
  const svg = anchor.ownerSVGElement
  if (!ctm || !svg) return null
  let local: { x: number; y: number } | null = null
  const tc = anchor as unknown as SVGTextContentElement
  try {
    if (tc.getNumberOfChars && tc.getNumberOfChars() > 0) {
      const p = tc.getStartPositionOfChar(0)
      local = { x: p.x, y: p.y }
    }
  } catch { /* sin glifos medibles */ }
  if (!local) {
    // Texto vacío: usar la `y` declarada del primer tspan (o del propio <text>).
    const ref = anchor.querySelector('tspan') ?? anchor
    const y = parseFloat(ref.getAttribute('y') ?? 'NaN')
    if (isNaN(y)) return null
    const x = parseFloat(ref.getAttribute('x') ?? '0')
    local = { x: isNaN(x) ? 0 : x, y }
  }
  const pt = svg.createSVGPoint()
  pt.x = local.x; pt.y = local.y
  return pt.matrixTransform(ctm).y - base.top
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
  // El <text> SVG ancla por baseline (glifos arriba); el textarea reparte el
  // interlineado mitad arriba/mitad abajo y posiciona la baseline a (medio
  // interlineado + ascenso) de su borde superior. Alineamos esa baseline con la
  // del render SVG (medida con métricas reales de la fuente) → sin salto al editar.
  const lhPx = parseFloat(ta.style.lineHeight), fsPx = parseFloat(ta.style.fontSize)
  const baseBL = parseFloat(ta.dataset.baseBaseline ?? '')
  if (!isNaN(baseBL) && !isNaN(lhPx) && !isNaN(fsPx)) {
    const { asc, desc } = metricasFuenteTA(fsPx, ef.weight, ef.italic, ef.family)
    const baselineDesdeTop = (lhPx + asc - desc) / 2 // medio interlineado + ascenso
    ta.style.top = baseBL - baselineDesdeTop + 'px'
  } else {
    // Fallback (sin baseline medible): modelo aproximado de medio interlineado.
    const bt = parseFloat(ta.dataset.baseTop ?? '')
    if (!isNaN(bt) && !isNaN(lhPx) && !isNaN(fsPx)) ta.style.top = bt - Math.max(0, (lhPx - fsPx) / 2) + 'px'
  }
  autoCrecer(ta, nombre)
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
  barraTexto.hidden = false // la posición la fija abrirEditor (flota sobre el texto)
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

function autoCrecer(ta: HTMLTextAreaElement, nombre = editorActivo?.nombre): void {
  ta.style.height = 'auto'
  let h = ta.scrollHeight
  // Caja de alto FIJADO A MANO: el textarea se recorta a las MISMAS líneas que
  // mostrará el render al commitear (overflow hidden de .editor-text) → en edición
  // se ve el mismo recorte, no todo el texto.
  if (nombre && cajaManual[nombre] && cajaAlto[nombre] !== undefined && svgEl) {
    const k = svgEl.clientWidth / (svgEl.viewBox.baseVal.width || 1080)
    const lhPx = parseFloat(ta.style.lineHeight) || 0
    const boxPx = cajaAlto[nombre] * k
    h = lhPx > 0 ? Math.min(h, Math.max(1, Math.floor(boxPx / lhPx)) * lhPx) : Math.min(h, boxPx)
  }
  ta.style.height = Math.round(h) + 'px'
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
//  Editor de imágenes (borrador mágico, ajustes, filtros, recorte, voltear)
// ---------------------------------------------------------------
// Modal con un canvas a resolución nativa (acotada). cv = imagen de trabajo;
// snap = copia para "Restaurar". Los ajustes (brillo/contraste/saturación) se
// previsualizan con filtro CSS y se hornean al aplicar; los filtros y las ops
// geométricas se hornean en cv (y snap) al instante.
type PanelImg = 'magico' | 'lazo' | 'borrar' | 'restaurar' | 'rellenar' | 'recortar' | 'ajustes' | 'filtros'
  | 'clonar' | 'difuminar' | 'aclarar' | 'oscurecer' | 'desenfocar'
const RETOQUE: PanelImg[] = ['clonar', 'difuminar', 'aclarar', 'oscurecer', 'desenfocar']

// Relleno por contexto (content-aware) de los píxeles transparentes (alpha=0):
// algoritmo pull-push (pirámide gaussiana con pesos). Reconstruye el fondo a
// partir de lo que rodea el hueco. Rápido y sin servidor; ideal para fondos
// relativamente uniformes y objetos chicos/medianos (no inventa contenido nuevo).
function inpaintPullPush(d: Uint8ClampedArray, w: number, h: number): void {
  interface Nivel { w: number; h: number; r: Float32Array; g: Float32Array; b: Float32Array; wt: Float32Array }
  const L0: Nivel = { w, h, r: new Float32Array(w * h), g: new Float32Array(w * h), b: new Float32Array(w * h), wt: new Float32Array(w * h) }
  for (let i = 0; i < w * h; i++) if (d[i * 4 + 3] > 0) { L0.r[i] = d[i * 4]; L0.g[i] = d[i * 4 + 1]; L0.b[i] = d[i * 4 + 2]; L0.wt[i] = 1 }
  const niveles: Nivel[] = [L0]
  // Pull: bajar resolución promediando por peso, hasta 1×1.
  while (niveles[niveles.length - 1].w > 1 || niveles[niveles.length - 1].h > 1) {
    const p = niveles[niveles.length - 1]
    const nw = Math.max(1, Math.ceil(p.w / 2)), nh = Math.max(1, Math.ceil(p.h / 2))
    const n: Nivel = { w: nw, h: nh, r: new Float32Array(nw * nh), g: new Float32Array(nw * nh), b: new Float32Array(nw * nh), wt: new Float32Array(nw * nh) }
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, ws = 0, cnt = 0
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = x * 2 + dx, sy = y * 2 + dy
        if (sx >= p.w || sy >= p.h) continue
        const si = sy * p.w + sx, wv = p.wt[si]; cnt++
        r += p.r[si] * wv; g += p.g[si] * wv; b += p.b[si] * wv; ws += wv
      }
      const ni = y * nw + x
      if (ws > 0) { n.r[ni] = r / ws; n.g[ni] = g / ws; n.b[ni] = b / ws; n.wt[ni] = Math.min(1, ws / cnt) }
    }
    niveles.push(n)
  }
  // Push: subir resolución rellenando los huecos con interpolación bilineal.
  const muestra = (L: Nivel, fx: number, fy: number, ch: Float32Array): number => {
    const gx = Math.min(L.w - 1, Math.max(0, fx * 0.5)), gy = Math.min(L.h - 1, Math.max(0, fy * 0.5))
    const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(L.w - 1, x0 + 1), y1 = Math.min(L.h - 1, y0 + 1)
    const tx = gx - x0, ty = gy - y0
    const a = ch[y0 * L.w + x0], b2 = ch[y0 * L.w + x1], c = ch[y1 * L.w + x0], e = ch[y1 * L.w + x1]
    return (a * (1 - tx) + b2 * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty
  }
  for (let l = niveles.length - 2; l >= 0; l--) {
    const cur = niveles[l], coarse = niveles[l + 1]
    for (let y = 0; y < cur.h; y++) for (let x = 0; x < cur.w; x++) {
      const i = y * cur.w + x, keep = cur.wt[i]
      if (keep >= 0.999) continue
      cur.r[i] = cur.r[i] * keep + muestra(coarse, x, y, coarse.r) * (1 - keep)
      cur.g[i] = cur.g[i] * keep + muestra(coarse, x, y, coarse.g) * (1 - keep)
      cur.b[i] = cur.b[i] * keep + muestra(coarse, x, y, coarse.b) * (1 - keep)
      cur.wt[i] = 1
    }
  }
  for (let i = 0; i < w * h; i++) if (d[i * 4 + 3] === 0) {
    d[i * 4] = L0.r[i]; d[i * 4 + 1] = L0.g[i]; d[i * 4 + 2] = L0.b[i]; d[i * 4 + 3] = 255
  }
}

// Relleno generativo con IA local: modelo MI-GAN (migan_pipeline_v2.onnx). La
// descarga y la inferencia corren en un Web Worker (inpaint-worker.ts) para no
// congelar la UI. La sesión queda cacheada dentro del worker.
let inpaintWorker: Worker | null = null
function getInpaintWorker(): Worker {
  if (!inpaintWorker) inpaintWorker = new Worker(new URL('./inpaint-worker.ts', import.meta.url), { type: 'module' })
  return inpaintWorker
}
// Corre MI-GAN en el worker. onProgreso recibe (etapa, frac). Resuelve la salida.
function correrInpaint(
  img: Uint8Array, mask: Uint8Array, M: number, onProgreso?: (etapa: string, frac?: number) => void,
): Promise<{ data: Uint8Array | Float32Array; dims: number[]; dtype: string }> {
  return new Promise((resolve, reject) => {
    const worker = getInpaintWorker()
    const onMsg = (e: MessageEvent) => {
      const m = e.data
      if (m.type === 'progress') onProgreso?.(m.etapa, m.frac)
      else if (m.type === 'result') { worker.removeEventListener('message', onMsg); resolve(m) }
      else if (m.type === 'error') { worker.removeEventListener('message', onMsg); reject(new Error(m.message)) }
    }
    worker.addEventListener('message', onMsg)
    worker.postMessage({ type: 'inpaint', img, mask, M })
  })
}
async function rellenarConIA(cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D, onEstado?: (etapa: string, frac?: number) => void): Promise<'ok' | 'vacio' | 'error'> {
  const w = cv.width, h = cv.height
  const data = ctx.getImageData(0, 0, w, h), d = data.data
  let minx = w, miny = h, maxx = -1, maxy = -1
  for (let i = 0; i < w * h; i++) if (d[i * 4 + 3] === 0) { const x = i % w, y = (i / w) | 0; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y }
  if (maxx < 0) return 'vacio'
  try {
    const M = 512
    // Ventana cuadrada centrada en el hueco con margen de contexto (mejor detalle
    // que mandar la imagen entera reducida a 512).
    const bw = maxx - minx + 1, bh = maxy - miny + 1
    const side = Math.min(w, h, Math.round(Math.max(bw, bh) * 2 + 32))
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2
    const sx = Math.max(0, Math.min(Math.round(cx - side / 2), w - side))
    const sy = Math.max(0, Math.min(Math.round(cy - side / 2), h - side))
    const tmp = document.createElement('canvas'); tmp.width = M; tmp.height = M
    const tctx = tmp.getContext('2d')!
    tctx.drawImage(cv, sx, sy, side, side, 0, 0, M, M)
    const crop = tctx.getImageData(0, 0, M, M).data
    const imgArr = new Uint8Array(3 * M * M), maskArr = new Uint8Array(M * M)
    for (let p = 0; p < M * M; p++) {
      imgArr[p] = crop[p * 4]; imgArr[M * M + p] = crop[p * 4 + 1]; imgArr[2 * M * M + p] = crop[p * 4 + 2]
      maskArr[p] = crop[p * 4 + 3] === 0 ? 0 : 255 // 255 conservar, 0 rellenar
    }
    const o = await correrInpaint(imgArr, maskArr, M, onEstado)
    const dims = o.dims, od = o.data
    const esFloat = o.dtype === 'float32'
    const val = (k: number) => { const v = esFloat ? (od[k] as number) * 255 : od[k] as number; return v < 0 ? 0 : v > 255 ? 255 : v }
    const hwc = dims.length === 4 && dims[3] === 3
    const outImg = tctx.createImageData(M, M)
    for (let p = 0; p < M * M; p++) {
      const r = hwc ? val(p * 3) : val(p)
      const g = hwc ? val(p * 3 + 1) : val(M * M + p)
      const b = hwc ? val(p * 3 + 2) : val(2 * M * M + p)
      outImg.data[p * 4] = r; outImg.data[p * 4 + 1] = g; outImg.data[p * 4 + 2] = b; outImg.data[p * 4 + 3] = 255
    }
    tctx.putImageData(outImg, 0, 0)
    const res = document.createElement('canvas'); res.width = side; res.height = side
    const rctx = res.getContext('2d')!; rctx.drawImage(tmp, 0, 0, M, M, 0, 0, side, side)
    const rd = rctx.getImageData(0, 0, side, side).data
    for (let yy = 0; yy < side; yy++) for (let xx = 0; xx < side; xx++) {
      const gi = (sy + yy) * w + (sx + xx)
      if (d[gi * 4 + 3] === 0) { const ri = (yy * side + xx) * 4; d[gi * 4] = rd[ri]; d[gi * 4 + 1] = rd[ri + 1]; d[gi * 4 + 2] = rd[ri + 2]; d[gi * 4 + 3] = 255 }
    }
    ctx.putImageData(data, 0, 0)
    return 'ok'
  } catch (e) {
    console.error('inpaint IA:', e)
    return 'error'
  }
}

// ---------------------------------------------------------------
//  Corrección de color (editor de imágenes): LUTs, curvas, auto
// ---------------------------------------------------------------
// Estado de color NO destructivo del panel "Ajustes". Valores centrados en 0
// (neutro); la curva son puntos (x,y) en 0..255 con extremos fijos en x.
type AdjColor = { b: number; c: number; s: number; h: number; temp: number; curva: [number, number][] }
function adjNeutro(): AdjColor { return { b: 0, c: 0, s: 0, h: 0, temp: 0, curva: [[0, 0], [255, 255]] } }
function adjEsNeutro(a: AdjColor): boolean {
  return a.b === 0 && a.c === 0 && a.s === 0 && a.h === 0 && a.temp === 0 &&
    a.curva.length === 2 && a.curva[0][1] === 0 && a.curva[1][1] === 255
}

// Interpola una curva monótona y suave (Fritsch–Carlson) por los puntos (0..255)
// → LUT de 256 entradas. Sin overshoot: ideal para una herramienta de curvas.
function curvaLUT(puntos: [number, number][]): Uint8ClampedArray {
  const pts = [...puntos].sort((a, b) => a[0] - b[0])
  const n = pts.length, lut = new Uint8ClampedArray(256)
  if (n < 2) { for (let i = 0; i < 256; i++) lut[i] = i; return lut }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const dx: number[] = [], m: number[] = []
  for (let i = 0; i < n - 1; i++) { dx[i] = Math.max(1e-6, xs[i + 1] - xs[i]); m[i] = (ys[i + 1] - ys[i]) / dx[i] }
  const t: number[] = []; t[0] = m[0]; t[n - 1] = m[n - 2]
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue }
    const a = t[i] / m[i], b = t[i + 1] / m[i], h = Math.hypot(a, b)
    if (h > 3) { const s = 3 / h; t[i] = s * a * m[i]; t[i + 1] = s * b * m[i] }
  }
  let seg = 0
  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) { lut[x] = ys[0]; continue }
    if (x >= xs[n - 1]) { lut[x] = ys[n - 1]; continue }
    while (seg < n - 2 && x > xs[seg + 1]) seg++
    const h = dx[seg], u = (x - xs[seg]) / h
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u
    const h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2
    lut[x] = h00 * ys[seg] + h10 * h * t[seg] + h01 * ys[seg + 1] + h11 * h * t[seg + 1]
  }
  return lut
}

// LUTs por canal: contraste + brillo + curva tonal + temperatura (cálido/frío).
function construirLUTsColor(a: AdjColor): [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray] {
  const curva = curvaLUT(a.curva)
  const cF = Math.tan((Math.max(-0.99, Math.min(0.99, a.c)) + 1) * Math.PI / 4)
  const tR = a.temp * 28, tB = -a.temp * 28
  const lr = new Uint8ClampedArray(256), lg = new Uint8ClampedArray(256), lb = new Uint8ClampedArray(256)
  for (let i = 0; i < 256; i++) {
    let v = (i / 255 - 0.5) * cF + 0.5 + a.b
    const base = curva[Math.max(0, Math.min(255, Math.round(v * 255)))]
    lr[i] = base + tR; lg[i] = base; lb[i] = base + tB
  }
  return [lr, lg, lb]
}

// Matriz 3x3 de rotación de tono (hue), preservando luminancia aprox.
function matrizHue(deg: number): number[] {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a)
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ]
}

// Aplica todo el pipeline de color a los píxeles (in place): LUTs → tono → saturación.
function procesarPixelesColor(d: Uint8ClampedArray, a: AdjColor): void {
  const [lr, lg, lb] = construirLUTsColor(a)
  const satMul = 1 + a.s, hm = a.h ? matrizHue(a.h) : null
  for (let i = 0; i < d.length; i += 4) {
    let r = lr[d[i]], g = lg[d[i + 1]], b = lb[d[i + 2]]
    if (hm) {
      const nr = r * hm[0] + g * hm[1] + b * hm[2]
      const ng = r * hm[3] + g * hm[4] + b * hm[5]
      const nb = r * hm[6] + g * hm[7] + b * hm[8]
      r = nr; g = ng; b = nb
    }
    if (satMul !== 1) {
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b
      r = L + (r - L) * satMul; g = L + (g - L) * satMul; b = L + (b - L) * satMul
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b // Uint8ClampedArray clampea solo
  }
}

// Auto-niveles: estira cada canal (porCanal=true → balance de blancos) o la
// luminancia (porCanal=false → contraste sin virar el color) entre percentiles.
function autoNivelesLUT(d: Uint8ClampedArray, porCanal: boolean): Uint8ClampedArray[] {
  const hist = [new Float64Array(256), new Float64Array(256), new Float64Array(256)]
  let total = 0
  for (let i = 0; i < d.length; i += 4) {
    if (porCanal) { hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++ }
    else hist[0][Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++
    total++
  }
  const luts: Uint8ClampedArray[] = [], corte = total * 0.005
  for (let ch = 0; ch < (porCanal ? 3 : 1); ch++) {
    const h = hist[ch]
    let lo = 0, hi = 255, acc = 0
    for (let i = 0; i < 256; i++) { acc += h[i]; if (acc > corte) { lo = i; break } }
    acc = 0
    for (let i = 255; i >= 0; i--) { acc += h[i]; if (acc > corte) { hi = i; break } }
    const lut = new Uint8ClampedArray(256), rango = Math.max(1, hi - lo)
    for (let i = 0; i < 256; i++) lut[i] = ((i - lo) / rango) * 255
    luts.push(lut)
  }
  return luts
}

// Auto-tono: gamma que lleva el brillo medio hacia el centro (0.5).
function autoGammaLUT(d: Uint8ClampedArray): Uint8ClampedArray {
  let sum = 0, n = 0
  for (let i = 0; i < d.length; i += 4) { sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++ }
  const media = Math.max(0.02, Math.min(0.98, (sum / Math.max(1, n)) / 255))
  const gamma = Math.log(0.5) / Math.log(media)
  const lut = new Uint8ClampedArray(256)
  for (let i = 0; i < 256; i++) lut[i] = Math.pow(i / 255, gamma) * 255
  return lut
}

// Editor de curvas tonales: clic agrega punto, arrastrar curva, doble clic quita.
function construirCurvas(adj: AdjColor, onCambio: () => void): HTMLElement {
  const wrap = document.createElement('div'); wrap.className = 'imged-curvas'
  const tit = document.createElement('span'); tit.className = 'imged-curvas-tit'; tit.textContent = 'Curvas'
  const CW = 220, CH = 150
  const cvc = document.createElement('canvas'); cvc.width = CW; cvc.height = CH; cvc.className = 'imged-curva-cv'
  const cc = cvc.getContext('2d')!
  const px = (x: number) => x / 255 * CW, py = (y: number) => CH - y / 255 * CH
  const ux = (X: number) => Math.max(0, Math.min(255, X / CW * 255)), uy = (Y: number) => Math.max(0, Math.min(255, (CH - Y) / CH * 255))
  const redibujar = () => {
    cc.clearRect(0, 0, CW, CH)
    cc.fillStyle = '#0d1620'; cc.fillRect(0, 0, CW, CH)
    cc.strokeStyle = '#23323f'; cc.lineWidth = 1
    for (let i = 1; i < 4; i++) { cc.beginPath(); cc.moveTo(CW * i / 4, 0); cc.lineTo(CW * i / 4, CH); cc.moveTo(0, CH * i / 4); cc.lineTo(CW, CH * i / 4); cc.stroke() }
    cc.strokeStyle = '#2c3e4d'; cc.beginPath(); cc.moveTo(0, CH); cc.lineTo(CW, 0); cc.stroke()
    const lut = curvaLUT(adj.curva)
    cc.strokeStyle = '#56b6ff'; cc.lineWidth = 2; cc.beginPath()
    for (let x = 0; x < 256; x++) { const X = x / 255 * CW, Y = CH - lut[x] / 255 * CH; x === 0 ? cc.moveTo(X, Y) : cc.lineTo(X, Y) }
    cc.stroke()
    cc.fillStyle = '#fff'
    for (const [x, y] of adj.curva) { cc.beginPath(); cc.arc(px(x), py(y), 4, 0, Math.PI * 2); cc.fill() }
  }
  const idxCerca = (X: number, Y: number) => {
    for (let i = 0; i < adj.curva.length; i++) if (Math.hypot(px(adj.curva[i][0]) - X, py(adj.curva[i][1]) - Y) < 11) return i
    return -1
  }
  let drag = -1
  cvc.addEventListener('pointerdown', (e) => {
    const r = cvc.getBoundingClientRect(), X = e.clientX - r.left, Y = e.clientY - r.top
    let i = idxCerca(X, Y)
    if (i < 0) { // agregar un punto nuevo y quedar arrastrándolo
      const nuevo: [number, number] = [Math.max(1, Math.min(254, ux(X))), uy(Y)]
      adj.curva.push(nuevo); adj.curva.sort((a, b) => a[0] - b[0]); i = adj.curva.indexOf(nuevo)
    }
    drag = i; try { cvc.setPointerCapture(e.pointerId) } catch { /* */ }
    redibujar(); onCambio()
  })
  cvc.addEventListener('pointermove', (e) => {
    if (drag < 0) return
    const r = cvc.getBoundingClientRect(), X = e.clientX - r.left, Y = e.clientY - r.top
    const extremo = drag === 0 || drag === adj.curva.length - 1
    const nx = extremo ? adj.curva[drag][0] : Math.max(1, Math.min(254, ux(X)))
    const movido: [number, number] = [nx, uy(Y)]
    adj.curva[drag] = movido
    if (!extremo) { adj.curva.sort((a, b) => a[0] - b[0]); drag = adj.curva.indexOf(movido) }
    redibujar(); onCambio()
  })
  const fin = () => { drag = -1 }
  cvc.addEventListener('pointerup', fin); cvc.addEventListener('pointercancel', fin)
  cvc.addEventListener('dblclick', (e) => {
    const r = cvc.getBoundingClientRect(), i = idxCerca(e.clientX - r.left, e.clientY - r.top)
    if (i > 0 && i < adj.curva.length - 1) { adj.curva.splice(i, 1); redibujar(); onCambio() }
  })
  const hint = document.createElement('span'); hint.className = 'imged-hint'
  hint.textContent = 'Clic agrega punto · arrastrá para curvar · doble clic lo quita'
  redibujar()
  wrap.append(tit, cvc, hint)
  return wrap
}

function abrirEditorImagen(src: string, onAplicar: (f: Foto) => void): void {
  const overlay = document.createElement('div')
  overlay.className = 'imged-overlay'
  overlay.innerHTML =
    `<div class="imged-modal">
      <div class="imged-top">
        <strong>Editar imagen</strong><span class="imged-estado"></span>
        <div class="imged-actions">
          <button class="imged-undo mini" title="Deshacer (Ctrl+Z)" disabled>↶</button>
          <button class="imged-redo mini" title="Rehacer (Ctrl+Shift+Z)" disabled>↷</button>
          <button class="imged-cancelar mini">Cancelar</button><button class="imged-aplicar">Aplicar</button>
        </div>
      </div>
      <div class="imged-tools"></div>
      <div class="imged-opts"></div>
      <div class="imged-stage"><canvas class="imged-cv"></canvas><canvas class="imged-lazo"></canvas><div class="imged-sel" hidden></div><div class="imged-cursor" hidden></div></div>
    </div>`
  document.body.appendChild(overlay)
  const q = <T extends Element>(s: string) => overlay.querySelector<T>(s)!
  const cv = q<HTMLCanvasElement>('.imged-cv')
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  const lazoCv = q<HTMLCanvasElement>('.imged-lazo')
  const lctx = lazoCv.getContext('2d')!
  const sel = q<HTMLDivElement>('.imged-sel')
  const stage = q<HTMLDivElement>('.imged-stage')
  const opts = q<HTMLDivElement>('.imged-opts')
  const toolsBar = q<HTMLDivElement>('.imged-tools')
  const estadoEd = q<HTMLSpanElement>('.imged-estado')
  const cursorEl = q<HTMLDivElement>('.imged-cursor')
  const btnUndo = q<HTMLButtonElement>('.imged-undo')
  const btnRedo = q<HTMLButtonElement>('.imged-redo')
  const snap = document.createElement('canvas')
  const sctx = snap.getContext('2d')!
  // Historial de deshacer/rehacer: copias del canvas (cap para no inflar memoria).
  const historia: HTMLCanvasElement[] = []
  let histIdx = -1
  const adj: AdjColor = adjNeutro()
  let ajusteBase: HTMLCanvasElement | null = null // copia "limpia" mientras se ajusta color
  let panel: PanelImg = 'magico'
  let brush = 40, tol = 30
  let lazoModo: 'no' | 'rapido' | 'ia' = 'no', lazoInvierte = false
  let procesandoIA = false
  let cargada = false
  let fuerza = 0.5 // intensidad de los pinceles de retoque (0..1)
  // Estado del clonador y del difuminar (dedo).
  let clonOrigen: { x: number; y: number } | null = null
  let clonOffset: { dx: number; dy: number } | null = null
  let cloneSnap: HTMLCanvasElement | null = null
  let smPickup: HTMLCanvasElement | null = null

  // El color del panel "Ajustes" se hornea por píxeles (no por filtro CSS), así
  // que el render base no aplica ningún filtro CSS.
  const render = () => { cv.style.filter = 'none' }
  const copiarCv = (): HTMLCanvasElement => { const c = nuevoCanvas(cv.width, cv.height); c.getContext('2d')!.drawImage(cv, 0, 0); return c }
  // Previsualiza los ajustes de color: redibuja la base y aplica el pipeline.
  const renderAjustes = () => {
    if (!ajusteBase) return
    ctx.filter = 'none'; ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(ajusteBase, 0, 0)
    if (!adjEsNeutro(adj)) {
      const id = ctx.getImageData(0, 0, cv.width, cv.height)
      procesarPixelesColor(id.data, adj)
      ctx.putImageData(id, 0, 0)
    }
  }
  // Al salir del panel de ajustes: si hubo cambios, los píxeles ya están en cv →
  // se hornean en snap + historial y se vuelve a neutro.
  const commitAjustes = () => {
    if (!ajusteBase) return
    if (!adjEsNeutro(adj)) {
      sctx.clearRect(0, 0, snap.width, snap.height); sctx.drawImage(cv, 0, 0)
      pushHist()
    }
    ajusteBase = null; Object.assign(adj, adjNeutro())
  }
  // Modo automático: calcula LUT(s) del preview actual, las hornea y resetea.
  const bakeAuto = (calc: (d: Uint8ClampedArray) => Uint8ClampedArray[]) => {
    if (!ajusteBase) return
    const id = ctx.getImageData(0, 0, cv.width, cv.height), d = id.data
    const luts = calc(d), [lr, lg, lb] = luts.length === 3 ? luts : [luts[0], luts[0], luts[0]]
    for (let i = 0; i < d.length; i += 4) { d[i] = lr[d[i]]; d[i + 1] = lg[d[i + 1]]; d[i + 2] = lb[d[i + 2]] }
    ctx.putImageData(id, 0, 0)
    ajusteBase = copiarCv()
    sctx.clearRect(0, 0, snap.width, snap.height); sctx.drawImage(cv, 0, 0)
    Object.assign(adj, adjNeutro()); pushHist(); pintarOpts()
  }

  // ---- Deshacer / Rehacer ----
  const refrescarUndo = () => { btnUndo.disabled = histIdx <= 0; btnRedo.disabled = histIdx >= historia.length - 1 }
  const pushHist = () => {
    if (!cargada) return
    historia.splice(histIdx + 1) // descartar el "futuro" si veníamos de un deshacer
    const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height
    c.getContext('2d')!.drawImage(cv, 0, 0)
    historia.push(c)
    const MAX = 14
    if (historia.length > MAX) historia.shift()
    histIdx = historia.length - 1
    refrescarUndo()
  }
  const aplicarHist = (i: number) => {
    const c = historia[i]; if (!c) return
    cv.width = c.width; cv.height = c.height
    ctx.clearRect(0, 0, cv.width, cv.height); ctx.filter = 'none'; ctx.drawImage(c, 0, 0)
    // snap = estado actual (para que "Restaurar" parta de acá tras un deshacer)
    snap.width = cv.width; snap.height = cv.height
    sctx.clearRect(0, 0, snap.width, snap.height); sctx.drawImage(cv, 0, 0)
    ajustarStage(); render(); refrescarUndo()
  }
  const undo = () => { if (histIdx > 0) { histIdx--; aplicarHist(histIdx) } }
  const redo = () => { if (histIdx < historia.length - 1) { histIdx++; aplicarHist(histIdx) } }

  // ---- Cursor circular del pincel (sigue al mouse, tamaño = el del pincel) ----
  const tieneCursor = () => panel === 'borrar' || panel === 'restaurar' || RETOQUE.includes(panel)
  const moverCursor = (e: PointerEvent) => {
    if (!tieneCursor()) { cursorEl.hidden = true; return }
    const r = cv.getBoundingClientRect(), sr = stage.getBoundingClientRect()
    const k = r.width / cv.width
    const d = brush * k
    cursorEl.hidden = false
    cursorEl.style.width = d + 'px'; cursorEl.style.height = d + 'px'
    cursorEl.style.left = (e.clientX - sr.left) + 'px'; cursorEl.style.top = (e.clientY - sr.top) + 'px'
  }

  // Posiciona el canvas del lazo exactamente sobre cv (misma escala/offset).
  const posLazo = () => {
    const r = cv.getBoundingClientRect(), sr = stage.getBoundingClientRect()
    if (lazoCv.width !== cv.width || lazoCv.height !== cv.height) { lazoCv.width = cv.width; lazoCv.height = cv.height }
    lazoCv.style.left = (r.left - sr.left) + 'px'; lazoCv.style.top = (r.top - sr.top) + 'px'
    lazoCv.style.width = r.width + 'px'; lazoCv.style.height = r.height + 'px'
  }
  const ajustarStage = () => {
    const k = Math.min(stage.clientWidth / cv.width, stage.clientHeight / cv.height)
    cv.style.width = cv.width * k + 'px'; cv.style.height = cv.height * k + 'px'
    posLazo()
  }
  // Rellena por contexto los píxeles transparentes (alpha=0). Devuelve false si
  // no había nada borrado.
  const rellenarTransparente = (): boolean => {
    const data = ctx.getImageData(0, 0, cv.width, cv.height)
    let hay = false
    for (let i = 3; i < data.data.length; i += 4) if (data.data[i] === 0) { hay = true; break }
    if (!hay) return false
    inpaintPullPush(data.data, cv.width, cv.height)
    ctx.putImageData(data, 0, 0)
    return true
  }
  // Reemplaza el contenido de cv y snap por canvases nuevos (ops geométricas).
  const reemplazar = (nuevoCv: HTMLCanvasElement, nuevoSnap: HTMLCanvasElement) => {
    cv.width = nuevoCv.width; cv.height = nuevoCv.height
    ctx.clearRect(0, 0, cv.width, cv.height); ctx.filter = 'none'; ctx.drawImage(nuevoCv, 0, 0)
    snap.width = nuevoSnap.width; snap.height = nuevoSnap.height
    sctx.clearRect(0, 0, snap.width, snap.height); sctx.drawImage(nuevoSnap, 0, 0)
    ajustarStage(); render(); pushHist()
  }
  const nuevoCanvas = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c }

  const img = new Image()
  img.onload = () => {
    const cap = 1600
    const esc = Math.min(1, cap / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * esc)), h = Math.max(1, Math.round(img.naturalHeight * esc))
    cv.width = w; cv.height = h; snap.width = w; snap.height = h
    ctx.drawImage(img, 0, 0, w, h); sctx.drawImage(cv, 0, 0)
    cargada = true; ajustarStage(); render(); pushHist()
  }
  img.onerror = () => { estadoEd.textContent = 'No se pudo cargar la imagen' }
  img.src = src

  // ---- Herramientas de pixel ----
  const aPx = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect()
    return { x: Math.round((e.clientX - r.left) * cv.width / r.width), y: Math.round((e.clientY - r.top) * cv.height / r.height) }
  }
  const borradorMagico = (sx: number, sy: number) => {
    const w = cv.width, h = cv.height
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return
    const data = ctx.getImageData(0, 0, w, h), d = data.data
    const i0 = (sy * w + sx) * 4
    if (d[i0 + 3] === 0) return
    const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2]
    const umbral = (tol / 100) * 180, u2 = umbral * umbral
    const vis = new Uint8Array(w * h), stack = [sy * w + sx]
    while (stack.length) {
      const p = stack.pop()!
      if (vis[p]) continue
      vis[p] = 1
      const i = p * 4
      if (d[i + 3] === 0) continue
      const dr = d[i] - tr, dg = d[i + 1] - tg, db = d[i + 2] - tb
      if (dr * dr + dg * dg + db * db > u2) continue
      d[i + 3] = 0
      const x = p % w, y = (p / w) | 0
      if (x > 0) stack.push(p - 1); if (x < w - 1) stack.push(p + 1)
      if (y > 0) stack.push(p - w); if (y < h - 1) stack.push(p + w)
    }
    ctx.putImageData(data, 0, 0)
  }
  const trazo = (x0: number, y0: number, x1: number, y1: number, modo: 'borrar' | 'restaurar') => {
    const pasos = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (brush / 4)))
    for (let s = 0; s <= pasos; s++) {
      const x = x0 + (x1 - x0) * s / pasos, y = y0 + (y1 - y0) * s / pasos
      if (modo === 'borrar') {
        ctx.save(); ctx.globalCompositeOperation = 'destination-out'
        ctx.beginPath(); ctx.arc(x, y, brush / 2, 0, 2 * Math.PI); ctx.fill(); ctx.restore()
      } else {
        ctx.save(); ctx.beginPath(); ctx.arc(x, y, brush / 2, 0, 2 * Math.PI); ctx.clip()
        ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(snap, 0, 0); ctx.restore()
      }
    }
  }
  // ---- Pinceles de retoque (clonar, difuminar, aclarar, oscurecer, desenfocar) ----
  const dabRetoque = (x: number, y: number) => {
    const R = brush / 2
    if (panel === 'clonar') {
      if (!clonOffset || !cloneSnap) return
      // Fuente = destino - offset; dibujamos el snapshot corrido y recortado al círculo.
      ctx.save(); ctx.beginPath(); ctx.arc(x, y, R, 0, 2 * Math.PI); ctx.clip()
      ctx.drawImage(cloneSnap, clonOffset.dx, clonOffset.dy); ctx.restore()
      return
    }
    if (panel === 'difuminar') {
      const S = Math.ceil(brush) + 2
      if (!smPickup) { smPickup = nuevoCanvas(S, S); smPickup.getContext('2d')!.drawImage(cv, x - R, y - R, S, S, 0, 0, S, S); return }
      ctx.save(); ctx.beginPath(); ctx.arc(x, y, R, 0, 2 * Math.PI); ctx.clip()
      ctx.globalAlpha = fuerza; ctx.drawImage(smPickup, x - R, y - R); ctx.restore()
      const pctx = smPickup.getContext('2d')!; pctx.clearRect(0, 0, S, S); pctx.drawImage(cv, x - R, y - R, S, S, 0, 0, S, S)
      return
    }
    const x0 = Math.max(0, Math.floor(x - R - 1)), y0 = Math.max(0, Math.floor(y - R - 1))
    const x1 = Math.min(cv.width, Math.ceil(x + R + 1)), y1 = Math.min(cv.height, Math.ceil(y + R + 1))
    const w = x1 - x0, h = y1 - y0
    if (w <= 0 || h <= 0) return
    const img = ctx.getImageData(x0, y0, w, h), d = img.data
    const src = panel === 'desenfocar' ? new Uint8ClampedArray(d) : null
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const dist = Math.hypot(x0 + xx - x, y0 + yy - y); if (dist > R) continue
      const fall = (1 - dist / R) * fuerza
      const i = (yy * w + xx) * 4
      if (d[i + 3] === 0) continue
      if (panel === 'aclarar') { for (let c = 0; c < 3; c++) d[i + c] += (255 - d[i + c]) * fall }
      else if (panel === 'oscurecer') { for (let c = 0; c < 3; c++) d[i + c] *= (1 - fall) }
      else if (panel === 'desenfocar') {
        for (let c = 0; c < 3; c++) {
          let s = 0, n = 0
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = xx + dx, ny = yy + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
            s += src![(ny * w + nx) * 4 + c]; n++
          }
          d[i + c] = d[i + c] * (1 - fall) + (s / n) * fall
        }
      }
    }
    ctx.putImageData(img, x0, y0)
  }
  const trazoRetoque = (x0: number, y0: number, x1: number, y1: number) => {
    const pasos = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (brush / 4)))
    for (let s = 0; s <= pasos; s++) dabRetoque(x0 + (x1 - x0) * s / pasos, y0 + (y1 - y0) * s / pasos)
  }
  // Marca del origen de clonado (anillo) sobre la capa del lazo.
  const dibujarOrigenClon = (sx: number, sy: number) => {
    lctx.clearRect(0, 0, lazoCv.width, lazoCv.height)
    lctx.beginPath(); lctx.arc(sx, sy, Math.max(5, brush / 2), 0, 2 * Math.PI)
    lctx.strokeStyle = '#38bdf8'; lctx.lineWidth = Math.max(1.5, cv.width / 600); lctx.setLineDash([4, 4]); lctx.stroke()
    lctx.setLineDash([]); lctx.beginPath(); lctx.moveTo(sx - 6, sy); lctx.lineTo(sx + 6, sy); lctx.moveTo(sx, sy - 6); lctx.lineTo(sx, sy + 6); lctx.stroke()
  }

  // ---- Lazo: selección libre ----
  let lazoPts: { x: number; y: number }[] = []
  const dibujarLazoPreview = () => {
    lctx.clearRect(0, 0, lazoCv.width, lazoCv.height)
    if (lazoPts.length < 2) return
    lctx.beginPath(); lctx.moveTo(lazoPts[0].x, lazoPts[0].y)
    for (let i = 1; i < lazoPts.length; i++) lctx.lineTo(lazoPts[i].x, lazoPts[i].y)
    lctx.closePath()
    lctx.fillStyle = 'rgba(56,189,248,0.15)'; lctx.fill()
    lctx.lineWidth = Math.max(1.5, cv.width / 500); lctx.strokeStyle = '#38bdf8'; lctx.setLineDash([7, 5]); lctx.stroke()
  }
  const aplicarLazo = async () => {
    const pts = lazoPts
    lazoPts = []; lctx.clearRect(0, 0, lazoCv.width, lazoCv.height)
    if (pts.length < 3) return
    ctx.save(); ctx.globalCompositeOperation = 'destination-out'
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.closePath()
    if (lazoInvierte) { ctx.rect(0, 0, cv.width, cv.height); ctx.fill('evenodd') } // borra afuera
    else ctx.fill()
    ctx.restore()
    // Rellenar lo borrado según el modo elegido (solo si se borró adentro).
    if (lazoModo !== 'no' && !lazoInvierte) {
      if (lazoModo === 'rapido') rellenarTransparente()
      else if (!procesandoIA) {
        procesandoIA = true
        estadoEd.textContent = 'Rellenando con IA…'
        const r = await rellenarConIA(cv, ctx, (et, f) => { estadoEd.textContent = f != null ? `${et} ${Math.round(f * 100)}%` : et + '…' })
        estadoEd.textContent = r === 'ok' ? 'Relleno con IA listo ✓' : r === 'error' ? 'No se pudo rellenar con IA' : ''
        procesandoIA = false
      }
    }
    pushHist()
  }

  let pintando = false, lazando = false, ult: { x: number; y: number } | null = null
  let cropIni: { x: number; y: number } | null = null, cropRect: { x: number; y: number; w: number; h: number } | null = null
  cv.addEventListener('pointerdown', (e) => {
    if (!cargada) return
    const p = aPx(e)
    if (panel === 'magico') { borradorMagico(p.x, p.y); pushHist(); return }
    if (panel === 'lazo') { lazando = true; lazoPts = [p]; cv.setPointerCapture(e.pointerId); return }
    if (panel === 'recortar') { cropIni = p; cropRect = null; cv.setPointerCapture(e.pointerId); return }
    if (RETOQUE.includes(panel)) {
      if (panel === 'clonar' && e.altKey) {
        clonOrigen = { x: p.x, y: p.y }; clonOffset = null
        estadoEd.textContent = 'Origen de clonado fijado ✓'; dibujarOrigenClon(p.x, p.y); return
      }
      if (panel === 'clonar') {
        if (!clonOrigen && !clonOffset) { estadoEd.textContent = 'Primero Alt+clic para fijar el origen'; return }
        // Offset alineado: se fija en el primer trazo y se mantiene entre trazos.
        if (!clonOffset && clonOrigen) clonOffset = { dx: p.x - clonOrigen.x, dy: p.y - clonOrigen.y }
        cloneSnap = nuevoCanvas(cv.width, cv.height); cloneSnap.getContext('2d')!.drawImage(cv, 0, 0)
      }
      if (panel === 'difuminar') smPickup = null
      pintando = true; ult = p; dabRetoque(p.x, p.y); cv.setPointerCapture(e.pointerId); return
    }
    if (panel === 'borrar' || panel === 'restaurar') {
      pintando = true; ult = p; trazo(p.x, p.y, p.x, p.y, panel); cv.setPointerCapture(e.pointerId)
    }
  })
  cv.addEventListener('pointermove', (e) => {
    if (!cargada) return
    moverCursor(e)
    const p = aPx(e)
    if (lazando && panel === 'lazo') { lazoPts.push(p); dibujarLazoPreview(); return }
    if (cropIni && panel === 'recortar') {
      cropRect = { x: Math.min(cropIni.x, p.x), y: Math.min(cropIni.y, p.y), w: Math.abs(p.x - cropIni.x), h: Math.abs(p.y - cropIni.y) }
      dibujarSel(); return
    }
    // Marca móvil del origen mientras se clona.
    if (panel === 'clonar' && (clonOffset || clonOrigen)) {
      const s = clonOffset ? { x: p.x - clonOffset.dx, y: p.y - clonOffset.dy } : clonOrigen!
      dibujarOrigenClon(s.x, s.y)
    }
    if (pintando && ult) {
      if (RETOQUE.includes(panel)) trazoRetoque(ult.x, ult.y, p.x, p.y)
      else trazo(ult.x, ult.y, p.x, p.y, panel as 'borrar' | 'restaurar')
      ult = p
    }
  })
  cv.addEventListener('pointerleave', () => { cursorEl.hidden = true })
  const finPuntero = () => {
    if (lazando) { lazando = false; void aplicarLazo(); return } // aplicarLazo hace su propio pushHist
    if (pintando) { pintando = false; ult = null; pushHist() }
    cropIni = null
  }
  cv.addEventListener('pointerup', finPuntero)
  cv.addEventListener('pointercancel', finPuntero)

  const dibujarSel = () => {
    if (!cropRect) { sel.hidden = true; return }
    const r = cv.getBoundingClientRect(), sr = stage.getBoundingClientRect()
    const k = r.width / cv.width
    sel.hidden = false
    sel.style.left = (r.left - sr.left + cropRect.x * k) + 'px'
    sel.style.top = (r.top - sr.top + cropRect.y * k) + 'px'
    sel.style.width = cropRect.w * k + 'px'; sel.style.height = cropRect.h * k + 'px'
  }

  // ---- Ops geométricas / filtros ----
  const aplicarFiltro = (filtro: string) => {
    for (const c of [cv, snap]) {
      const t = nuevoCanvas(c.width, c.height), tctx = t.getContext('2d')!
      tctx.filter = filtro; tctx.drawImage(c, 0, 0)
      const cc = c.getContext('2d')!; cc.clearRect(0, 0, c.width, c.height); cc.filter = 'none'; cc.drawImage(t, 0, 0)
    }
    render(); pushHist()
  }
  const voltear = (eje: 'h' | 'v') => {
    const nc = nuevoCanvas(cv.width, cv.height), ns = nuevoCanvas(snap.width, snap.height)
    for (const [dst, srcC] of [[nc, cv], [ns, snap]] as [HTMLCanvasElement, HTMLCanvasElement][]) {
      const c = dst.getContext('2d')!
      c.translate(eje === 'h' ? dst.width : 0, eje === 'v' ? dst.height : 0)
      c.scale(eje === 'h' ? -1 : 1, eje === 'v' ? -1 : 1)
      c.drawImage(srcC, 0, 0)
    }
    reemplazar(nc, ns)
  }
  const rotar = () => {
    const nc = nuevoCanvas(cv.height, cv.width), ns = nuevoCanvas(snap.height, snap.width)
    for (const [dst, srcC] of [[nc, cv], [ns, snap]] as [HTMLCanvasElement, HTMLCanvasElement][]) {
      const c = dst.getContext('2d')!
      c.translate(dst.width, 0); c.rotate(Math.PI / 2); c.drawImage(srcC, 0, 0)
    }
    reemplazar(nc, ns)
  }
  const aplicarRecorte = () => {
    if (!cropRect || cropRect.w < 4 || cropRect.h < 4) return
    const { x, y, w, h } = cropRect
    const nc = nuevoCanvas(w, h), ns = nuevoCanvas(w, h)
    nc.getContext('2d')!.drawImage(cv, x, y, w, h, 0, 0, w, h)
    ns.getContext('2d')!.drawImage(snap, x, y, w, h, 0, 0, w, h)
    cropRect = null; sel.hidden = true
    reemplazar(nc, ns)
  }

  // ---- UI: barra de herramientas + opciones contextuales ----
  const setPanel = (p: PanelImg) => {
    if (panel === 'ajustes' && p !== 'ajustes') commitAjustes() // hornear color al salir
    panel = p; cropRect = null; cropIni = null; sel.hidden = true
    lctx.clearRect(0, 0, lazoCv.width, lazoCv.height) // limpiar marca de clonado / lazo
    if (!tieneCursor()) cursorEl.hidden = true
    if (p === 'ajustes') { ajusteBase = copiarCv(); Object.assign(adj, adjNeutro()) } // capturar base limpia
    pintarBarra(); pintarOpts()
    ajustarStage() // el alto de las opciones cambió (p.ej. curvas) → reencajar la imagen
  }
  type Accion = 'voltearH' | 'voltearV' | 'rotar'
  // Barra agrupada por familia (un '|' es un separador visual).
  const grupos: ([PanelImg | Accion, string, string] | '|')[] = [
    ['magico', '✨ Mágico', 'Borrador mágico: clic para borrar una zona de color similar'],
    ['lazo', '🔗 Lazo', 'Dibujá una selección libre para borrar lo de adentro'],
    ['borrar', '🧽 Borrador', 'Pincel para borrar a mano'],
    ['restaurar', '↩ Restaurar', 'Pincel para traer de vuelta lo borrado'],
    '|',
    ['rellenar', '🪄 Rellenar', 'Rellenar lo borrado (rápido o con IA)'],
    '|',
    ['clonar', '🔁 Clonar', 'Clonador: Alt+clic fija el origen, luego pintás'],
    ['difuminar', '👆 Difuminar', 'Dedo: arrastra/mezcla el color'],
    ['aclarar', '🔆 Aclarar', 'Aclara (dodge) donde pintás'],
    ['oscurecer', '🌑 Oscurecer', 'Oscurece (burn) donde pintás'],
    ['desenfocar', '💧 Desenfocar', 'Suaviza/desenfoca donde pintás'],
    '|',
    ['recortar', '⃞ Recortar', 'Arrastrá para elegir el área'],
    ['voltearH', '⇆', 'Voltear horizontal'],
    ['voltearV', '⇅', 'Voltear vertical'],
    ['rotar', '⟳', 'Rotar 90°'],
    '|',
    ['ajustes', '🎚 Ajustes', 'Brillo, contraste, saturación'],
    ['filtros', '🎨 Filtros', 'B&N, sepia, vintage…'],
  ]
  const acciones: string[] = ['voltearH', 'voltearV', 'rotar']
  const pintarBarra = () => {
    toolsBar.innerHTML = ''
    for (const g of grupos) {
      if (g === '|') { const s = document.createElement('span'); s.className = 'imged-sep'; toolsBar.appendChild(s); continue }
      const [id, label, tip] = g
      const b = document.createElement('button')
      b.className = 'imged-tbtn' + (!acciones.includes(id) && id === panel ? ' activo' : ''); b.textContent = label; b.title = tip
      b.addEventListener('click', () => {
        if (id === 'voltearH') voltear('h')
        else if (id === 'voltearV') voltear('v')
        else if (id === 'rotar') rotar()
        else setPanel(id as PanelImg)
      })
      toolsBar.appendChild(b)
    }
  }
  const slider = (label: string, min: number, max: number, step: number, val: number, oninput: (v: number) => void): HTMLLabelElement => {
    const l = document.createElement('label'); l.className = 'imged-slider'
    const sp = document.createElement('span'); sp.textContent = label
    const inp = document.createElement('input'); inp.type = 'range'; inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(val)
    inp.addEventListener('input', () => oninput(parseFloat(inp.value)))
    l.append(sp, inp); return l
  }
  const pintarOpts = () => {
    opts.innerHTML = ''
    if (panel === 'magico') {
      opts.appendChild(slider('Tolerancia', 1, 100, 1, tol, (v) => { tol = v }))
      const h = document.createElement('span'); h.className = 'imged-hint'; h.textContent = 'Tip: clic en el fondo. Más tolerancia = borra colores más distintos.'
      opts.appendChild(h)
    } else if (panel === 'lazo') {
      const chk = (label: string, val: boolean, on: (v: boolean) => void): HTMLLabelElement => {
        const l = document.createElement('label'); l.className = 'imged-chk'
        const i = document.createElement('input'); i.type = 'checkbox'; i.checked = val
        i.addEventListener('change', () => on(i.checked))
        l.append(i, document.createTextNode(' ' + label)); return l
      }
      const lblR = document.createElement('label'); lblR.className = 'imged-chk'
      const sel = document.createElement('select'); sel.className = 'imged-select'
      for (const [v, t] of [['no', 'No rellenar'], ['rapido', 'Rellenar rápido'], ['ia', 'Rellenar con IA']] as [string, string][]) {
        const op = document.createElement('option'); op.value = v; op.textContent = t; op.selected = v === lazoModo; sel.appendChild(op)
      }
      sel.addEventListener('change', () => { lazoModo = sel.value as 'no' | 'rapido' | 'ia' })
      lblR.append(document.createTextNode('Al borrar: '), sel)
      opts.appendChild(lblR)
      opts.appendChild(chk('Invertir (dejar solo la selección)', lazoInvierte, (v) => { lazoInvierte = v }))
      const h = document.createElement('span'); h.className = 'imged-hint'; h.textContent = 'Dibujá alrededor de lo que querés borrar y soltá.'
      opts.appendChild(h)
    } else if (panel === 'rellenar') {
      // Barra de progreso (compartida entre Rápido e IA).
      const prog = document.createElement('div'); prog.className = 'imged-prog'
      const bar = document.createElement('div'); bar.className = 'imged-prog-bar'
      const fill = document.createElement('div'); fill.className = 'imged-prog-fill'
      bar.appendChild(fill)
      const ptxt = document.createElement('span'); ptxt.className = 'imged-prog-txt'
      prog.append(bar, ptxt)
      const setProg = (texto: string, frac?: number) => {
        ptxt.textContent = texto
        prog.classList.toggle('activo', !!texto)
        if (frac == null) { bar.classList.add('indet'); fill.style.width = '100%' }
        else { bar.classList.remove('indet'); fill.style.width = Math.round(frac * 100) + '%' }
      }
      const rapido = document.createElement('button'); rapido.className = 'imged-tbtn'; rapido.textContent = '⚡ Rápido'
      rapido.title = 'Instantáneo, ideal para fondos lisos o degradados'
      rapido.addEventListener('click', () => { const ok = rellenarTransparente(); setProg(ok ? 'Listo ✓' : 'No hay nada borrado para rellenar'); if (ok) pushHist() })
      const ia = document.createElement('button'); ia.className = 'imged-tbtn imged-tbtn-ia'; ia.textContent = '✨ Con IA'
      ia.title = 'Relleno generativo con IA local (mejor textura; baja el modelo la 1.ª vez)'
      ia.addEventListener('click', async () => {
        if (procesandoIA) return
        procesandoIA = true; ia.disabled = true; rapido.disabled = true
        setProg('Preparando…')
        const r = await rellenarConIA(cv, ctx, (etapa, frac) => setProg(frac != null ? `${etapa} ${Math.round(frac * 100)}%` : etapa, frac))
        setProg(r === 'ok' ? 'Listo ✓' : r === 'vacio' ? 'No hay nada borrado para rellenar' : 'No se pudo rellenar (ver consola)', r === 'ok' ? 1 : undefined)
        if (r !== 'ok') bar.classList.remove('indet')
        if (r === 'ok') pushHist()
        procesandoIA = false; ia.disabled = false; rapido.disabled = false
      })
      const h = document.createElement('span'); h.className = 'imged-hint'; h.textContent = 'Primero borrá algo; después “Rápido” (al toque) o “Con IA” (reconstruye textura).'
      opts.append(rapido, ia, h, prog)
    } else if (panel === 'borrar' || panel === 'restaurar') {
      opts.appendChild(slider('Tamaño', 5, 200, 1, brush, (v) => { brush = v }))
    } else if (RETOQUE.includes(panel)) {
      opts.appendChild(slider('Tamaño', 5, 200, 1, brush, (v) => { brush = v }))
      if (panel !== 'clonar') opts.appendChild(slider('Intensidad', 0.05, 1, 0.01, fuerza, (v) => { fuerza = v }))
      const h = document.createElement('span'); h.className = 'imged-hint'
      h.textContent = panel === 'clonar' ? 'Alt+clic para fijar el origen, después pintá para clonar.'
        : panel === 'difuminar' ? 'Arrastrá para arrastrar/mezclar el color (efecto dedo).'
          : 'Pintá sobre la imagen.'
      opts.appendChild(h)
    } else if (panel === 'recortar') {
      const ap = document.createElement('button'); ap.className = 'imged-tbtn'; ap.textContent = 'Aplicar recorte'
      ap.addEventListener('click', aplicarRecorte)
      const h = document.createElement('span'); h.className = 'imged-hint'; h.textContent = 'Arrastrá sobre la imagen para elegir el área y luego “Aplicar recorte”.'
      opts.append(ap, h)
    } else if (panel === 'ajustes') {
      // Modos automáticos.
      const autoRow = document.createElement('div'); autoRow.className = 'imged-auto-row'
      const mkAuto = (label: string, tip: string, fn: () => void) => {
        const b = document.createElement('button'); b.className = 'imged-tbtn'; b.textContent = label; b.title = tip
        b.addEventListener('click', fn); return b
      }
      autoRow.append(
        mkAuto('Auto contraste', 'Estira el rango tonal sin virar el color', () => bakeAuto((d) => autoNivelesLUT(d, false))),
        mkAuto('Auto color', 'Equilibra el color (balance de blancos)', () => bakeAuto((d) => autoNivelesLUT(d, true))),
        mkAuto('Auto tono', 'Lleva el brillo medio al centro', () => bakeAuto((d) => [autoGammaLUT(d)])),
      )
      opts.appendChild(autoRow)
      // Sliders manuales (centrados en 0 = neutro).
      opts.appendChild(slider('Brillo', -1, 1, 0.01, adj.b, (v) => { adj.b = v; renderAjustes() }))
      opts.appendChild(slider('Contraste', -1, 1, 0.01, adj.c, (v) => { adj.c = v; renderAjustes() }))
      opts.appendChild(slider('Saturación', -1, 1, 0.01, adj.s, (v) => { adj.s = v; renderAjustes() }))
      opts.appendChild(slider('Tono', -180, 180, 1, adj.h, (v) => { adj.h = v; renderAjustes() }))
      opts.appendChild(slider('Temperatura', -1, 1, 0.01, adj.temp, (v) => { adj.temp = v; renderAjustes() }))
      // Curvas.
      opts.appendChild(construirCurvas(adj, renderAjustes))
      const reset = document.createElement('button'); reset.className = 'imged-tbtn'; reset.textContent = '↺ Restablecer'
      reset.title = 'Volver todo a neutro'
      reset.addEventListener('click', () => { Object.assign(adj, adjNeutro()); renderAjustes(); pintarOpts() })
      opts.appendChild(reset)
    } else if (panel === 'filtros') {
      const filtros: [string, string][] = [
        ['Blanco y negro', 'grayscale(1)'], ['Sepia', 'sepia(1)'],
        ['Vintage', 'sepia(0.4) contrast(1.1) saturate(1.3)'], ['Más contraste', 'contrast(1.25)'],
        ['Frío', 'saturate(1.2) hue-rotate(-12deg)'], ['Cálido', 'saturate(1.2) sepia(0.2)'],
      ]
      for (const [nombre, f] of filtros) {
        const b = document.createElement('button'); b.className = 'imged-tbtn'; b.textContent = nombre
        b.addEventListener('click', () => aplicarFiltro(f))
        opts.appendChild(b)
      }
    }
  }

  // ---- Deshacer / rehacer: botones + teclado ----
  btnUndo.addEventListener('click', undo)
  btnRedo.addEventListener('click', redo)
  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return
    const k = e.key.toLowerCase()
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); undo() }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); e.stopPropagation(); redo() }
  }
  document.addEventListener('keydown', onKey, true) // captura: gana al undo de la app

  // ---- Cerrar / aplicar ----
  const cerrar = () => { window.removeEventListener('resize', ajustarStage); document.removeEventListener('keydown', onKey, true); overlay.remove() }
  q<HTMLButtonElement>('.imged-cancelar').addEventListener('click', cerrar)
  q<HTMLButtonElement>('.imged-aplicar').addEventListener('click', () => {
    if (!cargada) { cerrar(); return }
    // El color ya está horneado en los píxeles de cv (preview destructivo del
    // panel Ajustes), así que el canvas de salida es una copia directa.
    const out = nuevoCanvas(cv.width, cv.height), octx = out.getContext('2d')!
    octx.drawImage(cv, 0, 0)
    const dataUrl = out.toDataURL('image/png')
    onAplicar({ dataUrl, w: out.width, h: out.height })
    registrarHistorial(); autoguardar()
    cerrar()
  })
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) cerrar() })
  window.addEventListener('resize', ajustarStage)
  pintarBarra(); pintarOpts()
}

// ---------------------------------------------------------------
//  Exportar (resvg)
// ---------------------------------------------------------------
// Elementos "a sangre" (fondo de la placa): los que cubren ≥90% del SVG en
// pantalla. Robusto ante grupos anidados/escalados (usa rects de pantalla). Se
// ocultan para exportar con fondo transparente.
function elementosFondoASangre(): SVGElement[] {
  if (!svgEl) return []
  const sr = svgEl.getBoundingClientRect()
  const areaSvg = sr.width * sr.height || 1
  const out: SVGElement[] = []
  for (const el of Array.from(svgEl.querySelectorAll<SVGElement>('rect, path, image, polygon, circle, ellipse'))) {
    const r = el.getBoundingClientRect()
    if ((r.width * r.height) / areaSvg >= 0.9) out.push(el)
  }
  return out
}

async function exportarPNG(): Promise<void> {
  try {
    cerrarEditor()
    if (!svgEl) return
    const transp = peTransparente.checked
    estado.textContent = 'Exportando…'
    // Fondo transparente: ocultar el fondo a sangre mientras serializamos.
    const ocultados: SVGElement[] = []
    if (transp) for (const el of elementosFondoASangre()) { el.style.display = 'none'; ocultados.push(el) }
    // Exportamos EXACTAMENTE el SVG vivo (ya tiene wrap + shrink + foto aplicados),
    // así el PNG es idéntico a lo que se ve en el editor.
    const svg = new XMLSerializer().serializeToString(svgEl)
    for (const el of ocultados) el.style.display = '' // restaurar el editor
    // Ancho de export = ancho del lienzo (viewBox), acotado para no exagerar.
    const vbW = svgEl.viewBox.baseVal.width || 1080
    const anchoExport = Math.round(Math.min(2480, Math.max(1080, vbW)))
    const blob = await renderResvg(svg, facesPack.map((f) => f.bytes), anchoExport)
    const url = URL.createObjectURL(blob)
    peImg.src = url
    peDescargar.href = url
    peDescargar.setAttribute('download', `${nombreArchivo()}${transp ? '-transparente' : ''}.png`)
    peCarrusel.hidden = carruselSlides < 2
    if (carruselSlides >= 2) peCarrusel.textContent = `⬇ Carrusel (${carruselSlides} imágenes)`
    panelExport.hidden = false
    estado.textContent = transp ? 'PNG exportado (fondo transparente).' : 'PNG exportado.'
  } catch (err) {
    estado.textContent = '❌ ' + (err instanceof Error ? err.message : String(err))
    console.error(err)
  }
}
btnExport.addEventListener('click', () => void exportarPNG())

// Serializa el SVG vivo (opcionalmente sin el fondo a sangre) para exportar.
function svgParaExportar(transp: boolean): string {
  if (!svgEl) return ''
  const ocultados: SVGElement[] = []
  if (transp) for (const el of elementosFondoASangre()) { el.style.display = 'none'; ocultados.push(el) }
  let s = new XMLSerializer().serializeToString(svgEl)
  for (const el of ocultados) el.style.display = ''
  if (!/\sxmlns=/.test(s)) s = s.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
  return s
}
function descargar(blob: Blob, nombre: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = nombre; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
function descargarSVG(): void {
  if (!svgEl) return
  cerrarEditor()
  const s = svgParaExportar(peTransparente.checked)
  descargar(new Blob([s], { type: 'image/svg+xml;charset=utf-8' }), `${nombreArchivo()}.svg`)
  estado.textContent = 'SVG descargado.'
}
// Registra en la instancia jsPDF las fuentes (TTF/OTF) que usa el texto del SVG,
// para que svg2pdf dibuje con la fuente real (Poppins, etc.) en vez de caer a
// Helvetica. jsPDF y svg2pdf comparten la MISMA combineFontStyleAndFontWeight: al
// registrar con addFont(archivo, familia, estilo, peso), la clave de estilo que
// guarda jsPDF coincide con la que svg2pdf pide en getFontList() (p.ej. peso 600 →
// "600normal", 700 → "bold", 700+itálica → "bolditalic"). jsPDF solo admite sfnt
// (ttf/otf): las woff/woff2 (p.ej. fuentes traídas de Google) no se pueden embeber
// y ese texto cae igual a la fuente estándar.
function registrarFuentesPdf(pdf: jsPDF): void {
  if (!svgEl) return
  // Familias realmente usadas por el texto (1.ª de cada font-family), en minúscula.
  const usadas = new Set<string>()
  for (const t of Array.from(svgEl.querySelectorAll('text'))) {
    const fam = getComputedStyle(t).fontFamily.split(',')[0]?.replace(/['"]/g, '').trim()
    if (fam) usadas.add(fam.toLowerCase())
  }
  const hechas = new Set<string>()
  for (const f of facesPack) {
    if (f.formato !== 'truetype' && f.formato !== 'opentype') continue
    if (!usadas.has(f.family.toLowerCase())) continue
    const clave = `${f.family}|${f.weight}|${f.style}`
    if (hechas.has(clave)) continue
    hechas.add(clave)
    const archivo = `${f.family.replace(/\s+/g, '')}-${f.weight}${f.style === 'italic' ? 'i' : ''}.ttf`
    try {
      pdf.addFileToVFS(archivo, bytesABase64(f.bytes))
      pdf.addFont(archivo, f.family, f.style === 'italic' ? 'italic' : 'normal', f.weight)
    } catch (e) { console.warn('No se pudo registrar la fuente en el PDF:', f.family, f.weight, e) }
  }
}

// PDF con jsPDF (import diferido). Intenta VECTORIAL con svg2pdf.js (texto/vectores
// reeditables); si falla —típico cuando hay una foto embebida grande, que svg2pdf
// no procesa— cae a PDF "imagen" (PNG de resvg embebido), que siempre funciona.
async function exportarPDF(btn?: HTMLButtonElement): Promise<void> {
  if (!svgEl) return
  cerrarEditor()
  const txt = btn?.textContent
  if (btn) { btn.disabled = true; btn.textContent = '…' }
  estado.textContent = 'Generando PDF…'
  const transp = peTransparente.checked
  const ocultados: SVGElement[] = []
  if (transp) for (const el of elementosFondoASangre()) { el.style.display = 'none'; ocultados.push(el) }
  const vb = svgEl.viewBox.baseVal
  const w = vb.width || 1080, h = vb.height || 1350
  const nombre = `${nombreArchivo()}.pdf`
  try {
    const { jsPDF } = await import('jspdf')
    const nuevoPdf = () => new jsPDF({ orientation: w >= h ? 'landscape' : 'portrait', unit: 'pt', format: [w, h] })
    try {
      const { svg2pdf } = await import('svg2pdf.js')
      const pdf = nuevoPdf()
      registrarFuentesPdf(pdf) // fuentes reales (Poppins, etc.) antes de vectorizar
      await svg2pdf(svgEl, pdf, { x: 0, y: 0, width: w, height: h })
      pdf.save(nombre)
      estado.textContent = 'PDF exportado (vectorial).'
    } catch (eVec) {
      console.warn('PDF vectorial falló (probable foto embebida); uso PDF imagen:', eVec)
      const s = new XMLSerializer().serializeToString(svgEl)
      const ancho = Math.round(Math.min(2480, Math.max(1080, w)))
      const png = await renderResvg(s, facesPack.map((f) => f.bytes), ancho)
      const dataUrl = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.onerror = rej; fr.readAsDataURL(png) })
      const pdf = nuevoPdf()
      pdf.addImage(dataUrl, 'PNG', 0, 0, w, h)
      pdf.save(nombre)
      estado.textContent = 'PDF exportado (imagen).'
    }
  } catch (err) {
    estado.textContent = '❌ No se pudo generar el PDF'
    console.error('exportar PDF:', err)
  } finally {
    for (const el of ocultados) el.style.display = ''
    if (btn) { btn.disabled = false; btn.textContent = txt ?? '⬇ PDF' }
  }
}
document.querySelector('#pe-svg')!.addEventListener('click', descargarSVG)
document.querySelector('#pe-pdf')!.addEventListener('click', (e) => void exportarPDF(e.currentTarget as HTMLButtonElement))
peCarrusel.addEventListener('click', () => void exportarCarrusel())
// Re-render al cambiar el modo transparente (si el panel ya está abierto).
peTransparente.addEventListener('change', () => { if (!panelExport.hidden) void exportarPNG() })

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

// Carrusel: renderiza la mesa ancha completa a PNG y la corta en N imágenes
// (una por slide), que se bajan en un ZIP (slide-1.png, slide-2.png…).
async function exportarCarrusel(): Promise<void> {
  if (!svgEl || carruselSlides < 2) return
  cerrarEditor()
  const n = carruselSlides
  estado.textContent = `Cortando carrusel en ${n} imágenes…`
  try {
    const svg = svgParaExportar(peTransparente.checked)
    const sliceWv = (svgEl.viewBox.baseVal.width || 1080) / n
    const objetivoSlide = Math.round(Math.min(2000, Math.max(1080, sliceWv)))
    const blobFull = await renderResvg(svg, facesPack.map((f) => f.bytes), objetivoSlide * n)
    const bmp = await createImageBitmap(blobFull)
    const sw = Math.round(bmp.width / n), sh = bmp.height
    const archivos: { nombre: string; datos: Uint8Array }[] = []
    for (let i = 0; i < n; i++) {
      const cv = document.createElement('canvas'); cv.width = sw; cv.height = sh
      cv.getContext('2d')!.drawImage(bmp, i * sw, 0, sw, sh, 0, 0, sw, sh)
      const b = await new Promise<Blob>((res) => cv.toBlob((x) => res(x!), 'image/png'))
      archivos.push({ nombre: `slide-${i + 1}.png`, datos: new Uint8Array(await b.arrayBuffer()) })
    }
    descargar(crearZip(archivos), `${nombreArchivo()}-carrusel.zip`)
    estado.textContent = `Carrusel exportado: ${n} imágenes (ZIP).`
  } catch (err) {
    estado.textContent = '❌ No se pudo exportar el carrusel'
    console.error('exportarCarrusel:', err)
  }
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
  a.download = `${nombreArchivo()}-mesas.zip`
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
  modoEdicion?: ModoEdicion // 'completa' | 'plantilla' (opcional: saves viejos → completa)
  guias?: { v: number[]; h: number[] } // guías fijas por mesa (unidades del viewBox)
  carrusel?: { slides: number } // si está, la mesa es un carrusel ancho: se corta en N slides al exportar
}

function snapshotProyecto(): Proyecto {
  return {
    v: 2,
    plantilla: plantillaActual,
    valores, estilos, bloqueado, cajaAlto, metricas,
    fotos, encuadres,
    contador: contadorAgregados,
    svg: svgEl ? new XMLSerializer().serializeToString(svgEl) : '',
    modoEdicion,
    guias: { v: [...guiasFijas.v], h: [...guiasFijas.h] },
    carrusel: carruselSlides >= 2 ? { slides: carruselSlides } : undefined,
  }
}

// Aplica un snapshot al DOM y estado (sin tocar el historial).
async function aplicarSnapshot(p: Proyecto): Promise<void> {
  cerrarEditor()
  desactivarPluma(); desactivarNodos(); cerrarEditorPuntos()
  plantillaActual = p.plantilla
  if ([...selPlantilla.options].some((o) => o.value === p.plantilla)) selPlantilla.value = p.plantilla
  valores = p.valores ?? {}
  estilos = p.estilos ?? {}
  bloqueado = p.bloqueado ?? {}
  cajaAlto = p.cajaAlto ?? {}
  cajaManual = {}
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
  modoEdicion = p.modoEdicion ?? 'completa'
  guiasFijas = p.guias ? { v: [...(p.guias.v ?? [])], h: [...(p.guias.h ?? [])] } : { v: [], h: [] }
  carruselSlides = p.carrusel?.slides ?? 0
  mesaResizeActivo = false // cada mesa arranca sin los tiradores de tamaño activos

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
  grafSeleccion = []
  limpiarGraf()

  suprimirHistorial = true
  aplicarModo() // re-engancha la capa de selección al nuevo svg + fija modo + overlays
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
async function agregarMesa(duplicar: boolean, anchoNuevo?: number, altoNuevo?: number): Promise<void> {
  guardarMesaActiva(); guardarHistorialActivo()
  const w = anchoNuevo ?? (svgEl ? Math.round(svgEl.viewBox.baseVal.width) : 1080)
  const h = altoNuevo ?? (svgEl ? Math.round(svgEl.viewBox.baseVal.height) : 1080)
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
  const add = document.createElement('button'); add.id = 'btn-nueva-mesa'; add.className = 'mesa-btn'; add.textContent = '＋'; add.title = 'Nueva mesa'
  add.addEventListener('click', (e) => { e.stopPropagation(); abrirNuevaMesa(add) })
  const dup = document.createElement('button'); dup.className = 'mesa-btn'; dup.textContent = '⧉'; dup.title = 'Duplicar mesa actual'
  dup.addEventListener('click', () => void agregarMesa(true))
  const tam = document.createElement('button'); tam.id = 'btn-tamano'; tam.className = 'mesa-btn'; tam.textContent = '📐'; tam.title = 'Tamaño de la mesa de trabajo'
  tam.addEventListener('click', (e) => { e.stopPropagation(); togglePanelTamano() })
  tira.append(add, dup, tam)
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
      guardarReciente(json)
    } catch { /* quota: ignorar */ }
  }, 600)
}

// ---------------------------------------------------------------
//  Proyectos recientes (lista por id + datos por proyecto)
// ---------------------------------------------------------------
const LS_RECIENTES = 'gastonart-recientes'
const MAX_RECIENTES = 6
interface Reciente { id: string; nombre: string; fecha: number; thumb: string }
let proyectoActualId: string | null = null
function genIdProyecto(): string { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7) }
function leerRecientes(): Reciente[] {
  try { return JSON.parse(localStorage.getItem(LS_RECIENTES) || '[]') as Reciente[] } catch { return [] }
}
// Arranca un proyecto NUEVO: id propio + nombre en blanco (lo nombra el usuario).
function nuevoProyecto(): void {
  proyectoActualId = genIdProyecto()
  inNombre.value = ''
  carruselSlides = 0 // por defecto el proyecto nuevo no es carrusel
  try { localStorage.setItem('gastonart-nombre', '') } catch { /* ignorar */ }
}
// Guarda/actualiza el proyecto actual en la lista de recientes (datos por id,
// con miniatura). Maneja la cuota expulsando los más viejos.
function guardarReciente(json: string): void {
  if (!proyectoActualId) proyectoActualId = genIdProyecto()
  const svgMini = mesas.length ? (mesas[mesaActiva]?.svg || '') : (svgEl ? new XMLSerializer().serializeToString(svgEl) : '')
  const thumb = svgMini ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(miniaturaSvg(svgMini)) : ''
  let lista = leerRecientes().filter((r) => r.id !== proyectoActualId)
  lista.unshift({ id: proyectoActualId, nombre: (inNombre.value || '').trim(), fecha: Date.now(), thumb })
  for (const sob of lista.slice(MAX_RECIENTES)) { try { localStorage.removeItem('gastonart-proy-' + sob.id) } catch { /* ignorar */ } }
  lista = lista.slice(0, MAX_RECIENTES)
  const guardarDatos = () => localStorage.setItem('gastonart-proy-' + proyectoActualId, json)
  try { guardarDatos() } catch {
    // Cuota: ir descartando los más viejos hasta que entre.
    while (lista.length > 1) { const v = lista.pop()!; try { localStorage.removeItem('gastonart-proy-' + v.id) } catch { /* */ } try { guardarDatos(); break } catch { /* sigue */ } }
  }
  try { localStorage.setItem(LS_RECIENTES, JSON.stringify(lista)) } catch { /* ignorar */ }
}

document.querySelector('#btn-guardar')!.addEventListener('click', () => {
  cerrarEditor()
  guardarMesaActiva()
  const data = mesas.length ? { multi: true, mesaActiva, mesas } : snapshotProyecto()
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${nombreArchivo()}.gastonart.json`
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
document.querySelector('#btn-nuevo')!.addEventListener('click', () => {
  // Si el proyecto actual tiene cambios pero NO tiene nombre, avisar antes de salir.
  if (proyectoActualId && !inNombre.value.trim() && histIdx > 0 &&
      !confirm('Este proyecto no tiene nombre. ¿Salir igual? Va a quedar en "Recientes" como «Sin nombre».')) return
  mostrarInicio()
})
document.querySelector('#btn-deshacer')!.addEventListener('click', () => void deshacer())
document.querySelector('#btn-rehacer')!.addEventListener('click', () => void rehacer())

// --- Menú "Archivo" (agrupa Nuevo/Guardar/Cargar/Plantilla/Importar fuente) ---
const menuArchivo = document.querySelector<HTMLDivElement>('#menu-archivo')!
const btnMenu = document.querySelector<HTMLButtonElement>('#btn-menu')!
btnMenu.addEventListener('click', (e) => { e.stopPropagation(); menuArchivo.hidden = !menuArchivo.hidden })
menuArchivo.addEventListener('click', () => { menuArchivo.hidden = true }) // cerrar tras elegir
document.addEventListener('pointerdown', (e) => {
  if (menuArchivo.hidden) return
  const t = e.target as Element | null
  if (t && !t.closest('.tb-menu-wrap')) menuArchivo.hidden = true
}, true)

// --- Nombre del proyecto (editable en la barra; se usa para los archivos) ---
const inNombre = document.querySelector<HTMLInputElement>('#tb-nombre')!
inNombre.value = (() => { try { return localStorage.getItem('gastonart-nombre') || '' } catch { return '' } })()
inNombre.addEventListener('input', () => { try { localStorage.setItem('gastonart-nombre', inNombre.value) } catch { /* quota */ } })
// Nombre de archivo (proyecto > plantilla), saneado.
function nombreArchivo(): string {
  const n = (inNombre.value || '').trim() || nombreCorto(plantillaActual) || 'diseño'
  return n.replace(/[^\w\dáéíóúñÁÉÍÓÚÑ .-]+/g, '_').trim() || 'diseño'
}
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
  nuevoProyecto() // proyecto nuevo: id propio + nombre en blanco
  svgActual = svgEnBlanco(w, h, fondo)
  plantillaActual = `enblanco-${w}x${h}`
  valores = {}; estilos = {}; fotos = {}; encuadres = {}; fotoActiva = null
  modoEdicion = 'completa' // lienzo en blanco: edición completa para armar desde cero
  void montarPlantilla().then(() => { estado.textContent = `Lienzo ${w}×${h} px` })
}

// Crea un carrusel: UNA mesa ancha (slideW × slides) que se diseña como una sola
// pieza continua, con guías marcando cada slide. Al exportar se corta en N imágenes.
function crearCarrusel(slideW: number, slideH: number, slides: number): void {
  nuevoProyecto()
  carruselSlides = slides
  svgActual = svgEnBlanco(slideW * slides, slideH)
  plantillaActual = `carrusel-${slideW}x${slideH}x${slides}`
  valores = {}; estilos = {}; fotos = {}; encuadres = {}; fotoActiva = null
  modoEdicion = 'completa'
  void montarPlantilla().then(() => { estado.textContent = `Carrusel: ${slides} slides de ${slideW}×${slideH}` })
}

// Núcleo del redimensionado: ajusta el viewBox y, si hay un rect de fondo que
// cubría toda la placa, lo reescala. NO toca display/historial (eso lo hace quien llama).
function setTamanoMesa(w: number, h: number): void {
  if (!svgEl) return
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
}

// Cambia el tamaño de la mesa actual (viewBox) preservando el contenido.
function redimensionarMesa(w: number, h: number): void {
  if (!svgEl) return
  cerrarEditor()
  setTamanoMesa(w, h)
  aplicarZoom() // recalcula el ancho de display + overlays con el nuevo viewBox
  registrarHistorial(); autoguardar()
  estado.textContent = `Mesa: ${w}×${h} px`
}

// Arrastre de un tirador del borde de la mesa: redimensiona en vivo (el lienzo
// crece/encoge a escala) y al soltar confirma + re-encaja. modo: 'e' ancho,
// 's' alto, 'se' ambos.
function arrastrarTamanoMesa(e: PointerEvent, modo: 'e' | 's' | 'se'): void {
  e.preventDefault(); e.stopPropagation()
  if (!svgEl) return
  cerrarEditor()
  const vb = svgEl.viewBox.baseVal
  const vbW0 = vb.width || 1080, vbH0 = vb.height || 1350
  const k0 = lienzo.clientWidth / vbW0 // px por unidad fijo durante el arrastre
  const x0 = e.clientX, y0 = e.clientY
  let w = vbW0, h = vbH0
  const onMove = (ev: PointerEvent) => {
    if (modo !== 's') w = Math.max(50, Math.round(vbW0 + (ev.clientX - x0) / k0))
    if (modo !== 'e') h = Math.max(50, Math.round(vbH0 + (ev.clientY - y0) / k0))
    setTamanoMesa(w, h)
    lienzo.style.width = Math.round(w * k0) + 'px' // display proporcional → arrastre visible
    construirOverlays()
    estado.textContent = `${w} × ${h} px`
  }
  const onUp = () => {
    document.removeEventListener('pointermove', onMove)
    aplicarZoom() // re-encaja al ancho fijo del escenario
    registrarHistorial(); autoguardar()
    estado.textContent = `Mesa: ${w}×${h} px`
  }
  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onUp, { once: true })
}

// Monta una plantilla del paquete por su clave (ruta).
function usarPlantilla(ruta: string): void {
  nuevoProyecto() // proyecto nuevo: id propio + nombre en blanco
  plantillaActual = ruta
  svgActual = plantillas[ruta]
  if ([...selPlantilla.options].some((o) => o.value === ruta)) selPlantilla.value = ruta
  valores = {}; estilos = {}; fotos = {}; encuadres = {}; fotoActiva = null
  modoEdicion = 'plantilla' // elegir una plantilla → arranca en modo plantilla (a prueba de toques)
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
  nuevoProyecto() // proyecto nuevo: id propio + nombre en blanco
  plantillaActual = registrarPlantilla(nombre, texto)
  svgActual = texto
  selPlantilla.value = plantillaActual
  valores = {}; estilos = {}; fotos = {}; encuadres = {}; fotoActiva = null
  void montarPlantilla()
}

function cerrarInicio(): void {
  document.querySelector('#pantalla-inicio')?.remove()
}

// SVG liviano para la MINIATURA de la pantalla de inicio: las <image> embebidas
// (fotos en base64) pesan MB y un <img src=data:svg> no las renderiza. Se
// reemplazan por un rect gris (placeholder de foto) conservando posición/recorte;
// el resto (texto/vectores/fondo) alcanza para reconocer el diseño.
function miniaturaSvg(svg: string): string {
  return svg.replace(/<image\b([^>]*)>(\s*<\/image>)?/gi, (_m, attrs: string) => {
    const limpio = attrs.replace(/\/\s*$/, '').replace(/\s(?:xlink:href|href)\s*=\s*"[^"]*"/gi, '')
    return `<rect${limpio} fill="#d4d7dd"/>`
  })
}

function mostrarInicio(): void {
  cerrarInicio()
  const grupos = [...new Set(PRESETS_TAMANO.map((p) => p.grupo))]
  const seccionesTamano = grupos.map((g) => `
    <div class="ini-grupo-tit">${g}</div>
    <div class="ini-presets">
      ${PRESETS_TAMANO.filter((p) => p.grupo === g).map((p) =>
        `<button class="ini-preset" data-w="${p.w}" data-h="${p.h}">
           <span class="ini-preset-top">
             <span class="ini-preset-nom">${escAttr(p.nombre)}</span>
             ${iconoProporcion(p.w, p.h)}
           </span>
           <span class="ini-preset-dim">${p.w}×${p.h}</span>
         </button>`).join('')}
    </div>`).join('')

  const opcionesPlantilla = rutasPlantilla.map((r) => {
    const svg = plantillas[r] || ''
    const thumb = svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(miniaturaSvg(svg))}` : ''
    return `<span class="ini-plantilla-wrap">
      <button class="ini-plantilla" data-ruta="${escAttr(r)}">
        <span class="ini-plantilla-thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : ''}</span>
        <span class="ini-plantilla-nom">${escAttr(nombreCorto(r))}</span>
      </button>
      <button class="ini-plantilla-del" data-ruta="${escAttr(r)}" title="Borrar plantilla">✕</button>
    </span>`
  }).join('')

  // ¿Hay un trabajo guardado para ofrecer "Seguir editando"?
  const autosave = (() => { try { const g = localStorage.getItem('gastonart-proyecto'); return g && g.length <= 4_000_000 ? g : null } catch { return null } })()
  const seguirHtml = autosave ? `<button id="ini-seguir" class="ini-btn-acc ini-seguir">▶ Seguir editando lo último</button>` : ''

  // Proyectos recientes (guardados automáticamente).
  const recientes = leerRecientes()
  const recientesHtml = recientes.length ? `
      <section class="ini-seccion">
        <h3>Proyectos recientes</h3>
        <div class="ini-plantillas">
          ${recientes.map((r) => `<span class="ini-plantilla-wrap">
            <button class="ini-reciente" data-id="${escAttr(r.id)}" title="Abrir «${escAttr(r.nombre || 'Sin nombre')}»">
              <span class="ini-plantilla-thumb">${r.thumb ? `<img src="${escAttr(r.thumb)}" alt="" loading="lazy">` : ''}</span>
              <span class="ini-plantilla-nom">${escHtml(r.nombre || 'Sin nombre')}</span>
            </button>
            <button class="ini-reciente-del" data-id="${escAttr(r.id)}" title="Quitar de recientes">✕</button>
          </span>`).join('')}
        </div>
      </section>` : ''

  const ov = document.createElement('div')
  ov.id = 'pantalla-inicio'
  ov.innerHTML = `
    <div class="ini-wrap">
      <div class="ini-head">
        <strong>GastonART</strong>
        <span>¿Cómo querés empezar?</span>
        <button id="ini-cerrar" class="mini" title="Cerrar">✕</button>
      </div>
      ${recientesHtml}
      <section class="ini-seccion">
        <h3>Imagen en blanco</h3>
        ${seccionesTamano}
        <div class="ini-grupo-tit">Personalizado</div>
        <div class="ini-custom">
          <input type="number" id="ini-w" min="0.1" max="20000" step="any" value="1080" aria-label="Ancho"> ×
          <input type="number" id="ini-h" min="0.1" max="20000" step="any" value="1080" aria-label="Alto">
          <select id="ini-unidad" class="unidad-sel" aria-label="Unidad">
            <option value="px">px</option>
            <option value="mm">mm</option>
            <option value="cm">cm</option>
          </select>
          <button id="ini-crear-custom" class="ini-btn-acc">Crear</button>
        </div>
      </section>
      <section class="ini-seccion">
        <h3>Carrusel para redes</h3>
        <p class="ini-nota" style="margin:0 0 8px">Una sola mesa ancha para diseñar el carrusel de corrido. Al exportar se corta en una imagen por slide.</p>
        <div class="carr-formatos">
          ${[['1080x1080', 'Cuadrado', 1080, 1080], ['1080x1350', 'Retrato', 1080, 1350], ['1080x1920', 'Story', 1080, 1920]]
            .map(([tam, nom, w, h], i) => `<button class="carr-fmt${i === 0 ? ' activo' : ''}" data-tam="${tam}">
              ${iconoProporcion(w as number, h as number)}
              <span class="carr-fmt-nom">${nom}</span>
              <span class="carr-fmt-dim">${w}×${h}</span>
            </button>`).join('')}
        </div>
        <div class="ini-custom">
          <input type="number" id="ini-carr-n" min="2" max="20" step="1" value="3" aria-label="Cantidad de slides">
          <span>slides</span>
          <button id="ini-crear-carr" class="ini-btn-acc">Crear carrusel</button>
        </div>
      </section>
      <section class="ini-seccion">
        ${seguirHtml}
        <h3>Plantillas y guardados</h3>
        <div class="ini-plantillas">${opcionesPlantilla}</div>
        <h3 style="margin-top:18px">Cargar multimedia</h3>
        <button id="ini-cargar-svg" class="ini-btn-acc">Subir imagen, SVG o PDF…</button>
        <p class="ini-nota">Cualquier imagen, SVG o PDF entra al editor. Después podés <strong>guardarlo como plantilla</strong> con el botón “Plantilla” de la barra superior.</p>
      </section>
    </div>`
  document.body.appendChild(ov)

  ov.querySelector('#ini-cerrar')!.addEventListener('click', () => cerrarInicio())
  ov.querySelectorAll<HTMLButtonElement>('.ini-preset').forEach((b) =>
    b.addEventListener('click', () => { cerrarInicio(); nuevaPlacaEnBlanco(+b.dataset.w!, +b.dataset.h!) }))
  // Selección del formato de carrusel (tarjetas tipo radio).
  ov.querySelectorAll<HTMLButtonElement>('.carr-fmt').forEach((b) =>
    b.addEventListener('click', () => {
      ov.querySelectorAll('.carr-fmt').forEach((x) => x.classList.remove('activo'))
      b.classList.add('activo')
    }))
  // Crear carrusel (mesa ancha que se corta al exportar).
  ov.querySelector('#ini-crear-carr')!.addEventListener('click', () => {
    const fmt = ov.querySelector<HTMLButtonElement>('.carr-fmt.activo') ?? ov.querySelector<HTMLButtonElement>('.carr-fmt')!
    const [sw, sh] = (fmt.dataset.tam || '1080x1080').split('x').map(Number)
    const n = Math.max(2, Math.min(20, Math.round(+ov.querySelector<HTMLInputElement>('#ini-carr-n')!.value || 3)))
    cerrarInicio(); crearCarrusel(sw, sh, n)
  })
  // Abrir un proyecto reciente.
  ov.querySelectorAll<HTMLButtonElement>('.ini-reciente').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.id!
      const raw = (() => { try { return localStorage.getItem('gastonart-proy-' + id) } catch { return null } })()
      if (!raw) { alert('No se encontró ese proyecto (puede haberse borrado por espacio).'); return }
      cerrarInicio()
      proyectoActualId = id
      const r = leerRecientes().find((x) => x.id === id)
      try { await restaurarGuardado(JSON.parse(raw)) } catch { estado.textContent = '❌ No se pudo abrir el proyecto'; return }
      inNombre.value = r?.nombre || ''
      try { localStorage.setItem('gastonart-nombre', inNombre.value) } catch { /* ignorar */ }
      estado.textContent = 'Proyecto abierto.'
    }))
  ov.querySelectorAll<HTMLButtonElement>('.ini-reciente-del').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      const id = b.dataset.id!
      try { localStorage.removeItem('gastonart-proy-' + id) } catch { /* ignorar */ }
      try { localStorage.setItem(LS_RECIENTES, JSON.stringify(leerRecientes().filter((x) => x.id !== id))) } catch { /* ignorar */ }
      mostrarInicio()
    }))
  // Unidades: px directo; mm/cm a 300 DPI (impresión). 1 in = 25.4 mm = 300 px.
  // pxPorUnidad = cuántos px vale 1 de la unidad.
  const pxPorUnidad = (u: string) => u === 'mm' ? 300 / 25.4 : u === 'cm' ? 3000 / 25.4 : 1
  const inpW = ov.querySelector<HTMLInputElement>('#ini-w')!
  const inpH = ov.querySelector<HTMLInputElement>('#ini-h')!
  const selU = ov.querySelector<HTMLSelectElement>('#ini-unidad')!
  let unidadPrev = selU.value
  // Al cambiar de unidad, convertir los valores actuales a la nueva medida.
  selU.addEventListener('change', () => {
    const factor = pxPorUnidad(unidadPrev) / pxPorUnidad(selU.value)
    const conv = (inp: HTMLInputElement) => {
      const v = (+inp.value || 0) * factor
      inp.value = String(selU.value === 'px' ? Math.round(v) : Math.round(v * 100) / 100)
    }
    conv(inpW); conv(inpH)
    unidadPrev = selU.value
  })
  ov.querySelector('#ini-crear-custom')!.addEventListener('click', () => {
    const aPx = (v: number) => Math.max(16, Math.min(20000, Math.round(v * pxPorUnidad(selU.value))))
    const w = aPx(+inpW.value || 1080)
    const h = aPx(+inpH.value || 1080)
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

// Pasa el bitmap/datos de una imagen de pdf.js a un <canvas> en su orientación
// correcta (fila 0 = arriba, sin voltear). Devuelve null si no hay datos.
function imagenPdfACanvas(obj: any): HTMLCanvasElement | null {
  const w = obj.width, h = obj.height
  if (!w || !h) return null
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const ctx = c.getContext('2d')!
  if (obj.bitmap) {
    ctx.drawImage(obj.bitmap, 0, 0, w, h)
  } else if (obj.data) {
    // obj.kind: 1=GRAY_1BPP, 2=RGB_24BPP, 3=RGBA_32BPP. Convertir a RGBA.
    const src = obj.data as Uint8ClampedArray
    const out = new Uint8ClampedArray(w * h * 4)
    if (obj.kind === 3) { out.set(src) }
    else if (obj.kind === 2) { for (let i = 0, j = 0; i < src.length; i += 3, j += 4) { out[j] = src[i]; out[j + 1] = src[i + 1]; out[j + 2] = src[i + 2]; out[j + 3] = 255 } }
    else { for (let i = 0, j = 0; i < src.length; i++, j += 4) { out[j] = out[j + 1] = out[j + 2] = src[i]; out[j + 3] = 255 } }
    ctx.putImageData(new ImageData(out, w, h), 0, 0)
  } else return null
  return c
}

// Importar un PDF como plantilla EDITABLE: extrae el texto (campos editables) y
// las imágenes (huecos reemplazables) y reconstruye un SVG. NO usa el render a
// canvas (que se cuelga en pestañas ocultas y no da nada editable). Limitación:
// los gráficos vectoriales puros del PDF (fondos de color, formas, líneas) NO se
// extraen y se pierden.
async function importarPDF(file: File): Promise<void> {
  estado.textContent = 'Abriendo PDF…'
  try {
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
    const page = await pdf.getPage(1)
    const vp = page.getViewport({ scale: 1 })
    const W = Math.round(vp.width), H = Math.round(vp.height)
    const Util = pdfjs.Util as any

    // --- Imágenes: recorrer la lista de operadores rastreando matriz (CTM) y
    // RECORTE (clip). En el PDF las fotos suelen ser más grandes que su área
    // visible y se recortan con un clip; sin aplicarlo, la imagen se desborda.
    const ol = await page.getOperatorList()
    const OPS = pdfjs.OPS as any
    const nombreOp: Record<number, string> = {}
    for (const k in OPS) nombreOp[OPS[k]] = k
    const piezasGraf: string[] = [] // vectores + imágenes, en orden de pintado (z)
    const colSeq: string[] = [] // color de relleno de cada showText, en orden (para el texto)
    let m: number[] = [1, 0, 0, 1, 0, 0]
    let clip: number[] = [0, 0, W, H] // recorte activo en coords del viewport (x0,y0,x1,y1)
    let fill = '#000000', stroke = '#000000', lw = 1 // estado de color/grosor
    const pilaM: number[][] = []
    const pilaC: number[][] = []
    const pilaE: Array<[string, string, number]> = [] // estado de color/grosor (q/Q lo guarda)
    // DrawOPS de pdf.js: 0 moveTo, 1 lineTo, 2 curveTo(6), 3 quadTo(4), 4 close.
    const pathADStr = (buf: any): string => {
      const tm = Util.transform(vp.transform, m)
      const ap = (x: number, y: number) => r2(tm[0] * x + tm[2] * y + tm[4]) + ' ' + r2(tm[1] * x + tm[3] * y + tm[5])
      let d = ''
      for (let k = 0; k < buf.length;) {
        const o = buf[k++]
        if (o === 0) d += 'M' + ap(buf[k++], buf[k++]) + ' '
        else if (o === 1) d += 'L' + ap(buf[k++], buf[k++]) + ' '
        else if (o === 2) d += 'C' + ap(buf[k++], buf[k++]) + ' ' + ap(buf[k++], buf[k++]) + ' ' + ap(buf[k++], buf[k++]) + ' '
        else if (o === 3) d += 'Q' + ap(buf[k++], buf[k++]) + ' ' + ap(buf[k++], buf[k++]) + ' '
        else if (o === 4) d += 'Z '
        else break
      }
      return d.trim()
    }
    // El clip de un path se puede emitir en dos órdenes según quién generó el PDF:
    //   A) clip, constructPath(rect)  — Illustrator/InDesign
    //   B) constructPath(rect), clip  — jsPDF y otros
    let clipPendiente = false       // (A) vimos `clip`, falta el path
    let ultimoPathBbox: number[] | null = null // bbox del último constructPath
    let ultimoPathD: string | null = null // `d` (device) del último path SI tiene curvas
    let ultimoEsPath = false        // ¿la op anterior fue constructPath? (para B)
    // Clip con forma NO rectangular (curva): se aplica como <clipPath> a la imagen
    // (recortar al bbox aplastaría una esquina redondeada a recta).
    let clipPathD: string | null = null
    const pilaCP: (string | null)[] = []
    let nClip = 0, nGrad = 0
    const bufTieneCurvas = (buf: any): boolean => {
      for (let k = 0; k < buf.length;) { const o = buf[k++]; if (o === 2 || o === 3) return true; k += [2, 2, 6, 4, 0][o] || 0 }
      return false
    }
    // mm puede ser Array o Float32Array (no usar Array.isArray, falla con typed).
    const minMaxOk = (mm: any): boolean => !!mm && mm.length === 4 && Number.isFinite(mm[0]) && Number.isFinite(mm[2])
    const bboxDeMinMax = (mm: number[]): number[] => {
      const tm = Util.transform(vp.transform, m)
      const ap = (px: number, py: number) => [tm[0] * px + tm[2] * py + tm[4], tm[1] * px + tm[3] * py + tm[5]]
      const c = [ap(mm[0], mm[1]), ap(mm[2], mm[1]), ap(mm[2], mm[3]), ap(mm[0], mm[3])]
      const xs = c.map((p) => p[0]), ys = c.map((p) => p[1])
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    }
    const intersecar = (a: number[], b: number[]): number[] =>
      [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i], a = ol.argsArray[i] as any
      const prevEsPath = ultimoEsPath
      ultimoEsPath = (fn === OPS.constructPath)
      if (fn === OPS.save) { pilaM.push(m.slice()); pilaC.push(clip.slice()); pilaE.push([fill, stroke, lw]); pilaCP.push(clipPathD) }
      else if (fn === OPS.restore) { m = pilaM.pop() || m; clip = pilaC.pop() || clip; const e = pilaE.pop(); if (e) { fill = e[0]; stroke = e[1]; lw = e[2] }; if (pilaCP.length) clipPathD = pilaCP.pop()! }
      else if (fn === OPS.transform) m = Util.transform(m, a)
      else if (fn === OPS.setFillRGBColor) { if (typeof a[0] === 'string') fill = a[0] }
      else if (fn === OPS.setStrokeRGBColor) { if (typeof a[0] === 'string') stroke = a[0] }
      else if (fn === OPS.setLineWidth) { lw = a[0] }
      else if (fn === OPS.showText) { colSeq.push(fill) } // color del texto, en orden
      else if (fn === OPS.shadingFill) {
        // Degradé (p.ej. el badge detrás de un logo). Se reconstruye como
        // <linearGradient>/<radialGradient> SVG sobre la forma del recorte activo.
        let sh: any = null
        try { sh = page.objs.get(a[0]) } catch { sh = null }
        const stops = sh && sh[3]
        if (Array.isArray(stops) && stops.length) {
          const tm = Util.transform(vp.transform, m)
          const ap = (px: number, py: number) => [tm[0] * px + tm[2] * py + tm[4], tm[1] * px + tm[3] * py + tm[5]]
          const p0 = ap((sh[4] && sh[4][0]) || 0, (sh[4] && sh[4][1]) || 0)
          const p1 = ap((sh[5] && sh[5][0]) || 1, (sh[5] && sh[5][1]) || 0)
          const id = `pdfgrad${nGrad++}`
          const stopsXml = stops.map((s: any) => `<stop offset="${r2(s[0])}" stop-color="${s[1]}"/>`).join('')
          const grad = `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${r2(p0[0])}" y1="${r2(p0[1])}" x2="${r2(p1[0])}" y2="${r2(p1[1])}">${stopsXml}</linearGradient>`
          const forma = clipPathD
            ? `<path d="${clipPathD}" fill="url(#${id})"/>`
            : `<rect x="${r2(clip[0])}" y="${r2(clip[1])}" width="${r2(clip[2] - clip[0])}" height="${r2(clip[3] - clip[1])}" fill="url(#${id})"/>`
          piezasGraf.push(grad + forma)
        }
      }
      else if (fn === OPS.clip || fn === OPS.eoClip) {
        if (prevEsPath && ultimoPathBbox) { clip = intersecar(clip, ultimoPathBbox); if (ultimoPathD) clipPathD = ultimoPathD } // (B)
        else clipPendiente = true // (A)
      }
      else if (fn === OPS.constructPath) {
        ultimoPathBbox = minMaxOk(a[2]) ? bboxDeMinMax(a[2]) : null
        // `d` del path solo si tiene curvas (para clips redondeados); evita decodificar de más.
        const buf0 = Array.isArray(a[1]) && a[1][0]
        ultimoPathD = (buf0 && buf0.length && bufTieneCurvas(buf0)) ? a[1].map((b: any) => (b && b.length ? pathADStr(b) : '')).filter(Boolean).join(' ') : null
        if (clipPendiente && ultimoPathBbox) { clip = intersecar(clip, ultimoPathBbox); if (ultimoPathD) clipPathD = ultimoPathD; clipPendiente = false } // (A)
        // Emitir el trazo como <path> si la operación lo pinta (fill/stroke).
        const nom = nombreOp[a[0]] || ''
        const haceFill = /fill/i.test(nom), haceStroke = /stroke/i.test(nom)
        if ((haceFill || haceStroke) && Array.isArray(a[1])) {
          const d = a[1].map((b: any) => (b && b.length ? pathADStr(b) : '')).filter(Boolean).join(' ')
          if (d) {
            const tm = Util.transform(vp.transform, m)
            const esc = Math.sqrt(Math.abs(tm[0] * tm[3] - tm[1] * tm[2])) || 1
            const attrs = [
              `d="${d}"`,
              `fill="${haceFill ? fill : 'none'}"`,
              /eo/i.test(nom) && haceFill ? 'fill-rule="evenodd"' : '',
              haceStroke ? `stroke="${stroke}" stroke-width="${r2(lw * esc)}"` : '',
            ].filter(Boolean).join(' ')
            piezasGraf.push(`<path ${attrs}/>`)
          }
        }
      }
      else if (fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject) {
        const nombre = a[0]
        const obj = await new Promise<any>((res) => { try { page.objs.get(nombre, res) } catch { res(null) } }).catch(() => null)
        const fuente = obj ? imagenPdfACanvas(obj) : null
        if (!fuente) continue
        // bbox de la imagen completa (cuadrado unidad [0,1]² por vp∘CTM).
        const tm = Util.transform(vp.transform, m)
        const ap = (px: number, py: number) => [tm[0] * px + tm[2] * py + tm[4], tm[1] * px + tm[3] * py + tm[5]]
        const pts = [ap(0, 0), ap(1, 0), ap(1, 1), ap(0, 1)]
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
        const ib = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
        // Área visible = imagen ∩ clip. Si queda vacía, la imagen está oculta.
        const vis = intersecar(ib, clip)
        const vw = vis[2] - vis[0], vh = vis[3] - vis[1]
        if (vw < 1 || vh < 1) continue
        // Recortar el bitmap a la fracción visible del bbox completo.
        const fx0 = (vis[0] - ib[0]) / (ib[2] - ib[0]), fy0 = (vis[1] - ib[1]) / (ib[3] - ib[1])
        const fx1 = (vis[2] - ib[0]) / (ib[2] - ib[0]), fy1 = (vis[3] - ib[1]) / (ib[3] - ib[1])
        const sx = fx0 * fuente.width, sy = fy0 * fuente.height
        const sw = (fx1 - fx0) * fuente.width, sh = (fy1 - fy0) * fuente.height
        const rec = document.createElement('canvas')
        rec.width = Math.max(1, Math.round(sw)); rec.height = Math.max(1, Math.round(sh))
        rec.getContext('2d')!.drawImage(fuente, sx, sy, sw, sh, 0, 0, rec.width, rec.height)
        const dataUrl = rec.toDataURL('image/png')
        // Si el recorte tiene forma curva, aplicarlo como <clipPath> (coords device).
        let clipAttr = '', clipDef = ''
        if (clipPathD) { const id = `pdfclip${nClip++}`; clipDef = `<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${clipPathD}"/></clipPath>`; clipAttr = ` clip-path="url(#${id})"` }
        // data-agregado="imagen" → la imagen es un elemento EDITABLE (mover/escalar/
        // borrar/editar/quitar fondo/máscara), no un hueco de foto reemplazable.
        piezasGraf.push(`${clipDef}<image data-agregado="imagen" x="${r2(vis[0])}" y="${r2(vis[1])}" width="${r2(vw)}" height="${r2(vh)}" preserveAspectRatio="none"${clipAttr} href="${dataUrl}" xlink:href="${dataUrl}"/>`)
      }
    }

    // --- Texto: cada item → un <text> editable (estructura de agregarTexto) ---
    const tc = await page.getTextContent()
    // getTextContent solo da "sans-serif"; el nombre REAL (p.ej. Poppins-SemiBold)
    // está en el objeto de fuente. Lo parseamos a familia + peso + cursiva.
    const cacheFuente: Record<string, { fam: string; weight: number; italic: boolean; fb: string }> = {}
    const fuenteDe = (fontName: string) => {
      if (cacheFuente[fontName]) return cacheFuente[fontName]
      const fb = (tc.styles?.[fontName]?.fontFamily) || 'sans-serif' // fallback genérico
      let fam = fb, weight = 400, italic = false
      try {
        let nm: string = (page.commonObjs.get(fontName) as any)?.name || ''
        if (nm.includes('+')) nm = nm.split('+')[1] // sacar el prefijo de subset (CXIVHZ+)
        if (nm) {
          const suf = (nm.split('-')[1] || nm).toLowerCase()
          if (/thin/.test(suf)) weight = 100
          else if (/extralight|ultralight/.test(suf)) weight = 200
          else if (/light/.test(suf)) weight = 300
          else if (/medium/.test(suf)) weight = 500
          else if (/semibold|demibold/.test(suf)) weight = 600
          else if (/extrabold|ultrabold/.test(suf)) weight = 800
          else if (/black|heavy/.test(suf)) weight = 900
          else if (/bold/.test(suf)) weight = 700
          italic = /italic|oblique/.test(nm.toLowerCase())
          fam = nm.split('-')[0].replace(/([a-z])([A-Z])/g, '$1 $2') // "PoppinsSemiBold"→"Poppins"
        }
      } catch { /* fuente no resuelta: usar fallback */ }
      return (cacheFuente[fontName] = { fam, weight, italic, fb })
    }
    // 1) Cada item de pdf.js suele ser UNA línea. Las juntamos en objetos línea.
    type Linea = { x: number; y: number; fs: number; fontName: string; col: string; str: string }
    const lineas: Linea[] = []
    let ci = 0 // índice para emparejar cada línea con su color (showText en orden)
    for (const it of tc.items as any[]) {
      if (!it.str || !it.str.trim()) continue
      const tm = Util.transform(vp.transform, it.transform)
      const fs = Math.hypot(tm[2], tm[3]) // tamaño de fuente en unidades del viewport
      const col = colSeq[ci++] || '#111'
      if (fs < 1) continue
      lineas.push({ x: tm[4], y: tm[5], fs, fontName: it.fontName, col, str: it.str })
    }
    // 2) Agrupar líneas consecutivas del MISMO párrafo (misma fuente/tamaño/color,
    //    misma x de inicio y separadas ~1 interlínea) en un solo bloque de texto.
    type Parrafo = { x: number; y0: number; yPrev: number; lh: number | null; fs: number; fontName: string; col: string; lineas: string[] }
    const parrafos: Parrafo[] = []
    for (const ln of lineas) {
      const g = parrafos[parrafos.length - 1]
      const gap = g ? ln.y - g.yPrev : 0
      const sigue = g && ln.fontName === g.fontName && Math.abs(ln.fs - g.fs) < 0.15 * g.fs &&
        ln.col === g.col && Math.abs(ln.x - g.x) < Math.max(3, 0.4 * g.fs) &&
        gap > 0.4 * g.fs && gap < 2.4 * g.fs
      if (sigue) { if (g!.lh == null) g!.lh = gap; g!.lineas.push(ln.str); g!.yPrev = ln.y }
      else parrafos.push({ x: ln.x, y0: ln.y, yPrev: ln.y, lh: null, fs: ln.fs, fontName: ln.fontName, col: ln.col, lineas: [ln.str] })
    }
    // 3) Emitir cada párrafo como UN <text> multilínea (data-corrido → al editar
    //    fluye de corrido, no como líneas sueltas).
    const piezasTxt: string[] = []
    for (const p of parrafos) {
      const f = fuenteDe(p.fontName)
      const lh = p.lh || p.fs * 1.2
      const estilo = `font-family:'${escAttr(f.fam)}', ${escAttr(f.fb)};font-weight:${f.weight};` +
        (f.italic ? 'font-style:italic;' : '') + `font-size:${r2(p.fs)}px;fill:${p.col}`
      const tspans = p.lineas.map((s, i) => i === 0
        ? `<tspan x="0" y="0">${escHtml(s)}</tspan>`
        : `<tspan x="0" dy="${r2(lh)}">${escHtml(s)}</tspan>`).join('')
      piezasTxt.push(`<text data-corrido="1" transform="translate(${r2(p.x)} ${r2(p.y0)})" style="${estilo}">${tspans}</text>`)
    }

    if (!piezasTxt.length && !piezasGraf.length) throw new Error('PDF sin contenido extraíble')

    // Vectores + imágenes primero (fondo/decoración), texto editable ENCIMA.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="${XLINK}" viewBox="0 0 ${W} ${H}">` +
      `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>` +
      piezasGraf.join('') + piezasTxt.join('') + `</svg>`
    modoEdicion = 'completa' // PDF importado: edición completa
    usarSvgImportado(svg, file.name.replace(/\.pdf$/i, ''))
    const nImg = piezasGraf.filter((p) => p.startsWith('<image')).length
    estado.textContent = `PDF importado: ${piezasTxt.length} texto(s) editable(s), ${nImg} imagen(es), ${piezasGraf.length - nImg} vector(es). Tocá un texto para editarlo.`
  } catch (err) {
    estado.textContent = '❌ No se pudo abrir el PDF'
    console.error('importar PDF:', err)
  }
}

// Multimedia subida desde la pantalla de inicio: una imagen entra como una placa
// del tamaño de la imagen, con la foto a sangre (editable / se puede guardar como
// plantilla). PDF → importarPDF; SVG → usarSvgImportado.
async function crearPlacaDesdeMultimedia(file: File): Promise<void> {
  const foto = await leerFoto(file)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="${XLINK}" viewBox="0 0 ${foto.w} ${foto.h}">` +
    `<image x="0" y="0" width="${foto.w}" height="${foto.h}" href="${foto.dataUrl}" xlink:href="${foto.dataUrl}"/></svg>`
  modoEdicion = 'completa'
  usarSvgImportado(svg, file.name.replace(/\.[^.]+$/, ''))
  estado.textContent = `Multimedia cargada: ${file.name}`
}

const inSvgPlantilla = document.querySelector<HTMLInputElement>('#in-svg-plantilla')!
inSvgPlantilla.addEventListener('change', async () => {
  const file = inSvgPlantilla.files?.[0]
  if (file) {
    cerrarInicio()
    try {
      // .ai moderno es PDF por dentro → mismo camino que el PDF.
      if (/\.(pdf|ai)$/i.test(file.name) || file.type === 'application/pdf') await importarPDF(file)
      else if (/\.svg$/i.test(file.name) || file.type === 'image/svg+xml') usarSvgImportado(await file.text(), file.name)
      else if (file.type.startsWith('image/')) await crearPlacaDesdeMultimedia(file)
      else usarSvgImportado(await file.text(), file.name)
    } catch (e) { estado.textContent = '❌ ' + (e instanceof Error ? e.message : String(e)) }
  }
  inSvgPlantilla.value = ''
})

// ============ Zoom del lienzo (mesa de trabajo) ============
// El zoom cambia el ANCHO DE DISPLAY del lienzo (no un transform), así el factor
// k y los overlays se recalculan correctos. 100% = ajustado a la vista.
let zoomLienzo = 1
const escenario = document.querySelector<HTMLDivElement>('#escenario')!
const zoomVal = document.querySelector<HTMLButtonElement>('#zoom-val')!

// Clic en la mesa de trabajo (gris) FUERA del artboard → deselecciona: se va la
// barra flotante y los tiradores del elemento. La barra (en <body>) no burbujea
// por acá, así que clickearla no deselecciona.
escenario.addEventListener('pointerdown', (e) => {
  const t = e.target as Element
  if (t.closest('#lienzo') || t.closest('.graf-tools')) return
  if (editorActivo) cerrarEditor()
  if (grafSeleccion.length) { grafSeleccion = []; limpiarGraf() }
})
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
document.querySelector('#btn-reglas')!.addEventListener('click', toggleReglas)
// Recortar a la mesa: el svg pasa a overflow:hidden → lo que sobresale no se ve.
document.querySelector('#btn-recorte')!.addEventListener('click', (e) => {
  const on = lienzo.classList.toggle('recortar')
  ;(e.currentTarget as HTMLElement).classList.toggle('activo', on)
})
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

// Escapa el CONTENIDO de un elemento (texto entre tags).
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Redondea a 2 decimales para coords/atributos del SVG (evita ruido de floats).
function r2(n: number): number {
  return Math.round(n * 100) / 100
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
  // último trabajo, si existe, se ofrece desde ahí ("Seguir editando"). Detrás
  // va un lienzo EN BLANCO (no una plantilla del pack), para que no aparezca una
  // "plantilla fantasma" al fondo mientras se elige cómo empezar.
  svgActual = svgEnBlanco(1080, 1350)
  await montarPlantilla()
  mostrarInicio()
})()
