'use strict';
const fs=require('node:fs');
const {chromium,devices}=require('playwright');
const RUNS=+(process.env.RUNS||2),SETTLE=+(process.env.SETTLE_MS||6000),AFTER=+(process.env.AFTER_MS||2500);
const HOME='https://www.emlakjet.com/',LIST='https://www.emlakjet.com/satilik-konut';
const TRACKERS=['googletagmanager','google-analytics','doubleclick','clarity.ms','hotjar','facebook','deengage','dengage','relateddigital','euromsg','useinsider','criteo','gemius','newrelic','nr-data','sentry'];
const CASES=[
 {id:'home-early-rent',url:HOME,phase:'early',action:{role:'button',text:'Kiralık'}},
 {id:'home-settled-search',url:HOME,phase:'settled',action:{text:'Kelime, semt veya ilan no ile ara...'}},
 {id:'listing-early-filter',url:LIST,phase:'early',action:{role:'button',text:'Filtrele'}},
 {id:'listing-settled-filter',url:LIST,phase:'settled',action:{role:'button',text:'Filtrele'}},
 {id:'listing-settled-filter-no-trackers',url:LIST,phase:'settled',noTrackers:true,action:{role:'button',text:'Filtrele'}},
 {id:'listing-settled-map',url:LIST,phase:'settled',action:{role:'button',text:'Harita'}},
 {id:'listing-settled-map-no-trackers',url:LIST,phase:'settled',noTrackers:true,action:{role:'button',text:'Harita'}},
 {id:'listing-settled-sort',url:LIST,phase:'settled',action:{text:'Akıllı Sıralama',scroll:true}},
 {id:'listing-filter-8x',url:LIST,phase:'settled',cpu:8,action:{role:'button',text:'Filtrele'}},
 {id:'listing-map-8x',url:LIST,phase:'settled',cpu:8,action:{role:'button',text:'Harita'}},
];
const round=n=>Number.isFinite(n)?Math.round(n*10)/10:null;

