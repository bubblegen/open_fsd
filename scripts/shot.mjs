import { chromium } from '/home/kimi/.npm-global/lib/node_modules/playwright/index.mjs';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
await page.waitForTimeout(9000);
await page.screenshot({ path: '/tmp/verify.png' });
await browser.close();
console.log('ok');
