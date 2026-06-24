// onnxruntime-web 1.21.0 no expone sus typings vía package.json "exports" con
// moduleResolution "bundler", así que TS no los encuentra. Declaramos el módulo
// como `any` (solo se usa en el worker de inpaint, con casts internos).
declare module 'onnxruntime-web'
