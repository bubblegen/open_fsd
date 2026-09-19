import { AutopilotGame } from "../src/game/engine";
import type { DecideResponse, PerceptionState } from "../contracts/ai";
import type { RouteData } from "../contracts/geo";
const url = "http://localhost:3000/api/trpc/geo.route?input=" + encodeURIComponent('{"json":{"fromLat":40.416863,"fromLon":-3.7038762,"toLat":40.4721,"toLon":-3.6823}}');
const route = (await (await fetch(url)).json()).result.data.json as RouteData;
const stub = (s: PerceptionState): DecideResponse => ({ model:"x", answers:{
  speed_action:{type:"choice",choice:"accelerate",confidence:1,probabilities:{}},
  cruise:{type:"choice",choice:"off",confidence:1,probabilities:{}},
  maneuver_ok:{type:"noul",noul:0.9,confidence:1},
  immediate_danger:{type:"noul",noul:0.05,confidence:1}}, usage:{input_tokens:0,output_tokens:0}});
let ended = null;
const e = new AutopilotGame(route, { onFrame(){}, onDecision(){}, onLog(){}, onError(m){console.log("ERR",m)}, onTripEnd(r){ended=r}, requestDecision: async s=>stub(s) }, { decisionEveryMs: 0 });
for (let i=0;i<30*40;i++){ e.update(1/30); if (i%(5*30)===0){ const rs=e.renderState(); console.log(`t=${(i/30).toFixed(0)}s cross=${rs.crossings.length} traffic=${rs.traffic.length} nextMan=${rs.nextManeuver?Math.round(rs.nextManeuver.distanceM):"-"}`);} if(i%10===0) await new Promise(r=>setImmediate(r)); }
