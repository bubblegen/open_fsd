# Arquitectura del simulador — Tesla Autopilot con TypeSafe System One (Jev)

Documento técnico del juego web. Explica qué se envía a la IA, cómo se toman
las decisiones y qué capas de seguridad garantizan que el coche no atraviese
peatones ni vehículos. Todo el contenido es aplicable al código en `src/game/engine.ts`,
`src/game/scene3d.ts`, `api/ai-router.ts` y `api/geo-router.ts`.

---

## 1. Lo esencial: qué ve Jev (y qué NO ve)

**Jev no recibe ninguna imagen.** Las cámaras que se dibujan en pantalla son
solo representación gráfica para el jugador. La IA decide sobre un estado
estructurado en texto (telemetría), construido en `buildPerception()`:

```ts
PerceptionState {
  tick,                       // nº de decisión
  gps: {
    elapsedS, speedKmh, speedLimitKmh, roadName,
    progressPct, remainingM, distanceToManeuverM,
    nextManeuver,             // "Gira a la izquierda hacia Calle de Alcalá"
    maneuverType,             // turn | roundabout | fork | merge | arrive...
    maneuverModifier,         // left | right | straight | slight left...
    afterNextManeuver, cruiseActive, cruiseTargetKmh,
    fastRoad,                 // límite ≥ 90 → se permite crucero
  },
  traffic: {
    laneAhead,                // texto descriptivo: "Ocupada: coche a 32 m"...
    viaDespejada,             // true = sin peatón ni vehículo delante
    vehicleAhead,             // { type, distanceM, speedKmh } | null
    oncomingVehicle,          // { type, distanceM, speedKmh } | null
    emergencyVehicle,         // policía/ambulancia acercándose | null
    pedestrian,               // { kind: persona|perro, distanceM, lateralM,
                              //   closing, clearsInS } | null
  }
}
```

El flujo completo:

```
engine.ts buildPerception()
   └─► POST /api/trpc/ai.decide  (tRPC, mismo origen)
         └─► api/ai-router.ts
               └─► POST https://api.typesafe.ai/v1/systemone
                     Authorization: Bearer $TYPESAFE_API_KEY   ← SOLO SERVIDOR
                     body: { model: "jev-latest",
                             state: PerceptionState,
                             questions: DECISION_QUESTIONS }
                     └─► respuesta tipada: { speed_action, cruise,
                                             maneuver_ok, immediate_danger }
```

- La clave `TYPESAFE_API_KEY` vive únicamente en `.env` del servidor
  (gitignored). El navegador nunca la ve: la petición sale del backend.
- Jev responde cada **0,9 s** (`DECISION_INTERVAL_S`). Las respuestas son
  tipadas: `speed_action` ∈ accelerate | maintain | brake (con probabilidades),
  `cruise` ∈ cruise_80 | cruise_100 | cruise_120 | off, más `maneuver_ok`
  y `immediate_danger` (números 0–1).

## 2. Cadencia y por qué existe la capa refleja

Jev decide cada 0,9 s; la física avanza a pasos fijos de 0,05 s (20 Hz).
Entre decisión y decisión pueden pasar ~18 ticks de simulación. Un peatón que
aparece justo después de una decisión quedaría sin respuesta ~1 s: por eso la
**seguridad nunca depende solo del modelo**. Ver capa 4.

## 3. Capa de decisión (lo que Jev controla)

El motor aplica la última respuesta de Jev en la cadena de velocidad:

| Orden | Comportamiento |
|---|---|
| `accelerate` | Acelera 15 km/h·s hasta `min(límite, 130)`, respetando distancia de seguimiento (gap 2 s + 6 m). El tope puede bajar por el planificador de aproximación. |
| `maintain` | Mantiene velocidad, con gap de seguridad al líder y match de velocidad suave. |
| `brake` | Frenado graduado por distancia (suave lejos, firme cerca). Si el estado dice que el peatón despeja antes de llegar, se reduce a maintain para no parar innecesariamente. |
| `immediate_danger` ≥ 0,55 | **Emergency**: frenazo de 40 km/h·s hasta que el peligro desaparece. |
| crucero | En vía rápida (límite ≥ 90) fija el objetivo 80/100/120 con gap adaptativo. |

En modo "Piloto humano" los botones del jugador prevalecen; Jev sigue
recomendando en el panel lateral.

## 4. Capas de seguridad (en orden de aplicación cada tick)

1. **Planificador de aproximación anticipado** (nuevo): para cada amenaza
   (peatón/perro que cruza, vehículo lento o parado delante) calcula la
   velocidad máxima *ahora* desde la que un frenado suave de 2,6 m/s² llega
   exactamente a la velocidad permitida de paso. Frena antes y de forma
   progresiva, en vez de mantener el acelerador hasta el AEB.
2. **AEB de cruces** (peatones/perros): barrido de banda de peligro
   (media anchura 1,7 m persona / 2,1 m perro). Velocidad permitida =
   llegar justo después de que despejan + 0,55 s margen. Horizonte de
   escaneo = `max(45 m, distancia de frenado)`. El perro tiene techo de
   3,0 m/s y la persona 4,5 m/s al pasar cerca.
