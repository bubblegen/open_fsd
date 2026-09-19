import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  ArrowUp,
  ArrowDown,
  Minus,
  ArrowUpIcon,
  RotateCcw,
  Flag,
  AlertTriangle,
  Brain,
  Eye,
  ListOrdered,
  Database,
  Braces,
  Square,
  Play,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { trpc } from "@/providers/trpc";
import {
  AutopilotGame,
  WORLD,
  type DecisionLogEntry,
  type DecisionView,
  type Snapshot,
  type TripResult,
} from "@/game/engine";
import { drawScene } from "@/game/renderer";
import { DECISION_QUESTIONS, type DecideResponse, type Direction, type SpeedAction } from "@contracts/ai";

const SPEED_LABEL: Record<SpeedAction, string> = {
  accelerate: "Acelerar",
  maintain: "Mantener",
  brake: "Frenar",
};
const DIR_LABEL: Record<Direction, string> = {
  straight: "Recto",
  left: "Izquierda",
  right: "Derecha",
};
const HEADING_LABEL = { N: "Norte", E: "Este", S: "Sur", W: "Oeste" } as const;

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AutopilotGame | null>(null);
  const decideMut = trpc.ai.decide.useMutation();
  const decideRef = useRef(decideMut.mutateAsync);
  decideRef.current = decideMut.mutateAsync;

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [decision, setDecision] = useState<DecisionView | null>(null);
  const [log, setLog] = useState<DecisionLogEntry[]>([]);
  const [mode, setMode] = useState<"autopilot" | "human">("autopilot");
  const [overlay, setOverlay] = useState<TripResult | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  const tripsQ = trpc.trips.recent.useQuery({ limit: 10 });
  const saveTrip = trpc.trips.save.useMutation();
  const utils = trpc.useUtils();

  const handleTripEnd = useCallback(
    (result: TripResult) => {
      setOverlay(result);
      saveTrip.mutate(
        { ...result, mode },
        { onSettled: () => utils.trips.recent.invalidate() },
      );
    },
    [mode, saveTrip, utils],
  );

  const handleError = useCallback((msg: string) => {
    setApiError(msg);
    window.setTimeout(() => setApiError(null), 5000);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = WORLD * dpr;
    canvas.height = WORLD * dpr;

    let lastSnapPush = 0;
    const engine = new AutopilotGame({
      onFrame: (s) => {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          drawScene(ctx, engine.renderState());
        }
        const now = performance.now();
        if (now - lastSnapPush > 150) {
          lastSnapPush = now;
          setSnap(s);
        }
      },
      onDecision: (view) => setDecision({ ...view }),
      onLog: (entry) => setLog((prev) => [entry, ...prev].slice(0, 80)),
      onTripEnd: handleTripEnd,
      onError: handleError,
      requestDecision: async (state) => {
        const res = await decideRef.current({ state });
        return res as unknown as DecideResponse;
      },
    });
    engineRef.current = engine;
    engine.start();
    return () => {
      engine.stop();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleMode = () => {
    const next = mode === "autopilot" ? "human" : "autopilot";
    setMode(next);
    engineRef.current?.setMode(next);
  };

  const humanDecide = (speed: SpeedAction, dir: Direction) => {
    engineRef.current?.applyHumanDecision(speed, dir);
  };

  const restart = () => {
    engineRef.current?.reset();
    setOverlay(null);
    setLog([]);
    setDecision(null);
  };

  const resp = decision?.response ?? null;
  const speedAns = resp?.answers.speed_action ?? null;
  const dirAns = resp?.answers.next_direction ?? null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6">
      <div className="max-w-[1400px] mx-auto flex flex-col gap-4">
        {/* Header */}
        <header className="flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center">
              <Brain className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">Tesla Autopilot · Simulador System One</h1>
              <p className="text-xs text-slate-400">
                Decisiones de velocidad y dirección en tiempo real con TypeSafe Jev
              </p>
            </div>
            <Badge variant="outline" className="border-blue-500/40 text-blue-300 ml-2">
              jev-latest · choice + noul
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill status={snap?.status ?? "running"} thinking={decision?.pending} />
            <Button
              variant={mode === "autopilot" ? "default" : "secondary"}
              size="sm"
              onClick={toggleMode}
              className={mode === "autopilot" ? "bg-blue-600 hover:bg-blue-500" : ""}
            >
              {mode === "autopilot" ? "Autopilot AI" : "Piloto humano"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => engineRef.current?.endTrip()}
              disabled={overlay !== null}
            >
              <Square className="w-3.5 h-3.5 mr-1" /> Terminar viaje
            </Button>
            <Button variant="outline" size="sm" onClick={restart}>
              <RotateCcw className="w-3.5 h-3.5 mr-1" /> Reiniciar
            </Button>
          </div>
        </header>

        {apiError && (
          <div className="rounded-md border border-red-500/40 bg-red-950/60 px-3 py-2 text-sm text-red-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            Error de la API: {apiError}. El Tesla frena de forma segura y reintentará en el próximo ciclo.
          </div>
        )}

        {/* Main */}
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_430px] gap-4">
          {/* Canvas column */}
          <div className="flex flex-col gap-3">
            <Card className="bg-slate-900/60 border-slate-800 overflow-hidden">
              <CardContent className="p-3 relative">
                <div className="relative mx-auto" style={{ maxWidth: 720 }}>
                  <canvas
                    ref={canvasRef}
                    className="w-full h-auto rounded-md block"
                    style={{ aspectRatio: "1 / 1" }}
                  />
                  {overlay && (
                    <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center rounded-md">
                      <div className="text-center space-y-3 px-6">
                        {overlay.crashed ? (
                          <>
                            <AlertTriangle className="w-12 h-12 text-red-400 mx-auto" />
                            <h2 className="text-2xl font-bold text-red-400">Accidente</h2>
                            <p className="text-sm text-slate-300">
                              El Tesla chocó. El viaje ha terminado.
                            </p>
                          </>
                        ) : (
                          <>
                            <Flag className="w-12 h-12 text-emerald-400 mx-auto" />
                            <h2 className="text-2xl font-bold text-emerald-400">Viaje finalizado</h2>
                          </>
                        )}
                        <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm text-slate-300 text-left">
                          <span>Puntuación</span>
                          <span className="font-mono text-right">{overlay.score}</span>
                          <span>Distancia</span>
                          <span className="font-mono text-right">{overlay.distanceM} m</span>
                          <span>Duración</span>
                          <span className="font-mono text-right">{overlay.durationS} s</span>
                          <span>Decisiones de Jev</span>
                          <span className="font-mono text-right">{overlay.decisions}</span>
                          <span>Destinos alcanzados</span>
                          <span className="font-mono text-right">{overlay.destinationsReached}</span>
                          <span>Incidentes</span>
                          <span className="font-mono text-right">{overlay.incidents}</span>
                        </div>
                        <Button onClick={restart} className="bg-blue-600 hover:bg-blue-500">
                          <Play className="w-4 h-4 mr-1" /> Nuevo viaje
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                {/* HUD */}
                <div className="mt-3 grid grid-cols-3 sm:grid-cols-6 gap-2">
                  <Hud label="Velocidad" value={`${snap?.speedKmh ?? 0}`} unit="km/h" accent />
                  <Hud label="Límite" value={`${snap?.speedLimitKmh ?? "-"}`} unit="km/h" />
                  <Hud label="Puntuación" value={`${snap?.score ?? 0}`} />
                  <Hud label="Distancia" value={`${snap?.distanceM ?? 0}`} unit="m" />
                  <Hud label="Destinos" value={`${snap?.destinationsReached ?? 0}`} />
                  <Hud
                    label="Incidentes"
                    value={`${snap?.incidents ?? 0}`}
                    warn={(snap?.incidents ?? 0) > 0}
                  />
                </div>

                {/* Human controls */}
                {mode === "human" && (
                  <div className="mt-3 rounded-md border border-slate-700 bg-slate-900 p-3">
                    <p className="text-xs text-slate-400 mb-2">
                      Piloto humano: cada ciclo Jev da su recomendación (panel derecho), pero tú tienes
                      la última palabra. Sin pulsar, el Tesla mantiene su última orden.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <HumanBtn
                        active={false}
                        onClick={() => humanDecide("accelerate", snap?.latchedTurn ?? "straight")}
                        icon={<ArrowUp className="w-4 h-4" />}
                        label="Acelerar"
                        suggest={speedAns?.choice === "accelerate"}
                      />
                      <HumanBtn
                        active={false}
                        onClick={() => humanDecide("maintain", snap?.latchedTurn ?? "straight")}
                        icon={<Minus className="w-4 h-4" />}
                        label="Mantener"
                        suggest={speedAns?.choice === "maintain"}
                      />
                      <HumanBtn
                        active={false}
                        onClick={() => humanDecide("brake", snap?.latchedTurn ?? "straight")}
                        icon={<ArrowDown className="w-4 h-4" />}
                        label="Frenar"
                        suggest={speedAns?.choice === "brake"}
                      />
                      <Separator orientation="vertical" className="h-8 bg-slate-700" />
                      <HumanBtn
                        active={false}
                        onClick={() => humanDecide("accelerate", "straight")}
                        icon={<ArrowUpIcon className="w-4 h-4" />}
                        label="Recto"
                        suggest={dirAns?.choice === "straight"}
                      />
                      <HumanBtn
                        active={false}
                        onClick={() => humanDecide("accelerate", "left")}
                        icon={<ChevronLeft className="w-4 h-4" />}
                        label="Izquierda"
                        suggest={dirAns?.choice === "left"}
                      />
                      <HumanBtn
                        active={false}
                        onClick={() => humanDecide("accelerate", "right")}
                        icon={<ChevronRight className="w-4 h-4" />}
                        label="Derecha"
                        suggest={dirAns?.choice === "right"}
                      />
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Panels column */}
          <Card className="bg-slate-900/60 border-slate-800 flex flex-col min-h-[640px]">
            <Tabs defaultValue="decision" className="flex flex-col flex-1">
              <CardHeader className="pb-2">
                <TabsList className="grid grid-cols-5 bg-slate-800/70">
                  <TabsTrigger value="decision">
                    <Brain className="w-3.5 h-3.5 mr-1 hidden sm:inline" />Decisión
                  </TabsTrigger>
                  <TabsTrigger value="perception">
                    <Eye className="w-3.5 h-3.5 mr-1 hidden sm:inline" />Percepción
                  </TabsTrigger>
                  <TabsTrigger value="log">
                    <ListOrdered className="w-3.5 h-3.5 mr-1 hidden sm:inline" />Registro
                  </TabsTrigger>
                  <TabsTrigger value="trips">
                    <Database className="w-3.5 h-3.5 mr-1 hidden sm:inline" />Viajes
                  </TabsTrigger>
                  <TabsTrigger value="api">
                    <Braces className="w-3.5 h-3.5 mr-1 hidden sm:inline" />API
                  </TabsTrigger>
                </TabsList>
              </CardHeader>
              <CardContent className="flex-1 overflow-hidden">
                <TabsContent value="decision" className="h-full m-0">
                  <DecisionTab decision={decision} latched={snap?.latchedTurn ?? null} />
                </TabsContent>
                <TabsContent value="perception" className="h-full m-0">
                  <PerceptionTab decision={decision} snap={snap} />
                </TabsContent>
                <TabsContent value="log" className="h-full m-0">
                  <LogTab log={log} />
                </TabsContent>
                <TabsContent value="trips" className="h-full m-0">
                  <TripsTab trips={tripsQ.data ?? []} loading={tripsQ.isLoading} />
                </TabsContent>
                <TabsContent value="api" className="h-full m-0">
                  <ApiTab decision={decision} />
                </TabsContent>
              </CardContent>
            </Tabs>
          </Card>
        </div>

        <footer className="text-center text-xs text-slate-500">
          Decisiones tipadas (choice · noul) vía POST /v1/systemone de TypeSafe AI · El estado que
          percibe el Tesla se envía cada ~0,9 s · La clave de API solo existe en el servidor
        </footer>
      </div>
    </div>
  );
}

/* ── small components ─────────────────────────────────────────── */

function StatusPill({ status, thinking }: { status: string; thinking?: boolean }) {
  const map: Record<string, { text: string; cls: string }> = {
    running: { text: "En marcha", cls: "border-emerald-500/40 text-emerald-300" },
    thinking: { text: "Jev decidendo…", cls: "border-amber-500/40 text-amber-300" },
    error: { text: "Error API", cls: "border-red-500/40 text-red-300" },
    ended: { text: "Viaje terminado", cls: "border-slate-500/40 text-slate-400" },
  };
  const s = thinking ? map.thinking : map[status] ?? map.running;
  return (
    <Badge variant="outline" className={s.cls}>
      <span className="relative flex h-2 w-2 mr-1.5">
        <span
          className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 ${
            status === "error" ? "bg-red-400" : "bg-emerald-400"
          }`}
        />
        <span
          className={`relative inline-flex rounded-full h-2 w-2 ${
            status === "error" ? "bg-red-400" : "bg-emerald-400"
          }`}
        />
      </span>
      {s.text}
    </Badge>
  );
}

function Hud({
  label,
  value,
  unit,
  accent,
  warn,
}: {
  label: string;
  value: string;
  unit?: string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        accent
          ? "border-blue-500/40 bg-blue-950/40"
          : warn
            ? "border-red-500/40 bg-red-950/30"
            : "border-slate-800 bg-slate-900/80"
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`text-xl font-bold font-mono ${accent ? "text-blue-300" : ""}`}>
        {value}
        {unit && <span className="text-xs font-normal text-slate-400 ml-1">{unit}</span>}
      </div>
    </div>
  );
}

function HumanBtn({
  onClick,
  icon,
  label,
  suggest,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  suggest?: boolean;
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={onClick}
      className={`gap-1.5 ${
        suggest ? "ring-2 ring-blue-500/70 bg-blue-950/60 hover:bg-blue-900/60" : "bg-slate-800 hover:bg-slate-700"
      }`}
    >
      {icon}
      {label}
      {suggest && <span className="text-[9px] text-blue-300 ml-1">Jev</span>}
    </Button>
  );
}

function ProbBar({ label, prob, chosen }: { label: string; prob: number; chosen: boolean }) {
  const pct = Math.round(prob * 100);
  return (
    <div className={`rounded-md border px-2.5 py-1.5 ${chosen ? "border-blue-500/60 bg-blue-950/40" : "border-slate-800"}`}>
      <div className="flex justify-between text-xs mb-1">
        <span className={chosen ? "text-blue-200 font-medium" : "text-slate-300"}>{label}</span>
        <span className="font-mono text-slate-400">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${chosen ? "bg-blue-500" : "bg-slate-600"}`}
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
    </div>
  );
}

function DecisionTab({
  decision,
  latched,
}: {
  decision: DecisionView | null;
  latched: Direction | null;
}) {
  if (!decision) {
    return <p className="text-sm text-slate-400 pt-4">Esperando al primer ciclo de decisión…</p>;
  }
  const resp = decision.response;
  if (decision.pending || !resp) {
    return (
      <div className="flex flex-col items-center gap-2 pt-10 text-slate-400">
        <Brain className="w-8 h-8 animate-pulse text-blue-400" />
        <p className="text-sm">Preguntando a Jev qué hacer ahora…</p>
        <p className="text-xs text-slate-500">tick #{decision.tick} · velocidad + dirección + peligro</p>
      </div>
    );
  }
  const s = resp.answers.speed_action;
  const d = resp.answers.next_direction;
  const danger = resp.answers.immediate_danger.noul;
  return (
    <ScrollArea className="h-[560px] pr-3">
      <div className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
            ¿Cómo ajusta la velocidad?
          </h3>
          <div className="space-y-1.5">
            {Object.entries(s.probabilities)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => (
                <ProbBar key={k} label={SPEED_LABEL[k as SpeedAction] ?? k} prob={v} chosen={s.choice === k} />
              ))}
          </div>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
            ¿Hacia dónde en el próximo cruce?
          </h3>
          <div className="space-y-1.5">
            {Object.entries(d.probabilities)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => (
                <ProbBar
                  key={k}
                  label={DIR_LABEL[k as Direction] ?? k}
                  prob={v}
                  chosen={(latched ?? d.choice) === k}
                />
              ))}
          </div>
          <p className="text-[11px] text-slate-500 mt-1.5">
            Giro actualmente activado:{" "}
            <span className="text-blue-300">{DIR_LABEL[latched ?? (d.choice as Direction)]}</span>
          </p>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
            ¿Peligro inminente?
          </h3>
          <div className="rounded-md border border-slate-800 px-3 py-2.5">
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-slate-300">Probabilidad de colisión inminente</span>
              <span className="font-mono">{Math.round(danger * 100)}%</span>
            </div>
            <div className="relative h-2 rounded-full bg-slate-800 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${danger >= 0.55 ? "bg-red-500" : "bg-emerald-500"}`}
                style={{ width: `${Math.max(Math.round(danger * 100), 2)}%` }}
              />
              <div className="absolute top-0 bottom-0 w-px bg-white/50" style={{ left: "55%" }} />
            </div>
            <p className="text-[10px] text-slate-500 mt-1">
              ≥ 55% dispara la frenada de emergencia automática
            </p>
          </div>
        </div>
        <Separator className="bg-slate-800" />
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-md bg-slate-900 border border-slate-800 py-2">
            <div className="text-slate-500">Confianza</div>
            <div className="font-mono text-slate-200">{Math.round(s.confidence * 100)}%</div>
          </div>
          <div className="rounded-md bg-slate-900 border border-slate-800 py-2">
            <div className="text-slate-500">Latencia</div>
            <div className="font-mono text-slate-200">{resp.latencyMs} ms</div>
          </div>
          <div className="rounded-md bg-slate-900 border border-slate-800 py-2">
            <div className="text-slate-500">Tokens</div>
            <div className="font-mono text-slate-200">{resp.usage?.input_tokens ?? "-"} in</div>
          </div>
        </div>
        <p className="text-[11px] text-slate-500">
          Modelo: <span className="font-mono text-slate-300">{resp.model}</span>
          {decision.mode === "human" && (
            <>
              {" "}· Modo humano: esta es la recomendación de Jev; el botón que pulses prevalece.
              {decision.humanApplied && (
                <span className="text-blue-300"> Última orden aplicada por ti.</span>
              )}
            </>
          )}
        </p>
      </div>
    </ScrollArea>
  );
}

