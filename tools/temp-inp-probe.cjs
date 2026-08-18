'use strict';
const fs = require('node:fs');
const { chromium, devices } = require('playwright');

const runs = +(process.env.RUNS || 2);
const settle = +(process.env.SETTLE_MS || 6000);
const after = +(process.env.AFTER_MS || 2500);
const home = 'https://www.emlakjet.com/';
const listing = 'https://www.emlakjet.com/satilik-konut';
const trackers = ['googletagmanager','google-analytics','doubleclick','clarity.ms','hotjar','facebook','deengage','relateddigital','euromsg','useinsider','criteo','gemius','newrelic','nr-data','sentry'];
const cases = [
  ['home-early-rent', home, 'early', 'text', 'Kiralık'],
  ['home-settled-rent', home, 'settled', 'text', 'Kiralık'],
  ['home-early-search', home, 'early', 'input', ''],
  ['home-settled-land', home, 'settled', 'text', 'Arsa'],
  ['listing-early-filter', listing, 'early', 'text', 'Filtrele'],
  ['listing-settled-filter', listing, 'settled', 'text', 'Filtrele'],
  ['listing-settled-map', listing, 'settled', 'text', 'Harita'],
  ['listing-settled-sort', listing, 'settled', 'text', 'Akıllı Sıralama'],
  ['home-early-rent-no-trackers', home, 'early', 'text', 'Kiralık', true],
  ['listing-early-filter-no-trackers', listing, 'early', 'text', 'Filtrele', true],
];
const r = n => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;

function installProbe() {
  const p = globalThis.__probe = { events: [], tasks: [], loafs: [], errors: [], supported: PerformanceObserver.supportedEntryTypes || [] };
  const cap = (a, v, n=500) => { a.push(v); if (a.length > n) a.shift(); };
  const target = t => {
    try {
      if (!(t instanceof Element)) return null;
      return `${t.tagName.toLowerCase()}${t.id ? '#'+t.id : ''} text=${String(t.textContent||'').replace(/\s+/g,' ').trim().slice(0,100)} aria=${t.getAttribute('aria-label')||''}`.slice(0,260);
    } catch { return null; }
  };
  try { new PerformanceObserver(l => l.getEntries().forEach(e => cap(p.events, {
    name:e.name,start:e.startTime,duration:e.duration,ps:e.processingStart,pe:e.processingEnd,id:e.interactionId||0,target:target(e.target)
  }))).observe({type:'event',buffered:true,durationThreshold:16}); } catch(e) { p.errors.push('event:'+e.message); }
  try { new PerformanceObserver(l => l.getEntries().forEach(e => cap(p.tasks, {
    start:e.startTime,duration:e.duration,attribution:(e.attribution||[]).map(a=>({name:a.name,src:a.containerSrc,type:a.containerType}))
  }))).observe({type:'longtask',buffered:true}); } catch(e) { p.errors.push('task:'+e.message); }
  try { new PerformanceObserver(l => l.getEntries().forEach(e => cap(p.loafs, {
    start:e.startTime,duration:e.duration,blocking:e.blockingDuration,render:e.renderStart,layout:e.styleAndLayoutStart,
    scripts:(e.scripts||[]).map(s=>({duration:s.duration,url:s.sourceURL,fn:s.sourceFunctionName,invoker:s.invoker,forced:s.forcedStyleAndLayoutDuration})).sort((a,b)=>b.duration-a.duration).slice(0,20)
  }))).observe({type:'long-animation-frame',buffered:true}); } catch(e) { p.errors.push('loaf:'+e.message); }
}

async function targetByText(page, text) {
  for (let attempt=0; attempt<80; attempt++) {
    const loc = page.getByText(text, { exact:true });
    const count = Math.min(await loc.count().catch(()=>0), 40);
    let best = null;
    for (let i=0; i<count; i++) {
      const el = loc.nth(i), box = await el.boundingBox().catch(()=>null);
      if (!box || box.width<3 || box.height<3 || box.y < -20 || box.y > 1100) continue;
      const tag = await el.evaluate(e=>e.tagName.toLowerCase()).catch(()=> '');
      const score = (/button|a|label/.test(tag) ? 1000 : 0) - box.y;
      if (!best || score > best.score) best = {el,box,score,tag,text};
    }
    if (best) return best;
    await new Promise(q=>setTimeout(q,150));
  }
  return null;
}

