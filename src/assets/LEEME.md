# Tus archivos van acá

La app detecta automáticamente lo que dejes en esta carpeta. Copiá:

1. **Tu plantilla SVG real** → cualquier `*.svg` (ej. `placa.svg`).
   Si no hay ninguno, la app usa un SVG de muestra integrado.

2. **Tu fuente** → `*.ttf`, `*.otf`, `*.woff` o `*.woff2`.
   Imprescindible para probar la fidelidad real del render.
   Además, en `src/config.ts` poné `familiaFuente` con el nombre de familia
   que usan los `<text>` de tu plantilla.

3. **La referencia de Imagick** → `reference.png` (o `.jpg`).
   Es el PNG que produce tu generador actual, al mismo tamaño que `anchoExport`
   en `src/config.ts`. Aparece en la tercera columna para comparar.

> Estos archivos NO se versionan por defecto si más adelante usamos git;
> son material de prueba tuyo.