3. **AEB de vehículos**: cualquier cierre > 0,4 m/s frena progresivamente
   con ventana que escala con la velocidad de cierre; objetivo = igualar la
   velocidad del líder con 3 m de margen al parachoques. Escanea **todos**
   los coches del sentido propio excepto el que se está adelantando (un
   segundo coche parado más allá ya no es invisible).
4. **Freno de emergencia**: si `immediate_danger` ≥ 0,55 → 40 km/h·s.
5. **Invariante duro (cuerpos sólidos)**: tras mover, para cada coche del
   mismo sentido: si |ds| < 4,6+0,3 y separación lateral < 1,6 m, se resuelve
   ESE tick: cierre > 25 km/h = accidente; rozón = incidente + igualar
   velocidad + colocarse en su parachoques. Sin exenciones por id.
6. **Atropello**: contacto `|ds| < 2,2` y `|lateral| < 1,4` con velocidad
   > 3 km/h. Perro a ≤ 18 km/h: se asusta y sale corriendo (incidente −60,
   aviso en pantalla, el perro huye de forma visible). En cualquier otro
   caso: accidente.
7. **Detector de atasco**: si estamos parados sin nada delante, corrige
   órdenes de freno obsoletas (maintain → accelerate).

## 5. Adelantamientos (máquina de estados)

Objetivo: pasar coches parados o a < 15 km/h **lento, a la izquierda y con
el carril contrario libre**:

1. **Espera** (hasta 5 s con intermitente izquierdo) detrás del obstáculo.
2. **Comprobación del contrario**: basada en TIEMPO, no en distancia —
   `t_contrario = ds / v` vs `t_paso = (gap + largo + 2) / v_rel + 1,5`.
   Un coche en (−12, 0] bloquea siempre. Si hay conflicto: seguir esperando.
3. **Paso**: velocidad tope `min(20, max(8, v_líder+8))` km/h; el obstáculo
   cede hacia el bordillo (latOff → 1,35) y nosotros ceñimos la línea
   (teslaLat → 0,85); separación lateral ≥ 2,4 m.
4. **Abortar**: si aparece contrario o el líder arranca > 18 km/h → volver
   al carril con intermitente derecho (2,5 s) y reintentar después.
5. **Fin**: al superarlo, reincorporación gradual y apagado del intermitente.

## 6. Generación de tráfico y cruces (justa)

- Tráfico: coches/taxis/camiones en sentido propio; policía y ambulancias en
  contrario (ceder el paso: la ambulancia interviene con freno de emergencia).
- Cruces: peatones y perros aparecen en aceras y cruzan. Distancia mínima de
  aparición = `max(28 m, 12 + v²/8)` para que el AEB pueda detener el coche
  físicamente; máx. 3 simultáneos; se respeta un tiempo mínimo entre cruces.

## 7. Rutas y geocodificación

- Origen/destino: búsqueda estilo Google Maps ( Photon / OSM Nominatim ) con
  autocompletado.
- Cálculo de ruta: OSRM (demo) como primario; **Valhalla** como respaldo
  automático si OSRM falla, con reintentos (4 intentos con backoff) y caché
  en memoria (200 rutas FIFO). Los maniobras Valhalla se mapean a las
  instrucciones del HUD (giro, rotonda con salida, fork, merge...).
- Mapa: teselas Esri/Maxar sobre proyección local; radar GPS circular estilo
  GTA abajo a la izquierda; trayectoria Tesla dibujada sobre la carretera.

## 8. Seguridad de credenciales

| Secreto | Dónde |
|---|---|
| `TYPESAFE_API_KEY` | Solo `.env` del servidor (gitignored). El frontend la consume vía tRPC en el mismo origen; jamás aparece en el bundle ni en el navegador. |
| GitHub PAT | Nunca se escribe en ningún fichero commiteado; el push se hace con un token de un solo uso facilitado por el usuario. |

## 9. Pruebas automatizadas (`scripts/`)

| Script | Qué garantiza |
|---|---|
| `test-overtake.ts` | Nunca atravesar un coche: 5 escenarios (50/8/120/60 km/h con obstáculo parado o lento, y contrario cercano) — margen de parachoques ≥ 0,3 m, paso ≤ 20 km/h, sep. lateral 2,4 m, intermitentes correctos, sin salir con contrario. |
| `test-dog-aeb.ts` | Matriz de 108 escenarios de perro rápido cruzando: sin atropello ni intrusión. |
| `test-fuzz-invariant.ts` | 60 carreras con tráfico aleatorio stop/go y cruces aleatorios: el invariante de cuerpos sólidos nunca se rompe. |
| `soak-overtake.ts` | 300 s de conducción continua con furgoneta orquestada parando/arrancando: pasos lentos y separados. |
| `test-crash-repro.ts` | Reproducción de crashes reportados: quedan en timeout sin crash tras el arreglo. |
| `test-valhalla.ts` | El respaldo Valhalla devuelve rutas coherentes (~7,7 km conocidos). |
| `catch-crash.mjs` | Detector visual en navegador headless: screenshot y consola si hay accidente. |
| `verify-deployed.mjs` | Chequeo extremo a extremo de la URL desplegada. |