async function targetInput(page) {
  for (let attempt=0; attempt<80; attempt++) {
    const loc = page.locator('input:not([type=hidden]),textarea');
    const count = Math.min(await loc.count().catch(()=>0), 80);
    let best = null;
    for (let i=0; i<count; i++) {
      const el=loc.nth(i), box=await el.boundingBox().catch(()=>null);
      if (!box || box.width<80 || box.height<15 || box.y < -20 || box.y > 900) continue;
      const meta=await el.evaluate(e=>({p:e.getAttribute('placeholder')||'',a:e.getAttribute('aria-label')||'',t:e.getAttribute('type')||''})).catch(()=>({p:'',a:'',t:''}));
      const hint=(meta.p+' '+meta.a).toLocaleLowerCase('tr-TR');
      const score=(/ara|il|ilçe|mahalle|konum|nerede/.test(hint)?1000:0)+(meta.t==='search'?500:0)+box.width-box.y/5;
      if (!best || score>best.score) best={el,box,score,tag:'input',text:meta.p||meta.a};
    }
    if (best) return best;
    await new Promise(q=>setTimeout(q,150));
  }
  return null;
}

function summarize(p) {
  const groups = new Map();
  for (const e of (p.events||[]).filter(e=>e.id>0)) { if(!groups.has(e.id)) groups.set(e.id,[]); groups.get(e.id).push(e); }
  const interactions=[...groups.entries()].map(([id,es])=>{
    const e=[...es].sort((a,b)=>b.duration-a.duration)[0];
    return {id,latency:r(e.duration),event:e.name,target:e.target,start:r(e.start),input:r(e.ps-e.start),processing:r(e.pe-e.ps),presentation:r(Math.max(0,e.start+e.duration-e.pe)),events:es.map(x=>({name:x.name,duration:r(x.duration)}))};
  }).sort((a,b)=>b.latency-a.latency);
  const w=interactions[0]||null, start=w?w.start:-1, end=w?w.start+w.latency:-1;
  const tasks=(p.tasks||[]).filter(x=>x.start<end&&x.start+x.duration>start).map(x=>({...x,start:r(x.start),duration:r(x.duration)})).sort((a,b)=>b.duration-a.duration).slice(0,10);
  const loafs=(p.loafs||[]).filter(x=>x.start<end&&x.start+x.duration>start).map(x=>({...x,start:r(x.start),duration:r(x.duration),blocking:r(x.blocking),scripts:(x.scripts||[]).map(s=>({...s,duration:r(s.duration),forced:r(s.forced)}))})).sort((a,b)=>b.duration-a.duration).slice(0,10);
  const sm=new Map(); for(const l of loafs) for(const s of l.scripts||[]) { const k=s.url||s.invoker||s.fn||'(anonymous)'; sm.set(k,(sm.get(k)||0)+(s.duration||0)); }
  return {worst:w,interactions,tasks,loafs,topScripts:[...sm].map(([source,duration])=>({source,duration:r(duration)})).sort((a,b)=>b.duration-a.duration).slice(0,10),errors:p.errors,supported:p.supported};
}

