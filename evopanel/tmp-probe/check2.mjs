import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('http://localhost:1420/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await page.evaluate(()=>{window.__l=[];window.__t0=performance.now();
 const loop=()=>{const q=s=>document.querySelector(s); const rr=e=>e?Math.round(e.getBoundingClientRect().top):null;
  const st={t:Math.round(performance.now()-window.__t0), dock: rr(q('[data-v4-composer-dock="true"]')),
    draft: !!q('[data-testid="v4-draft-empty"]'), greet: q('[data-v4-draft-greeting]')?.innerText?.trim().slice(0,10)};
  const p=window.__l[window.__l.length-1];
  if(!p||JSON.stringify({...p,t:0})!==JSON.stringify({...st,t:0})) window.__l.push(st);
  if(window.__l.length<50) requestAnimationFrame(loop);};
 requestAnimationFrame(loop);});
await page.locator('button[title^="新建对话"]').first().click();
await page.waitForTimeout(5000);
console.log(JSON.stringify(await page.evaluate(()=>window.__l)));
await browser.close();