function installProbe(){
 const p=globalThis.__probe={events:[],tasks:[],loafs:[],errors:[],supported:PerformanceObserver.supportedEntryTypes||[]},cap=(a,v,n=600)=>{a.push(v);if(a.length>n)a.shift()};
 const desc=t=>{try{if(!(t instanceof Element))return null;return `${t.tagName.toLowerCase()}${t.id?'#'+t.id:''} text=${String(t.textContent||'').replace(/\s+/g,' ').trim().slice(0,120)} aria=${t.getAttribute('aria-label')||''}`.slice(0,300)}catch{return null}};
 try{new PerformanceObserver(l=>l.getEntries().forEach(e=>cap(p.events,{name:e.name,start:e.startTime,duration:e.duration,ps:e.processingStart,pe:e.processingEnd,id:e.interactionId||0,target:desc(e.target)}))).observe({type:'event',buffered:true,durationThreshold:16})}catch(e){p.errors.push('event:'+e.message)}
 try{new PerformanceObserver(l=>l.getEntries().forEach(e=>cap(p.tasks,{start:e.startTime,duration:e.duration,attribution:(e.attribution||[]).map(a=>({name:a.name,src:a.containerSrc,type:a.containerType}))}))).observe({type:'longtask',buffered:true})}catch(e){p.errors.push('task:'+e.message)}
 try{new PerformanceObserver(l=>l.getEntries().forEach(e=>cap(p.loafs,{start:e.startTime,duration:e.duration,blocking:e.blockingDuration,render:e.renderStart,layout:e.styleAndLayoutStart,scripts:(e.scripts||[]).map(s=>({duration:s.duration,url:s.sourceURL,fn:s.sourceFunctionName,invoker:s.invoker,forced:s.forcedStyleAndLayoutDuration})).sort((a,b)=>b.duration-a.duration).slice(0,25)}))).observe({type:'long-animation-frame',buffered:true})}catch(e){p.errors.push('loaf:'+e.message)}
}
async function removeConsent(page){
 return page.evaluate(()=>{let n=0;for(const el of document.querySelectorAll('efilli-layout-dynamic,efilli-layout-static,[id*="efilli" i],[class*="efilli" i]')){if(el.tagName==='HTML'||el.tagName==='BODY')continue;el.remove();n++}document.documentElement.style.overflow='';document.body.style.overflow='';return n}).catch(()=>0);
}
async function candidates(locator,allowOffscreen=false){
 const n=Math.min(await locator.count().catch(()=>0),80),out=[];
 for(let i=0;i<n;i++){
  const el=locator.nth(i),box=await el.boundingBox().catch(()=>null);if(!box||box.width<3||box.height<3)continue;
  if(!allowOffscreen&&(box.x<0||box.x+box.width>393||box.y<0||box.y+box.height>851))continue;
  const meta=await el.evaluate(e=>({tag:e.tagName.toLowerCase(),text:String(e.textContent||'').replace(/\s+/g,' ').trim(),aria:e.getAttribute('aria-label')||''})).catch(()=>({tag:'',text:'',aria:''}));
  out.push({el,box,meta,score:(/button|a|label/.test(meta.tag)?1000:0)-Math.abs(box.y-150)-meta.text.length});
 }
 return out.sort((a,b)=>b.score-a.score);
}
async function findTarget(page,a){
 for(let attempt=0;attempt<100;attempt++){
  let loc=a.role?page.getByRole(a.role,{name:a.text,exact:true}):page.getByText(a.text,{exact:true});
  let found=await candidates(loc,!!a.scroll);
  if(!found.length&&a.role){loc=page.getByText(a.text,{exact:true});found=await candidates(loc,!!a.scroll)}
  if(found.length){const x=found[0];if(a.scroll){await x.el.scrollIntoViewIfNeeded().catch(()=>{});await new Promise(q=>setTimeout(q,150));x.box=await x.el.boundingBox().catch(()=>x.box)}return x}
  await new Promise(q=>setTimeout(q,120));
 }
 return null;
}
async function pointDescription(page,box){
 const x=box.x+box.width/2,y=box.y+box.height/2;
 return page.evaluate(({x,y})=>{const e=document.elementFromPoint(x,y);if(!e)return null;const chain=[];let p=e;for(let i=0;p&&i<5;i++,p=p.parentElement)chain.push(`${p.tagName.toLowerCase()} text=${String(p.textContent||'').replace(/\s+/g,' ').trim().slice(0,80)}`);return chain},{x,y}).catch(()=>null);
}
function summarize(p){
 const g=new Map();for(const e of(p.events||[]).filter(e=>e.id>0)){if(!g.has(e.id))g.set(e.id,[]);g.get(e.id).push(e)}
 const interactions=[...g].map(([id,es])=>{const e=[...es].sort((a,b)=>b.duration-a.duration)[0];return{id,latency:round(e.duration),event:e.name,target:e.target,start:round(e.start),input:round(e.ps-e.start),processing:round(e.pe-e.ps),presentation:round(Math.max(0,e.start+e.duration-e.pe)),events:es.map(x=>({name:x.name,duration:round(x.duration)}))}}).sort((a,b)=>b.latency-a.latency);
 const w=interactions[0]||null,s=w?w.start:-1,e=w?w.start+w.latency:-1;
 const tasks=(p.tasks||[]).filter(x=>x.start<e&&x.start+x.duration>s).map(x=>({...x,start:round(x.start),duration:round(x.duration)})).sort((a,b)=>b.duration-a.duration).slice(0,12);
 const loafs=(p.loafs||[]).filter(x=>x.start<e&&x.start+x.duration>s).map(x=>({...x,start:round(x.start),duration:round(x.duration),blocking:round(x.blocking),scripts:(x.scripts||[]).map(y=>({...y,duration:round(y.duration),forced:round(y.forced)}))})).sort((a,b)=>b.duration-a.duration).slice(0,12);
 const sm=new Map();for(const l of loafs)for(const x of l.scripts||[]){const k=x.url||x.invoker||x.fn||'(anonymous)';sm.set(k,(sm.get(k)||0)+(x.duration||0))}
 return{worst:w,interactions,tasks,loafs,topScripts:[...sm].map(([source,duration])=>({source,duration:round(duration)})).sort((a,b)=>b.duration-a.duration).slice(0,12),errors:p.errors,supported:p.supported};
}
async function runOne(browser,c,run){
 const context=await browser.newContext({...devices['Pixel 5'],locale:'tr-TR',timezoneId:'Europe/Istanbul',serviceWorkers:'allow'}),blocked=new Set();
 if(c.noTrackers)await context.route('**/*',async route=>{const u=route.request().url().toLowerCase(),hit=TRACKERS.find(x=>u.includes(x));if(hit){try{blocked.add(new URL(route.request().url()).hostname)}catch{blocked.add(hit)}await route.abort('blockedbyclient')}else await route.continue()});
 await context.addInitScript(installProbe);const page=await context.newPage(),cdp=await context.newCDPSession(page);page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(60000);
 const scriptResponses=[],failed=[],consoleErrors=[];page.on('response',x=>{if(x.request().resourceType()==='script')scriptResponses.push({url:x.url(),status:x.status(),bytes:+(x.headers()['content-length']||0)})});page.on('requestfailed',x=>failed.push({url:x.url(),type:x.resourceType(),error:x.failure()?.errorText}));page.on('console',x=>{if(x.type()==='error')consoleErrors.push(x.text())});
 await cdp.send('Network.enable');await cdp.send('Performance.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:150,downloadThroughput:209715,uploadThroughput:96000,connectionType:'cellular3g'});await cdp.send('Emulation.setCPUThrottlingRate',{rate:c.cpu||4});
 let navError=null,actionError=null,target=null,consentRemoved=0;
 try{await page.goto(c.url,{waitUntil:'commit',timeout:60000})}catch(e){navError=e.message}
 try{
  await page.waitForFunction(()=>!!document.body,null,{timeout:20000});
  if(c.phase==='settled'){await page.waitForLoadState('domcontentloaded',{timeout:30000}).catch(()=>{});await new Promise(q=>setTimeout(q,SETTLE))}
  consentRemoved=await removeConsent(page);const t=await findTarget(page,c.action);if(!t)throw new Error(`target not found: ${c.action.role||'text'}:${c.action.text}`);
  if(c.action.scroll){await t.el.scrollIntoViewIfNeeded();await new Promise(q=>setTimeout(q,150));t.box=await t.el.boundingBox()}
  if(!t.box||t.box.x<0||t.box.y<0||t.box.x+t.box.width>393||t.box.y+t.box.height>851)throw new Error(`target outside viewport: ${JSON.stringify(t.box)}`);
  const before=await pointDescription(page,t.box);target={text:t.meta.text,tag:t.meta.tag,aria:t.meta.aria,box:t.box,before};
  await t.el.tap({timeout:15000});await new Promise(q=>setTimeout(q,AFTER));
 }catch(e){actionError=e.message}
 const title=await page.title().catch(()=>''),currentUrl=page.url(),body=await page.locator('body').innerText({timeout:3000}).then(x=>x.replace(/\s+/g,' ').slice(0,700)).catch(()=> '');
 const p=await page.evaluate(()=>({...globalThis.__probe,resources:performance.getEntriesByType('resource').filter(x=>x.initiatorType==='script').map(x=>({name:x.name,duration:x.duration,transferSize:x.transferSize})).sort((a,b)=>b.duration-a.duration).slice(0,40)})).catch(e=>({errors:['read:'+e.message]}));
 const metrics=await cdp.send('Performance.getMetrics').then(x=>Object.fromEntries(x.metrics.filter(m=>['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','JSHeapUsedSize','Nodes'].includes(m.name)).map(m=>[m.name,m.value]))).catch(()=>({}));
 const out={id:c.id,run,cpu:c.cpu||4,noTrackers:!!c.noTrackers,url:c.url,currentUrl,title,phase:c.phase,blocked:[...blocked],consentRemoved,navError,actionError,target,body,summary:summarize(p),metrics,scriptCount:scriptResponses.length,scriptBytes:scriptResponses.reduce((a,x)=>a+x.bytes,0),topScriptResponses:scriptResponses.sort((a,b)=>b.bytes-a.bytes).slice(0,20),topScriptResources:p.resources,failed:failed.slice(0,60),consoleErrors:consoleErrors.slice(0,60)};
 await context.close();return out;
}
function aggregate(results){return CASES.map(c=>{const rs=results.filter(x=>x.id===c.id),ws=rs.map(x=>x.summary?.worst).filter(Boolean),vals=k=>ws.map(x=>x[k]).filter(Number.isFinite),stat=a=>a.length?{min:Math.min(...a),max:Math.max(...a),median:[...a].sort((x,y)=>x-y)[Math.floor((a.length-1)/2)]}:{min:null,max:null,median:null},sm=new Map();for(const x of rs)for(const s of x.summary?.topScripts||[])sm.set(s.source,(sm.get(s.source)||0)+s.duration);return{scenario:c.id,cpu:c.cpu||4,noTrackers:!!c.noTrackers,valid:ws.length,errors:rs.filter(x=>x.navError||x.actionError).map(x=>({run:x.run,nav:x.navError,action:x.actionError})),latency:stat(vals('latency')),input:stat(vals('input')),processing:stat(vals('processing')),presentation:stat(vals('presentation')),targets:[...new Set(ws.map(x=>x.target).filter(Boolean))],topScripts:[...sm].map(([source,duration])=>({source,duration:round(duration)})).sort((a,b)=>b.duration-a.duration).slice(0,10)}})}
(async()=>{const browser=await chromium.launch({headless:true,args:['--disable-blink-features=AutomationControlled','--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-sandbox']}),results=[];try{for(const c of CASES)for(let i=1;i<=RUNS;i++){console.log(`RUN ${c.id} ${i}/${RUNS}`);const x=await runOne(browser,c,i).catch(e=>({id:c.id,run:i,fatal:e.stack||e.message}));results.push(x);console.log(JSON.stringify({id:x.id,run:x.run,cpu:x.cpu,url:x.currentUrl,title:x.title,navError:x.navError,actionError:x.actionError,target:x.target,worst:x.summary?.worst,topScripts:x.summary?.topScripts?.slice(0,5),blocked:x.blocked,fatal:x.fatal},null,2))}}finally{await browser.close()}const out={generatedAt:new Date().toISOString(),profile:{device:'Pixel 5',latencyMs:150,downloadMbps:1.6,cache:'disabled',runs:RUNS},aggregate:aggregate(results),results};fs.writeFileSync('inp-results.json',JSON.stringify(out,null,2));console.log('AGGREGATE\n'+JSON.stringify(out.aggregate,null,2))})();
