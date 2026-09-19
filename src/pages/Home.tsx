import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import {
  ArrowUp,
  ArrowDown,
  Minus,
  RotateCcw,
  Flag,
  AlertTriangle,
  Brain,
  ListOrdered,
  Braces,
  Square,
  Play,
  MapPin,
  Search,
  ArrowLeftRight,
  LocateFixed,
  CornerUpLeft,
  CornerUpRight,
  RefreshCw,
  Merge,
  Gauge,
  Navigation,
  Loader2,
  Car,
} from "lucide-react";
import { trpc } from "@/providers/trpc";
import {
  AutopilotGame,
  type DecisionLogEntry,
  type DecisionView,
  type Snapshot,
  type TripResult,
} from "@/game/engine";
import { Scene3D } from "@/game/scene3d";
import { Radar } from "@/game/radar";
import {
  DECISION_QUESTIONS,
  type DecideResponse,
  type SpeedAction,
  type CruiseChoice,
} from "@contracts/ai";
import type { GeoPlace, RouteData } from "@contracts/geo";

const SPEED_LABEL: Record<SpeedAction, string> = {
  accelerate: "Acelerar",
  maintain: "Mantener",
  brake: "Frenar",
};
const CRUISE_LABEL: Record<string, string> = {
  cruise_80: "Crucero 80",
  cruise_100: "Crucero 100",
  cruise_120: "Crucero 120",
  off: "Crucero OFF",
};
const CRUISE_VALUE: Record<string, number | null> = {
  cruise_80: 80,
  cruise_100: 100,
  cruise_120: 120,
  off: null,
};

const PRESETS: Array<{ label: string; from: string; to: string }> = [
  { label: "Madrid: Sol → Chamartín", from: "Puerta del Sol, Madrid", to: "Estación de Chamartín, Madrid" },
  { label: "Madrid: Sol → Bernabéu", from: "Puerta del Sol, Madrid", to: "Estadio Santiago Bernabéu, Madrid" },
  { label: "BCN: Cataluña → Sagrada Família", from: "Plaça de Catalunya, Barcelona", to: "Sagrada Família, Barcelona" },
];

export default function Home() {
  const [screen, setScreen] = useState<"setup" | "game">("setup");
  const [origin, setOrigin] = useState<GeoPlace | null>(null);
  const [destination, setDestination] = useState<GeoPlace | null>(null);
  const [routeParams, setRouteParams] = useState<{
    fromLat: number;
    fromLon: number;
    toLat: number;
    toLon: number;
  } | null>(null);

  const routeQ = trpc.geo.route.useQuery(
    routeParams ?? { fromLat: 0, fromLon: 0, toLat: 0, toLon: 0 },
    { enabled: !!routeParams, retry: 2, retryDelay: (n) => 700 * (n + 1), staleTime: Infinity },
  );

  const start = (o: GeoPlace, d: GeoPlace) => {
    setOrigin(o);
    setDestination(d);
    setRouteParams({ fromLat: o.lat, fromLon: o.lon, toLat: d.lat, toLon: d.lon });
  };

  const backToSetup = () => {
    setScreen("setup");
    setRouteParams(null);
  };

  return screen === "setup" ? (
    <SetupScreen
      onStart={(o, d) => {
        start(o, d);
        setScreen("game");
      }}
      loading={routeQ.isFetching}
    />
  ) : (
    <GameScreen
      origin={origin!}
      destination={destination!}
      route={routeQ.data}
      routeError={routeQ.error}
      loadingRoute={routeQ.isLoading}
      onRetryRoute={() => routeQ.refetch()}
      onBack={backToSetup}
    />
  );
}

/* ═════════════════════ SETUP SCREEN ═════════════════════ */

