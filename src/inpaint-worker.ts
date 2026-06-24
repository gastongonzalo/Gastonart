// Worker de relleno con IA (MI-GAN). Corre la descarga del modelo y la inferencia
// FUERA del hilo principal, así la UI no se congela durante el procesamiento.
import * as ort from 'onnxruntime-web'

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/'
ort.env.wasm.numThreads = 1

const MODELO = 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx'
let sesionP: Promise<ort.InferenceSession> | null = null

const post = (m: unknown) => (self as unknown as Worker).postMessage(m)

async function cargar(): Promise<ort.InferenceSession> {
  if (!sesionP) sesionP = (async () => {
    post({ type: 'progress', etapa: 'Descargando modelo' })
    const resp = await fetch(MODELO)
    if (!resp.ok || !resp.body) throw new Error('No se pudo descargar el modelo (' + resp.status + ')')
    const total = +(resp.headers.get('content-length') || 0)
    const reader = resp.body.getReader()
    const chunks: Uint8Array[] = []; let recibido = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value); recibido += value.length
      post({ type: 'progress', etapa: 'Descargando modelo', frac: total ? recibido / total : undefined })
    }
    const buf = new Uint8Array(recibido); let off = 0
    for (const c of chunks) { buf.set(c, off); off += c.length }
    post({ type: 'progress', etapa: 'Iniciando' })
    return ort.InferenceSession.create(buf, { executionProviders: ['webgpu', 'wasm'] })
  })()
  return sesionP
}

interface MsgInpaint { type: 'inpaint'; img: Uint8Array; mask: Uint8Array; M: number }
;(self as unknown as Worker).onmessage = async (e: MessageEvent<MsgInpaint>) => {
  const msg = e.data
  if (!msg || msg.type !== 'inpaint') return
  try {
    const sesion = await cargar()
    post({ type: 'progress', etapa: 'Procesando' })
    const M = msg.M
    const feeds: Record<string, ort.Tensor> = {}
    feeds[sesion.inputNames[0]] = new ort.Tensor('uint8', msg.img, [1, 3, M, M])
    feeds[sesion.inputNames[1]] = new ort.Tensor('uint8', msg.mask, [1, 1, M, M])
    const out = await sesion.run(feeds)
    const o = Object.values(out)[0]
    post({ type: 'result', data: o.data, dims: o.dims, dtype: o.type })
  } catch (err) {
    post({ type: 'error', message: (err as Error)?.message || String(err) })
  }
}
