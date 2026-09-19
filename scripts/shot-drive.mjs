import { chromium } from '/home/kimi/.npm-global/lib/node_modules/playwright/index.mjs';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
// click the Madrid Sol→Chamartín example chip
await page.getByRole('button', { name: 'Madrid: Sol → Chamartín' }).click();
await page.waitForTimeout(1000);
await page.getByRole('button', { name: 'Iniciar simulación' }).click();
// autopilot starts driving; let it get going
await page.waitForTimeout(30000);
await page.screenshot({ path: '/tmp/verify2.png' });
await page.waitForTimeout(30000);
await page.screenshot({ path: '/tmp/verify3.png' });
await browser.close();
console.log('ok');
