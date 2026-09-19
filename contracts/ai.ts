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
    vehicleAhead: { type: string; distanceM: number; speedKmh: number } | null;
    oncomingVehicle: { type: string; distanceM: number; speedKmh: number } | null;
    emergencyVehicle: { type: string; distanceM: number; speedKmh: number } | null;
    pedestrian: { kind: "persona" | "perro"; distanceM: number } | null;
  };
}

/** The typed questions the game asks Jev — fixed decision contract. */
export const DECISION_QUESTIONS = {
  speed_action: {
    type: "choice",
    instructions:
      "Eres el piloto automático de un Tesla. Según el GPS y el tráfico percibido, ¿cómo debe ajustar la velocidad AHORA MISMO? Respeta el límite de la vía y mantén distancia de seguridad.",
    criteria: {
      accelerate:
        "Acelerar para ARRANCAR desde parado (si la vía está despejada) o acercarse al límite de velocidad en un tramo despejado. NUNCA elegir si ya se va cerca del límite o hay obstáculos",
      maintain:
        "Mantener la velocidad actual SOLO si ya se circula a velocidad razonable y estable. NUNCA elegir estando parado (0 km/h)",
      brake:
        "Frenar o detenerse: hay un obstáculo, un peatón/perro cruzando, un coche lento, una maniobra próxima o un cruce peligroso",
    },
  },
  cruise: {
    type: "choice",
    instructions:
      "¿Debe activar el control de crucero adaptativo y a qué velocidad? El crucero SOLO tiene sentido en vías rápidas (límite ≥ 90) y despejadas; en ciudad o tráfico denso debe estar apagado.",
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
