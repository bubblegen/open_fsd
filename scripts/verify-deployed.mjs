// Verify the deployed site end-to-end: chip → route → sim starts.
import { chromium } from "/home/kimi/.npm-global/lib/node_modules/playwright/index.mjs";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(e.message));

await page.goto("https://ofsd.kimi.pro/", { waitUntil: "networkidle", timeout: 60000 });
await page.getByRole("button", { name: "Madrid: Sol → Chamartín" }).click();
await page.getByRole("button", { name: "Iniciar simulación" }).click();

// wait for the game canvas + speed readout (route loaded, engine running)
try {
  await page.waitForFunction(
    () => document.body.innerText.includes("km/h"),
    { timeout: 45000 },
  );
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 600));
  console.log("SIM STARTED OK");
  console.log(txt.split("\n").filter((l) => l.trim()).slice(0, 12).join(" | "));
} catch {
  const txt = await page.evaluate(() => document.body.innerText);
  console.log("SIM DID NOT START. Page text:");
  console.log(txt.split("\n").filter((l) => l.trim()).slice(0, 25).join("\n"));
}
if (errors.length) {
  console.log("--- console errors ---");
  for (const e of errors.slice(0, 8)) console.log(e);
}
await page.screenshot({ path: "/tmp/deployed-check.png" });
await browser.close();
