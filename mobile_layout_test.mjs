// Optional real-browser regression: npm install --no-save playwright
// Run: CHROME_PATH=/usr/bin/google-chrome node mobile_layout_test.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const css = readFileSync(new URL('style.css', import.meta.url), 'utf8');
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true, args: ['--no-sandbox'] });
try {
    for (const [width, height] of [[360, 740], [384, 740], [412, 915], [550, 320], [1280, 900]]) {
        const page = await browser.newPage({ viewport: { width, height }, isMobile: width <= 550, hasTouch: width <= 550 });
        // These host rules reproduce ST's real zero-height transformed root.
        await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
            * { box-sizing:border-box } html { transform:translateZ(0); perspective:1000px }
            body { margin:0; height:100dvh } @media(max-width:550px) { body { position:fixed; width:100% } }
            ${css}</style><div id="chatassist_panel"><div id="chatassist_header">Chat Assistant</div></div>`);
        await page.evaluate(() => document.getElementById('chatassist_panel').classList.add('cc_open'));
        for (const full of [false, true]) {
            await page.evaluate(full => document.getElementById('chatassist_panel').classList.toggle('cc_fullscreen', full), full);
            const result = await page.evaluate(() => {
                const p = document.getElementById('chatassist_panel'), r = p.getBoundingClientRect();
                return { top:r.top, bottom:r.bottom, left:r.left, right:r.right,
                    hit:p.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 10)) };
            });
            assert.ok(result.top >= 0 && result.bottom <= height + 1 && result.left >= 0 && result.right <= width + 1 && result.hit,
                `${width}x${height} fullscreen=${full}: panel must be visible and hittable: ${JSON.stringify(result)}`);
        }
        console.log(`${width}x${height}: windowed/fullscreen visible and hittable PASS`);
        await page.close();
    }
} finally { await browser.close(); }
