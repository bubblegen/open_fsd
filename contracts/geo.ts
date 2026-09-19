/** Shared geo types for the real-map simulation (Photon geocoder + OSRM routing). */

export interface GeoPlace {
  id: string;
  name: string; // human-readable label
  lat: number;
  lon: number;
}

export interface RouteStep {
  /** OSRM maneuver type: depart, turn, new name, continue, roundabout, exit, fork, merge, arrive... */
  type: string;
  /** OSRM modifier: left, right, straight, slight left, uturn... */
  modifier: string;
  name: string; // street name or ref
  distanceM: number;
  lon: number;
  lat: number;
  /** roundabout exit number when applicable */
  exit?: number;
}

export interface RouteData {
  distanceM: number;
  durationS: number;
  /** full polyline as [lon, lat] pairs */
  points: [number, number][];
  steps: RouteStep[];
}
