import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs=[]; page.on('pageerror', e=>errs.push(String(e).slice(0,140)));
await page.goto('http://localhost:1420/#/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await page.locator('button[title^="新建对话"]').first().click();
await page.waitForTimeout(5000);
console.log(JSON.stringify(await page.evaluate(()=>{
  const q = s => document.querySelector(s);
  const draft = q('[data-testid="v4-draft-empty"]');
  const svgCount = draft ? draft.querySelectorAll('svg,img').length : null;
  const greeting = q('[data-v4-draft-greeting]');
  return {
    draftFound: !!draft,
    svgOrImgInside: svgCount,
    greetingText: greeting ? greeting.innerText.trim() : null,
    greetingFontSize: greeting ? getComputedStyle(greeting).fontSize : null,
    dock: q('[data-v4-composer-dock="true"]') ? Math.round(q('[data-v4-composer-dock="true"]').getBoundingClientRect().top) : null,
    draftHTML: draft ? draft.innerHTML.slice(0,220) : null,
  };
}), null, 1));
await page.screenshot({ path: 'tmp-probe/newchat.png' });
console.log('errors:', errs.length ? errs : 'none');
await browser.close();