async function one(browser, c, run) {
  const [id,url,phase,kind,value,noTrackers]=c;
  const context=await browser.newContext({...devices['Pixel 5'],locale:'tr-TR',timezoneId:'Europe/Istanbul',serviceWorkers:'allow'});
  const blocked=new Set();
  if(noTrackers) await context.route('**/*', async route=>{
    const u=route.request().url().toLowerCase(), hit=trackers.find(x=>u.includes(x));
    if(hit){ try{blocked.add(new URL(route.request().url()).hostname)}catch{blocked.add(hit)}; await route.abort('blockedbyclient'); } else await route.continue();
  });
  await context.addInitScript(installProbe);
  const page=await context.newPage(), cdp=await context.newCDPSession(page);
  page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(60000);
  const scripts=[],failed=[],consoleErrors=[];
  page.on('response',x=>{if(x.request().resourceType()==='script') scripts.push({url:x.url(),status:x.status(),bytes:+(x.headers()['content-length']||0)});});
  page.on('requestfailed',x=>failed.push({url:x.url(),type:x.resourceType(),error:x.failure()?.errorText}));
  page.on('console',x=>{if(x.type()==='error')consoleErrors.push(x.text());});
  await cdp.send('Network.enable'); await cdp.send('Performance.enable'); await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:150,downloadThroughput:209715,uploadThroughput:96000,connectionType:'cellular3g'});
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  let navError=null, actionError=null, actionTarget=null;
  try{await page.goto(url,{waitUntil:'commit',timeout:60000});}catch(e){navError=e.message;}
  try{
    await page.waitForFunction(()=>!!document.body,null,{timeout:20000});
    if(phase==='settled'){await page.waitForLoadState('domcontentloaded',{timeout:30000}).catch(()=>{}); await new Promise(q=>setTimeout(q,settle));}
    const t=kind==='input'?await targetInput(page):await targetByText(page,value);
    if(!t) throw new Error(`target not found: ${kind}:${value}`);
    const x=t.box.x+t.box.width/2,y=t.box.y+t.box.height/2; actionTarget={text:t.text,tag:t.tag,x:r(x),y:r(y),box:t.box};
    await page.touchscreen.tap(x,y); await new Promise(q=>setTimeout(q,after));
  }catch(e){actionError=e.message;}
  const title=await page.title().catch(()=>''), currentUrl=page.url();
  const body=await page.locator('body').innerText({timeout:3000}).then(x=>x.replace(/\s+/g,' ').slice(0,500)).catch(()=> '');
  const p=await page.evaluate(()=>({...globalThis.__probe,resources:performance.getEntriesByType('resource').filter(x=>x.initiatorType==='script').map(x=>({name:x.name,duration:x.duration,transferSize:x.transferSize})).sort((a,b)=>b.duration-a.duration).slice(0,30)})).catch(e=>({errors:['read:'+e.message]}));
  const metrics=await cdp.send('Performance.getMetrics').then(x=>Object.fromEntries(x.metrics.filter(m=>['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','JSHeapUsedSize','Nodes'].includes(m.name)).map(m=>[m.name,m.value]))).catch(()=>({}));
  const out={id,run,url,currentUrl,title,phase,noTrackers:!!noTrackers,blocked:[...blocked],navError,actionError,actionTarget,body,summary:summarize(p),metrics,scriptCount:scripts.length,scriptBytes:scripts.reduce((a,x)=>a+x.bytes,0),topScriptResponses:scripts.sort((a,b)=>b.bytes-a.bytes).slice(0,15),topScriptResources:p.resources,failed:failed.slice(0,50),consoleErrors:consoleErrors.slice(0,50)};
  await context.close(); return out;
}

function aggregate(results){
  return cases.map(c=>{
    const rs=results.filter(x=>x.id===c[0]), ws=rs.map(x=>x.summary?.worst).filter(Boolean), v=k=>ws.map(x=>x[k]).filter(Number.isFinite);
    const stat=a=>a.length?{min:Math.min(...a),max:Math.max(...a),median:[...a].sort((x,y)=>x-y)[Math.floor((a.length-1)/2)]}:{min:null,max:null,median:null};
    const sm=new Map(); for(const x of rs) for(const s of x.summary?.topScripts||[]) sm.set(s.source,(sm.get(s.source)||0)+s.duration);
    return {scenario:c[0],valid:ws.length,errors:rs.filter(x=>x.navError||x.actionError).map(x=>({run:x.run,nav:x.navError,action:x.actionError})),latency:stat(v('latency')),input:stat(v('input')),processing:stat(v('processing')),presentation:stat(v('presentation')),targets:[...new Set(ws.map(x=>x.target).filter(Boolean))],topScripts:[...sm].map(([source,duration])=>({source,duration:r(duration)})).sort((a,b)=>b.duration-a.duration).slice(0,8)};
  });
}

(async()=>{
  const browser=await chromium.launch({headless:true,args:['--disable-blink-features=AutomationControlled','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-sandbox']});
  const results=[];
  try{for(const c of cases)for(let i=1;i<=runs;i++){console.log(`RUN ${c[0]} ${i}/${runs}`);const x=await one(browser,c,i).catch(e=>({id:c[0],run:i,fatal:e.stack||e.message}));results.push(x);console.log(JSON.stringify({id:x.id,run:x.run,url:x.currentUrl,title:x.title,navError:x.navError,actionError:x.actionError,target:x.actionTarget,worst:x.summary?.worst,topScripts:x.summary?.topScripts?.slice(0,4),blocked:x.blocked,fatal:x.fatal},null,2));}}finally{await browser.close();}
  const out={generatedAt:new Date().toISOString(),profile:{device:'Pixel 5',cpu:'4x',latencyMs:150,downloadMbps:1.6,cache:'disabled',runs},aggregate:aggregate(results),results};
  fs.writeFileSync('inp-results.json',JSON.stringify(out,null,2)); console.log('AGGREGATE\n'+JSON.stringify(out.aggregate,null,2));
})();