function PerceptionTab({ decision, snap }: { decision: DecisionView | null; snap: Snapshot | null }) {
  if (!decision) return <p className="text-sm text-slate-400 pt-4">Sin percepción todavía…</p>;
  const p = decision.perception;
  const rows: Array<[string, string]> = [
    ["Velocidad actual", `${p.autopilot.speedKmh} km/h (límite ${p.autopilot.speedLimitKmh})`],
    ["Dirección actual", HEADING_LABEL[p.autopilot.heading]],
    ["Distancia al próximo cruce", `${p.autopilot.distanceToIntersectionM} m`],
    [
      "Direcciones válidas en el cruce",
      p.autopilot.availableDirections.map((d) => DIR_LABEL[d]).join(" · ") || "solo girar en U",
    ],
    ["Destino", p.autopilot.destinationRelative],
    ["Ruta sugerida por código", `en el cruce, ${DIR_LABEL[p.autopilot.destinationHint]}`],
    ["Calzada", p.perception.laneAhead],
  ];
  if (p.perception.vehicleAhead) {
    rows.push([
      "Vehículo delante",
      `${p.perception.vehicleAhead.type} a ${p.perception.vehicleAhead.distanceM} m · ${p.perception.vehicleAhead.speedKmh} km/h`,
    ]);
  }
  if (p.perception.oncomingVehicle) {
    rows.push([
      "Sentido contrario",
      `a ${p.perception.oncomingVehicle.distanceM} m · ${p.perception.oncomingVehicle.speedKmh} km/h`,
    ]);
  }
  if (p.perception.pedestrian) {
    rows.push(["Peatón", `cruzando el próximo cruce, a ${p.perception.pedestrian.distanceM} m`]);
  }
  return (
    <ScrollArea className="h-[560px] pr-3">
      <div className="space-y-4">
        <p className="text-xs text-slate-400">
          Estado estructurado que el simulador envía a Jev en cada ciclo (tick #{p.tick}). Jev no
          genera texto: responde con decisiones tipadas sobre este estado.
        </p>
        <div className="space-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 text-sm rounded-md bg-slate-900/70 border border-slate-800 px-3 py-2">
              <span className="text-slate-400 shrink-0">{k}</span>
              <span className="text-slate-100 text-right">{v}</span>
            </div>
          ))}
        </div>
        {snap && (
          <p className="text-[11px] text-slate-500">
            Decisiones tomadas hasta ahora: {snap.decisions} · el coche mantiene el giro activado:{" "}
            {snap.latchedTurn ? DIR_LABEL[snap.latchedTurn] : "recto"}
          </p>
        )}
      </div>
    </ScrollArea>
  );
}

