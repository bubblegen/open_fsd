// Reproduce the browser crash and capture the exact reason + API health.
// Runs the Madrid chip route until the trip ends (crash or arrival) or timeout.
import { chromium } from "/home/kimi/.npm-global/lib/node_modules/playwright/index.mjs";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleMsgs = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") consoleMsgs.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => consoleMsgs.push(`[pageerror] ${e.message}`));

await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Madrid: Sol → Chamartín" }).click();
await page.getByRole("button", { name: "Iniciar simulación" }).click();

// poll for trip end (overlay) every 2 s, up to 150 s
let trip = null;
const t0 = Date.now();
while (Date.now() - t0 < 150000) {
  await page.waitForTimeout(2000);
  trip = await page.evaluate(() => window.__lastTrip ?? null);
  if (trip) break;
}

if (trip) {
  console.log("TRIP ENDED:", JSON.stringify(trip, null, 1));
} else {
  console.log("no trip end within 150s — still running");
  const snap = await page.evaluate(() => window.__snap ?? null);
  console.log("last snap:", JSON.stringify(snap));
}
await page.screenshot({ path: "/tmp/catch-crash.png" });
if (consoleMsgs.length) {
  console.log("--- console/page errors (last 15) ---");
  for (const m of consoleMsgs.slice(-15)) console.log(m);
}
await browser.close();
