/**
 * Shared contract for the TypeSafe "System One" (Jev) decision endpoint.
 * The backend proxies api.typesafe.ai so the API key never reaches the browser;
 * the frontend renders the typed answers (choices with probabilities, noul
 * probabilities, confidence and latency).
 */

export const TYPESAFE_MODEL = "jev-latest";

export type SpeedAction = "accelerate" | "maintain" | "brake";
export type CruiseChoice = "cruise_80" | "cruise_100" | "cruise_120" | "off";

/** Structured world-state the game sends to Jev every decision tick. */
export interface PerceptionState {
  tick: number;
  gps: {
    /** seconds since trip start (debug) */
    elapsedS?: number;
    speedKmh: number;
    speedLimitKmh: number;
    roadName: string;
    progressPct: number;
    remainingM: number;
    distanceToManeuverM: number;
    /** human-readable instruction of the next route maneuver */
    nextManeuver: string;
    maneuverType: string; // turn | roundabout | fork | merge | arrive | continue...
    maneuverModifier: string; // left | right | straight | slight left...
    afterNextManeuver: string | null;
    cruiseActive: boolean;
    cruiseTargetKmh: number | null;
    fastRoad: boolean; // speed limit >= 90 → cruise allowed
  };
  traffic: {
    laneAhead: string;
    /** EXPLICIT flag: true = no vehicle, no pedestrian, no obstacle at all */
    viaDespejada: boolean;
    vehicleAhead: { type: string; distanceM: number; speedKmh: number } | null;
    oncomingVehicle: { type: string; distanceM: number; speedKmh: number } | null;
    emergencyVehicle: { type: string; distanceM: number; speedKmh: number } | null;
    pedestrian: {
      kind: "persona" | "perro";
      distanceM: number;
      /** metres from the car's lane centre; 0 = directly in our path */
      lateralM?: number;
      /** walking toward our lane right now */
      closing?: boolean;
      /** seconds until the pedestrian clears our lane corridor */
      clearsInS?: number;
    } | null;
  };
}

/** The typed questions the game asks Jev — fixed decision contract. */
export const DECISION_QUESTIONS = {
  speed_action: {
    type: "choice",
    instructions:
      "Eres el piloto automático de un Tesla Model 3. Decides la velocidad cada segundo. " +
      "REGLA DE ORO: frena ÚNICAMENTE si en el estado percibido hay un obstáculo REAL: " +
      "peatón/perro a menos de 35 m cruzando hacia tu carril, o vehículo delante a menos de 25 m " +
      "más lento que tú. " +
      "Si traffic.viaDespejada es true (sin peatón y sin vehículo delante), ESTÁ PROHIBIDO frenar: " +
      "elige accelerate si vas por debajo del límite-2, en caso contrario maintain. " +
      "Una maniobra a más de 80 m NO es motivo para frenar. " +
      "Nunca frenes por precaución general, por curvas lejanas ni por hipótesis: solo por lo que el estado lista explícitamente. " +
      "En autopista/vía rápida despejada mantén velocidad de crucero, no frenes.",
    criteria: {
      accelerate:
        "Elegir SIEMPRE que la vía esté despejada (viaDespejada=true) y se vaya por debajo del límite-2, incluido arrancar desde 0 km/h. También para alcanzar la velocidad de crucero en vía rápida despejada. PROHIBIDO solo si hay obstáculo real cerca o se supera el límite",
      maintain:
        "Mantener la velocidad SOLO cuando se está cerca del límite (a menos de 2 km/h) o siguiendo un vehículo a distancia segura. PROHIBIDO estando parado (0 km/h) con la vía despejada: ahí toca accelerate",
      brake:
        "PROHIBIDO si viaDespejada=true. Solo permitido con obstáculo REAL en el estado: peatón/perro a <35 m con trayectoria hacia tu carril que no despeja antes de tu llegada, o vehículo delante a <25 m más lento, o peligro inminente. NUNCA por precaución, maniobras lejanas o vías despejadas",
    },
  },
  cruise: {
    type: "choice",
    instructions:
      "¿Debe activar el control de crucero adaptativo y a qué velocidad? El crucero SOLO tiene sentido en vías rápidas (límite ≥ 90) y despejadas (viaDespejada=true); en ciudad o con tráfico debe estar apagado.",
    criteria: {
      cruise_80: "Fijar el crucero a 80 km/h (vía rápida con tráfico moderado)",
      cruise_100: "Fijar el crucero a 100 km/h (vía rápida despejada)",
      cruise_120: "Fijar el crucero a 120 km/h (autovía despejada)",
      off: "Crucero desactivado: conducción urbana, maniobra próxima o tráfico denso",
    },
  },
  maneuver_ok: {
    type: "noul",
    instructions:
      "La ruta GPS indica la siguiente maniobra a la distancia indicada. ¿Es seguro CONTINUAR hacia esa maniobra ahora (velocidad adecuada y sin obstáculos en la trayectoria)? Responde con la probabilidad de que sea seguro; si es arriesgado, el coche frenará.",
  },
  immediate_danger: {
    type: "noul",
    instructions:
      "¿Existe PELIGRO INMINENTE de colisión que exija una frenada de emergencia en este instante?",
  },
} as const;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface DecideResponse {
  model: string;
  latencyMs: number;
  answers: {
    speed_action: ChoiceAnswer;
    cruise: ChoiceAnswer;
    maneuver_ok: NoulAnswer;
    immediate_danger: NoulAnswer;
  };
  usage?: { input_tokens: number; output_tokens: number };
}