function SetupScreen({
  onStart,
  loading,
}: {
  onStart: (o: GeoPlace, d: GeoPlace) => void;
  loading: boolean;
}) {
  const [origin, setOrigin] = useState<GeoPlace | null>(null);
  const [destination, setDestination] = useState<GeoPlace | null>(null);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-6">
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center mx-auto">
            <Car className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold">Tesla Autopilot · Simulador System One</h1>
          <p className="text-sm text-slate-400 max-w-md mx-auto">
            Elige un origen y un destino reales (OpenStreetMap). El Tesla recorrerá la ruta con
            decisiones de velocidad, crucero y seguridad tomadas por TypeSafe Jev en cada instante.
          </p>
        </div>

        <Card className="bg-slate-900/70 border-slate-800">
          <CardContent className="p-4 space-y-3">
            <PlaceSearch
              label="Origen"
              placeholder="Ej: Puerta del Sol, Madrid"
              value={origin}
              onChange={setOrigin}
              icon={<MapPin className="w-4 h-4 text-emerald-400" />}
              onUseLocation={(p) => setOrigin(p)}
            />
            <div className="flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOrigin(destination);
                  setDestination(origin);
                }}
                disabled={!origin && !destination}
              >
                <ArrowLeftRight className="w-4 h-4 mr-1" /> Intercambiar
              </Button>
            </div>
            <PlaceSearch
              label="Destino"
              placeholder="Ej: Estación de Chamartín, Madrid"
              value={destination}
              onChange={setDestination}
              icon={<Flag className="w-4 h-4 text-sky-400" />}
            />
            <Button
              className="w-full bg-blue-600 hover:bg-blue-500"
              disabled={!origin || !destination || loading}
              onClick={() => origin && destination && onStart(origin, destination)}
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Calculando ruta…
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 mr-2" /> Iniciar simulación
                </>
              )}
            </Button>
            {origin && destination && (
              <p className="text-[11px] text-slate-500 text-center">
                {origin.name} → {destination.name}
              </p>
            )}
          </CardContent>
        </Card>

        <div>
          <p className="text-xs text-slate-500 mb-2 text-center">Rutas de ejemplo</p>
          <div className="flex flex-wrap gap-2 justify-center">
            {PRESETS.map((p) => (
              <PresetButton
                key={p.label}
                label={p.label}
                from={p.from}
                to={p.to}
                onResolved={(o, d) => {
                  setOrigin(o);
                  setDestination(d);
                }}
              />
            ))}
          </div>
        </div>

        <footer className="text-center text-[11px] text-slate-600">
          Geocodificación Photon · Rutas OSRM · Mapa © OpenStreetMap contributors · Tiles © Esri (Maxar, Earthstar Geographics) ·
          Decisiones: TypeSafe Jev (System One)
        </footer>
      </div>
    </div>
  );
}