function LogTab({ log }: { log: DecisionLogEntry[] }) {
  if (log.length === 0)
    return <p className="text-sm text-slate-400 pt-4">Aún no hay decisiones registradas.</p>;
  return (
    <ScrollArea className="h-[560px] pr-3">
      <div className="space-y-1.5">
        {log.map((e, idx) => (
          <div
            key={`${e.tick}-${idx}`}
            className="flex items-center gap-2 text-xs rounded-md bg-slate-900/70 border border-slate-800 px-2.5 py-2"
          >
            <span className="font-mono text-slate-500 w-8">#{e.tick}</span>
            <Badge
              variant="outline"
              className={
                e.speedAction === "accelerate"
                  ? "border-emerald-500/40 text-emerald-300"
                  : e.speedAction === "brake"
                    ? "border-red-500/40 text-red-300"
                    : "border-slate-500/40 text-slate-300"
              }
            >
              {SPEED_LABEL[e.speedAction]}
            </Badge>
            <Badge variant="outline" className="border-slate-600 text-slate-300">
              {DIR_LABEL[e.direction]}
            </Badge>
            <span className={`font-mono ${e.danger >= 0.55 ? "text-red-400" : "text-slate-400"}`}>
              ⚠ {Math.round(e.danger * 100)}%
            </span>
            <span className="ml-auto font-mono text-slate-500">{e.latencyMs} ms</span>
            <span className={`font-mono ${e.source === "human" ? "text-blue-300" : "text-slate-500"}`}>
              {e.source === "human" ? "TÚ" : "JEV"}
            </span>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function TripsTab({ trips, loading }: { trips: any[]; loading: boolean }) {
  if (loading) return <p className="text-sm text-slate-400 pt-4">Cargando viajes…</p>;
  if (trips.length === 0)
    return (
      <p className="text-sm text-slate-400 pt-4">
        Todavía no hay viajes guardados. Termina un viaje (o choca) para registrarlo aquí. Se
        guardan en la base de datos del servidor.
      </p>
    );
  return (
    <ScrollArea className="h-[560px] pr-3">
      <div className="space-y-1.5">
        {trips.map((t) => (
          <div
            key={t.id}
            className="flex items-center gap-3 text-xs rounded-md bg-slate-900/70 border border-slate-800 px-3 py-2"
          >
            <span className={`font-mono font-bold ${t.crashed === "yes" ? "text-red-400" : "text-emerald-300"}`}>
              {t.score}
            </span>
            <span className="text-slate-400">
              {t.distanceM} m · {t.durationS} s
            </span>
            <span className="text-slate-500">
              {t.destinationsReached} dest. · {t.decisions} decisiones
            </span>
            {t.crashed === "yes" && <AlertTriangle className="w-3.5 h-3.5 text-red-400" />}
            <span className="ml-auto text-slate-500">
              {new Date(t.createdAt).toLocaleString("es-ES", {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function ApiTab({ decision }: { decision: DecisionView | null }) {
  const request = decision
    ? { model: "jev-latest", state: decision.rawState, questions: DECISION_QUESTIONS }
    : null;
  return (
    <ScrollArea className="h-[560px] pr-3">
      <div className="space-y-3">
        <p className="text-xs text-slate-400">
          Petición real enviada por el servidor proxy (la clave nunca sale del servidor) y respuesta
          tipada de <span className="font-mono">api.typesafe.ai/v1/systemone</span>.
        </p>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
            → Request
          </h3>
          <pre className="text-[11px] font-mono rounded-md bg-black/50 border border-slate-800 p-3 overflow-auto max-h-64">
            {request ? JSON.stringify(request, null, 2) : "…"}
          </pre>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
            ← Response
          </h3>
          <pre className="text-[11px] font-mono rounded-md bg-black/50 border border-slate-800 p-3 overflow-auto max-h-64">
            {decision?.response ? JSON.stringify(decision.response, null, 2) : "…"}
          </pre>
        </div>
      </div>
    </ScrollArea>
  );
}
