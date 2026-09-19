/**
 * Shared contract for the TypeSafe "System One" (Jev) decision endpoint.
 * The backend proxies api.typesafe.ai so the API key never reaches the browser;
 * the frontend renders the typed answers (choices with probabilities, noul
 * probabilities, confidence and latency).
 */

export const TYPESAFE_MODEL = "jev-latest";

export type Direction = "straight" | "left" | "right";
export type SpeedAction = "accelerate" | "maintain" | "brake";
export type Heading = "N" | "E" | "S" | "W";

/** Structured world-state the game sends to Jev every decision tick. */
export interface PerceptionState {
  tick: number;
  autopilot: {
    speedKmh: number;
    speedLimitKmh: number;
    heading: Heading;
    distanceToIntersectionM: number;
    availableDirections: Direction[];
    destinationRelative: string;
    destinationHint: Direction;
  };
  perception: {
    laneAhead: string;
    vehicleAhead: { type: string; distanceM: number; speedKmh: number } | null;
    oncomingVehicle: { distanceM: number; speedKmh: number } | null;
    pedestrian: { distanceM: number } | null;
  };
}

/** The typed questions the game asks Jev — fixed decision contract. */
export const DECISION_QUESTIONS = {
  speed_action: {
    type: "choice",
    instructions:
      "Eres el piloto automático de un Tesla. Según el estado percibido, ¿cómo debe ajustar la velocidad AHORA MISMO? Respeta los límites y mantén distancia de seguridad.",
    criteria: {
      accelerate:
        "Acelerar para ARRANCAR desde parado (si la vía está despejada) o para acercarse al límite de velocidad en un tramo despejado. NUNCA elegir si el coche ya va cerca del límite",
      maintain:
        "Mantener la velocidad actual SOLO si ya se está circulando a velocidad razonable. NUNCA elegir estando parado (0 km/h): en ese caso toca acelerar",
      brake:
        "Frenar o detenerse: hay un obstáculo, un peatón, un coche lento o un cruce peligroso",
    },
  },
  next_direction: {
    type: "choice",
    instructions:
      "En el próximo cruce, ¿hacia dónde debe girar el Tesla para progresar hacia su destino? SOLO elige entre las direcciones disponibles del estado; si el destino sigue recto, elige straight.",
    criteria: {
      straight: "Seguir recto por la misma calle",
      left: "Girar a la izquierda en el cruce",
      right: "Girar a la derecha en el cruce",
    },
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
    next_direction: ChoiceAnswer;
    immediate_danger: NoulAnswer;
  };
  usage?: { input_tokens: number; output_tokens: number };
}