function PlaceSearch({
  label,
  placeholder,
  value,
  onChange,
  icon,
  onUseLocation,
}: {
  label: string;
  placeholder: string;
  value: GeoPlace | null;
  onChange: (p: GeoPlace | null) => void;
  icon: React.ReactNode;
  onUseLocation?: (p: GeoPlace) => void;
}) {
  const [text, setText] = useState(value?.name ?? "");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 300);
    return () => clearTimeout(t);
  }, [text]);

  const q = trpc.geo.geocode.useQuery(
    { q: debounced },
    { enabled: debounced.trim().length > 2 && !value, staleTime: 30000 },
  );

  useEffect(() => {
    if (value) setText(value.name);
    else setText("");
  }, [value]);

  const locating = () => {
    if (!onUseLocation || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p: GeoPlace = {
          id: `me:${pos.coords.latitude}:${pos.coords.longitude}`,
          name: `Mi ubicación (${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)})`,
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        };
        onUseLocation(p);
        setOpen(false);
      },
      () => undefined,
      { timeout: 5000 },
    );
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        {icon}
        <div className="flex-1">
          <label className="text-[10px] uppercase tracking-wide text-slate-500">{label}</label>
          <div className="flex gap-1.5">
            <Input
              value={text}
              placeholder={placeholder}
              onChange={(e) => {
                setText(e.target.value);
                onChange(null);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              className="bg-slate-950 border-slate-700"
            />
            {onUseLocation && (
              <Button variant="outline" size="icon" onClick={locating} title="Usar mi ubicación">
                <LocateFixed className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
      {open && !value && debounced.trim().length > 2 && (
        <div className="absolute z-20 left-6 right-0 mt-1 rounded-md border border-slate-700 bg-slate-900 shadow-xl max-h-56 overflow-auto">
          {q.isLoading && <p className="text-xs text-slate-400 p-3">Buscando…</p>}
          {q.data?.length === 0 && <p className="text-xs text-slate-400 p-3">Sin resultados</p>}
          {q.data?.map((p) => (
            <button
              key={p.id}
              className="w-full text-left px-3 py-2 text-sm hover:bg-slate-800 border-b border-slate-800/60 last:border-0"
              onClick={() => {
                onChange(p);
                setOpen(false);
              }}
            >
              <Search className="w-3 h-3 inline mr-2 text-slate-500" />
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PresetButton({
  label,
  from,
  to,
  onResolved,
}: {
  label: string;
  from: string;
  to: string;
  onResolved: (o: GeoPlace, d: GeoPlace) => void;
}) {
  const utils = trpc.useUtils();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      className="border-slate-700"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const [a, b] = await Promise.all([
            utils.geo.geocode.fetch({ q: from }),
            utils.geo.geocode.fetch({ q: to }),
          ]);
          if (a[0] && b[0]) onResolved(a[0], b[0]);
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : label}
    </Button>
  );
}

/* ═════════════════════ GAME SCREEN ═════════════════════ */

function GameScreen({
  origin,
  destination,
  route,
  routeError,
  loadingRoute,
  onRetryRoute,
  onBack,
}: {
  origin: GeoPlace;
  destination: GeoPlace;
  route: RouteData | undefined;
  routeError: unknown;
  loadingRoute: boolean;
  onRetryRoute: () => void;
  onBack: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const radarRef = useRef<HTMLCanvasElement>(null);
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
  const routeMeta = route;

  const saveTrip = trpc.trips.save.useMutation();
  const utils = trpc.useUtils();

  const handleTripEnd = useCallback(
    (result: TripResult) => {
      setOverlay(result);
      // debuggability: headless checks read the final trip from here
      (window as unknown as { __lastTrip?: TripResult }).__lastTrip = result;
      if (result.crashed) console.error("[trip] CRASH:", result.reason);
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
    if (!routeMeta) return;
    const canvas = canvasRef.current;
    const radarCanvas = radarRef.current;
    if (!canvas || !radarCanvas) return;
    const scene = new Scene3D(canvas);
    const radar = new Radar(radarCanvas);

    let lastSnapPush = 0;
    const engine = new AutopilotGame(routeMeta, {
      onFrame: (s) => {
        const rs = engine.renderState();
        scene.update(rs);
        radar.update(rs);
        const now = performance.now();
        if (now - lastSnapPush > 150) {
          lastSnapPush = now;
          setSnap({ ...s });
        }
      },
      onDecision: (view) => setDecision({ ...view }),
      onLog: (entry) => setLog((prev) => [entry, ...prev].slice(0, 100)),
      onTripEnd: handleTripEnd,
      onError: handleError,
      requestDecision: async (state) => {
        // one transparent retry: most fetch failures on long trips are
        // transient network blips, not real API outages
        try {
          const res = await decideRef.current({ state });
          return res as unknown as DecideResponse;
        } catch (first) {
          await new Promise((r) => setTimeout(r, 1200));
          try {
            const res = await decideRef.current({ state });
            return res as unknown as DecideResponse;
          } catch (second) {
            throw second ?? first;
          }
        }
      },
    });
    engineRef.current = engine;
    engine.start();
    return () => {
      engine.stop();
      scene.dispose();
      radar.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeMeta]);

  const toggleMode = () => {
    const next = mode === "autopilot" ? "human" : "autopilot";
    setMode(next);
    engineRef.current?.setMode(next);
  };

  const humanDecide = (speed: SpeedAction, cruise: CruiseChoice) => {
    engineRef.current?.applyHumanDecision(speed, cruise);
  };

  const restart = () => {
    setOverlay(null);
    setLog([]);
    setDecision(null);
    onBack();
  };

  if (loadingRoute || !routeMeta) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
          <p className="text-sm text-slate-400">Calculando la ruta…</p>
          {routeError ? (
            <div className="flex flex-col items-center gap-2">
              <p className="text-sm text-red-400 max-w-md text-center">
                {routeError instanceof Error ? routeError.message : "Error obteniendo la ruta"}
              </p>
              <p className="text-xs text-slate-400">Parece un fallo de red con el servicio de rutas. Inténtalo de nuevo.</p>
              <Button
                variant="outline"
                size="sm"
                className="border-slate-700"
                onClick={onRetryRoute}
              >
                Reintentar
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const etaS =
    snap && routeMeta.distanceM > 0
      ? Math.round((snap.remainingM / routeMeta.distanceM) * routeMeta.durationS)
      : null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6">
      <div className="max-w-[1500px] mx-auto flex flex-col gap-4">
        {/* Header */}
        <header className="flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
              <Navigation className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-bold leading-tight truncate">
                {origin.name.split(",")[0]} → {destination.name.split(",")[0]}
              </h1>
              <p className="text-xs text-slate-400">
                {(routeMeta.distanceM / 1000).toFixed(1)} km · decisiones en tiempo real con TypeSafe Jev
              </p>
            </div>
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
              <Square className="w-3.5 h-3.5 mr-1" /> Terminar
            </Button>
            <Button variant="outline" size="sm" onClick={restart}>
              <RotateCcw className="w-3.5 h-3.5 mr-1" /> Nueva ruta
            </Button>
          </div>
        </header>

        {apiError && (
          <div className="rounded-md border border-red-500/40 bg-red-950/60 px-3 py-2 text-sm text-red-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            Error de la API: {apiError}. El Tesla frena de forma segura y reintentará en el próximo ciclo.
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_400px] gap-4">
          {/* Canvas column */}
          <div className="flex flex-col gap-3">
            <Card className="bg-slate-900/60 border-slate-800 overflow-hidden">
              <CardContent className="p-3 relative">
                <canvas ref={canvasRef} className="w-full block rounded-md bg-[#05070d]" />
                {/* GPS radar ball, bottom-right (GTA style) */}
                <div className="absolute bottom-3 left-3 rounded-full shadow-[0_0_30px_rgba(0,0,0,0.6)] ring-1 ring-slate-700/60">
                  <canvas ref={radarRef} className="block rounded-full" />
                </div>
                {overlay && (
                  <div className="absolute inset-3 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center rounded-md">
                    <div className="text-center space-y-3 px-6">
                      {overlay.crashed ? (
                        <>
                          <AlertTriangle className="w-12 h-12 text-red-400 mx-auto" />
                          <h2 className="text-2xl font-bold text-red-400">Accidente</h2>
                          <p className="text-sm text-slate-300">El viaje ha terminado.</p>
                          <p className="text-xs font-mono text-red-300/90 bg-red-950/50 border border-red-900/60 rounded px-3 py-1.5">
                            {overlay.reason}
                          </p>
                        </>
                      ) : (
                        <>
                          <Flag className="w-12 h-12 text-emerald-400 mx-auto" />
                          <h2 className="text-2xl font-bold text-emerald-400">¡Has llegado!</h2>
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
                        <span>Maniobras completadas</span>
                        <span className="font-mono text-right">{overlay.destinationsReached}</span>
                        <span>Incidentes</span>
                        <span className="font-mono text-right">{overlay.incidents}</span>
                      </div>
                      <Button onClick={restart} className="bg-blue-600 hover:bg-blue-500">
                        <Play className="w-4 h-4 mr-1" /> Nueva ruta
                      </Button>
                    </div>
                  </div>
                )}
                {/* speed-limit sign overlay */}
                <div className="absolute top-5 right-5 flex flex-col items-center gap-1.5">
                  <div className="w-12 h-12 rounded-full border-4 border-white bg-slate-950 flex items-center justify-center shadow-lg">
                    <span className="text-lg font-bold font-mono">{snap?.speedLimitKmh ?? "-"}</span>
                  </div>
                  <span className="text-[9px] uppercase tracking-wide text-slate-400 bg-slate-950/70 px-1.5 rounded">
                    límite
                  </span>
                  {snap?.cruiseActive && (
                    <Badge className="bg-emerald-600/90 hover:bg-emerald-600 text-[10px]">
                      CRUCERO {snap.cruiseTargetKmh}
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* HUD */}
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              <Hud label="Velocidad" value={`${snap?.speedKmh ?? 0}`} unit="km/h" accent />
              <Hud label="Progreso" value={`${snap?.progressPct ?? 0}`} unit="%" />
              <Hud
                label="Restante"
                value={
                  snap
                    ? snap.remainingM > 1000
                      ? `${(snap.remainingM / 1000).toFixed(1)}`
                      : `${snap.remainingM}`
                    : "-"
                }
                unit={snap && snap.remainingM > 1000 ? "km" : "m"}
              />
              <Hud label="Maniobra en" value={`${snap?.nextManeuver ? Math.round(snap.nextManeuver.distanceM) : "-"}`} unit="m" />
              <Hud label="Decisiones" value={`${snap?.decisions ?? 0}`} />
              <Hud label="Incidentes" value={`${snap?.incidents ?? 0}`} warn={(snap?.incidents ?? 0) > 0} />
            </div>

            {/* Human controls */}
            {mode === "human" && (
              <div className="rounded-md border border-slate-700 bg-slate-900 p-3">
                <p className="text-xs text-slate-400 mb-2">
                  Piloto humano: Jev sigue recomendando (panel derecho), pero tus botones prevalecen.
                </p>
                <div className="flex flex-wrap gap-2">
                  <HumanBtn
                    onClick={() => humanDecide("accelerate", "off")}
                    icon={<ArrowUp className="w-4 h-4" />}
                    label="Acelerar"
                    suggest={decision?.response?.answers.speed_action.choice === "accelerate"}
                  />
                  <HumanBtn
                    onClick={() => humanDecide("maintain", "off")}
                    icon={<Minus className="w-4 h-4" />}
                    label="Mantener"
                    suggest={decision?.response?.answers.speed_action.choice === "maintain"}
                  />
                  <HumanBtn
                    onClick={() => humanDecide("brake", "off")}
                    icon={<ArrowDown className="w-4 h-4" />}
                    label="Frenar"
                    suggest={decision?.response?.answers.speed_action.choice === "brake"}
                  />
                  <Separator orientation="vertical" className="h-8 bg-slate-700" />
                  {(["cruise_80", "cruise_100", "cruise_120", "off"] as CruiseChoice[]).map((c) => (
                    <HumanBtn
                      key={c}
                      onClick={() => humanDecide("maintain", c)}
                      icon={<Gauge className="w-4 h-4" />}
                      label={CRUISE_LABEL[c]}
                      suggest={decision?.response?.answers.cruise.choice === c}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right column: GPS + tabs */}
          <div className="flex flex-col gap-4">
            <GpsCard snap={snap} etaS={etaS} fromName={origin.name} toName={destination.name} />
            <Card className="bg-slate-900/60 border-slate-800 flex flex-col min-h-[420px]">
              <Tabs defaultValue="decision" className="flex flex-col flex-1">
                <CardHeader className="pb-2">
                  <TabsList className="grid grid-cols-3 bg-slate-800/70">
                    <TabsTrigger value="decision">
                      <Brain className="w-3.5 h-3.5 mr-1 hidden sm:inline" />Decisión
                    </TabsTrigger>
                    <TabsTrigger value="log">
                      <ListOrdered className="w-3.5 h-3.5 mr-1 hidden sm:inline" />Registro
                    </TabsTrigger>
                    <TabsTrigger value="api">
                      <Braces className="w-3.5 h-3.5 mr-1 hidden sm:inline" />API
                    </TabsTrigger>
                  </TabsList>
                </CardHeader>
                <CardContent className="flex-1 overflow-hidden">
                  <TabsContent value="decision" className="h-full m-0">
                    <DecisionTab decision={decision} />
                  </TabsContent>
                  <TabsContent value="log" className="h-full m-0">
                    <LogTab log={log} />
                  </TabsContent>
                  <TabsContent value="api" className="h-full m-0">
                    <ApiTab decision={decision} />
                  </TabsContent>
                </CardContent>
              </Tabs>
            </Card>
          </div>
        </div>

        <footer className="text-center text-[11px] text-slate-600">
          Mapa © OpenStreetMap contributors · Tiles © Esri (Maxar, Earthstar Geographics) · Rutas OSRM · Geocodificación Photon ·
          Decisiones tipadas (choice · noul) vía TypeSafe System One — la clave solo existe en el servidor
        </footer>
      </div>
    </div>
  );
}

/* ── GPS card ─────────────────────────────────────────────────── */

function maneuverIcon(type: string, modifier: string): React.ReactNode {
  if (type === "arrive") return <Flag className="w-6 h-6" />;
  if (type.includes("roundabout")) return <RefreshCw className="w-6 h-6" />;
  if (type === "merge") return <Merge className="w-6 h-6" />;
  if (modifier.includes("left") && !modifier.includes("slight"))
    return <CornerUpLeft className="w-6 h-6" />;
  if (modifier.includes("right") && !modifier.includes("slight"))
    return <CornerUpRight className="w-6 h-6" />;
  return <ArrowUp className="w-6 h-6" />;
}

function GpsCard({
  snap,
  etaS,
  fromName,
  toName,
}: {
  snap: Snapshot | null;
  etaS: number | null;
  fromName: string;
  toName: string;
}) {
  const man = snap?.nextManeuver ?? null;
  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 rounded-xl bg-blue-600/20 border border-blue-500/40 flex items-center justify-center text-blue-300 shrink-0">
            {man ? maneuverIcon(man.type, man.modifier) : <Navigation className="w-6 h-6" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">
              {man ? `En ${Math.round(man.distanceM)} m` : "GPS"}
            </div>
            <div className="text-base font-semibold leading-snug">
              {man?.instruction ?? "Continúa hacia el destino"}
            </div>
            <div className="text-xs text-slate-400 truncate">
              {snap?.roadName || "—"}
              {snap?.afterNext ? ` · luego: ${snap.afterNext}` : ""}
            </div>
          </div>
        </div>
        <div>
          <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-500 to-emerald-400 transition-all duration-300"
              style={{ width: `${snap?.progressPct ?? 0}%` }}
            />
          </div>
          <div className="flex justify-between text-[11px] text-slate-500 mt-1">
            <span className="truncate max-w-[45%]">{fromName.split(",")[0]}</span>
            <span>
              {snap ? `${snap.progressPct}%` : "—"}
              {etaS !== null && ` · ETA ${Math.floor(etaS / 60)}:${String(etaS % 60).padStart(2, "0")}`}
            </span>
            <span className="truncate max-w-[45%] text-right">{toName.split(",")[0]}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="border-slate-600 text-slate-300">
            <Gauge className="w-3 h-3 mr-1" /> límite {snap?.speedLimitKmh ?? "-"} km/h
          </Badge>
          {snap?.cruiseActive ? (
            <Badge className="bg-emerald-600/90 hover:bg-emerald-600">
              crucero {snap.cruiseTargetKmh} km/h
            </Badge>
          ) : (
            <Badge variant="outline" className="border-slate-700 text-slate-500">
              crucero off
            </Badge>
          )}
          {snap?.emergency && (
            <Badge className="bg-red-600/90 hover:bg-red-600">frenada de emergencia</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ── shared bits ──────────────────────────────────────────────── */

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
      <span
        className={`relative flex h-2 w-2 mr-1.5 rounded-full ${
          status === "error" ? "bg-red-400" : "bg-emerald-400"
        } ${thinking ? "animate-pulse" : ""}`}
      />
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
  suggest?: boolean;
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={onClick}
      className={`gap-1.5 ${
        suggest
          ? "ring-2 ring-blue-500/70 bg-blue-950/60 hover:bg-blue-900/60"
          : "bg-slate-800 hover:bg-slate-700"
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

function DecisionTab({ decision }: { decision: DecisionView | null }) {
  if (!decision) {
    return <p className="text-sm text-slate-400 pt-4">Esperando al primer ciclo de decisión…</p>;
  }
  const resp = decision.response;
  if (decision.pending || !resp) {
    return (
      <div className="flex flex-col items-center gap-2 pt-10 text-slate-400">
        <Brain className="w-8 h-8 animate-pulse text-blue-400" />
        <p className="text-sm">Preguntando a Jev qué hacer ahora…</p>
        <p className="text-xs text-slate-500">tick #{decision.tick} · velocidad · crucero · maniobra · peligro</p>
      </div>
    );
  }
  const s = resp.answers.speed_action;
  const c = resp.answers.cruise;
  const danger = resp.answers.immediate_danger.noul;
  const manSafe = resp.answers.maneuver_ok.noul;
  const p = decision.perception;
  return (
    <ScrollArea className="h-[430px] pr-3">
      <div className="space-y-4">
        <div className="rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
          <span className="text-slate-200 font-medium">Viendo:</span> {p.traffic.laneAhead} · límite{" "}
          {p.gps.speedLimitKmh} km/h · próxima maniobra en {p.gps.distanceToManeuverM} m (
          {p.gps.nextManeuver})
        </div>
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
            ¿Crucero adaptativo?
          </h3>
          <div className="space-y-1.5">
            {Object.entries(c.probabilities)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => (
                <ProbBar key={k} label={CRUISE_LABEL[k] ?? k} prob={v} chosen={c.choice === k} />
              ))}
          </div>
          {CRUISE_VALUE[c.choice] !== null && p.gps.fastRoad === false && (
            <p className="text-[11px] text-amber-400 mt-1.5">
              Jev propone crucero pero la vía no es rápida (límite {p.gps.speedLimitKmh}) → se ignora
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border border-slate-800 px-3 py-2.5">
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-slate-300">Maniobra segura</span>
              <span className="font-mono">{Math.round(manSafe * 100)}%</span>
            </div>
            <div className="relative h-2 rounded-full bg-slate-800 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${manSafe < 0.4 ? "bg-amber-500" : "bg-emerald-500"}`}
                style={{ width: `${Math.max(Math.round(manSafe * 100), 2)}%` }}
              />
              <div className="absolute top-0 bottom-0 w-px bg-white/50" style={{ left: "40%" }} />
            </div>
            <p className="text-[10px] text-slate-500 mt-1">&lt; 40% frena para la maniobra</p>
          </div>
          <div className="rounded-md border border-slate-800 px-3 py-2.5">
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-slate-300">Peligro inminente</span>
              <span className="font-mono">{Math.round(danger * 100)}%</span>
            </div>
            <div className="relative h-2 rounded-full bg-slate-800 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${danger >= 0.55 ? "bg-red-500" : "bg-emerald-500"}`}
                style={{ width: `${Math.max(Math.round(danger * 100), 2)}%` }}
              />
              <div className="absolute top-0 bottom-0 w-px bg-white/50" style={{ left: "55%" }} />
            </div>
            <p className="text-[10px] text-slate-500 mt-1">≥ 55% frena en emergencia</p>
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
            <span className="text-blue-300">
              {" "}· Modo humano{decision.humanApplied ? " · última orden aplicada por ti" : ""}
            </span>
          )}
        </p>
      </div>
    </ScrollArea>
  );
}

function LogTab({ log }: { log: DecisionLogEntry[] }) {
  if (log.length === 0)
    return <p className="text-sm text-slate-400 pt-4">Aún no hay decisiones registradas.</p>;
  return (
    <ScrollArea className="h-[430px] pr-3">
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
            <Badge
              variant="outline"
              className={
                e.cruise === "off"
                  ? "border-slate-700 text-slate-500"
                  : "border-emerald-500/40 text-emerald-300"
              }
            >
              {CRUISE_LABEL[e.cruise].replace("Crucero ", "C")}
            </Badge>
            <span className={`font-mono ${e.danger >= 0.55 ? "text-red-400" : "text-slate-400"}`}>
              ⚠{Math.round(e.danger * 100)}%
            </span>
            <span className={`font-mono ${e.maneuverSafe < 0.4 ? "text-amber-400" : "text-slate-500"}`}>
              ↪{Math.round(e.maneuverSafe * 100)}%
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

function ApiTab({ decision }: { decision: DecisionView | null }) {
  const request = decision
    ? { model: "jev-latest", state: decision.perception, questions: DECISION_QUESTIONS }
    : null;
  return (
    <ScrollArea className="h-[430px] pr-3">
      <div className="space-y-3">
        <p className="text-xs text-slate-400">
          Petición real enviada por el servidor proxy (la clave nunca sale del servidor) y respuesta
          tipada de <span className="font-mono">api.typesafe.ai/v1/systemone</span>.
        </p>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
            → Request (estado GPS + tráfico)
          </h3>
          <pre className="text-[11px] font-mono rounded-md bg-black/50 border border-slate-800 p-3 overflow-auto max-h-72">
            {request ? JSON.stringify(request, null, 2) : "…"}
          </pre>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
            ← Response
          </h3>
          <pre className="text-[11px] font-mono rounded-md bg-black/50 border border-slate-800 p-3 overflow-auto max-h-72">
            {decision?.response ? JSON.stringify(decision.response, null, 2) : "…"}
          </pre>
        </div>
      </div>
    </ScrollArea>
  );
}
