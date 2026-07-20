import { chromium } from '@playwright/test';
const BASE='http://localhost:5190';
const VIDEO=process.argv[2];
const MODEL=process.argv[3]??'tiny';
const TIMEOUT=Number(process.argv[4]??2400000);

const b=await chromium.launch({headless:true,args:['--enable-unsafe-webgpu','--enable-features=Vulkan']});
const ctx=await b.newContext({viewport:{width:1400,height:950}});
const page=await ctx.newPage();
page.on('pageerror',e=>console.log('  [pageerror]',String(e).slice(0,300)));
page.on('console',m=>{ if(m.type()==='error') console.log('  [err]',m.text().slice(0,240)); });

await page.goto(`${BASE}/login`);
await page.locator('input[type=email]').fill('lecture-verify@folio.local');
await page.locator('input[type=password]').fill('lecture-verify-pw-123');
await page.getByRole('button',{name:/sign in|log in/i}).click();
await page.waitForURL(u=>!u.pathname.includes('/login'),{timeout:20000});

await page.waitForTimeout(2500);
await page.keyboard.press('Control+p');
await page.getByPlaceholder('Type a command…').fill('Import slides');
await page.getByText('Import slides PDF',{exact:true}).first().click();
await page.getByRole('tab',{name:/lecture video/i}).click();
await page.locator('input[type=file][accept*="video"]').setInputFiles(VIDEO);
await page.getByRole('button',{name:/find slides/i}).click();
await page.locator('.lec-strip, .lec-empty').first().waitFor({timeout:600000});
const slideCount=await page.locator('.lec-slide').count();
console.log(`slides detected: ${slideCount} @ ${(await page.locator('.lec-slide__time').allTextContents()).join(' ')}`);

// pick the model
const labels={tiny:'Tiny',base:'Base',small:'Small'};
await page.getByRole('radio',{name:new RegExp(labels[MODEL],'i')}).click();
console.log(`model: ${labels[MODEL]}  (device reported by UI: ${(await page.locator('.lec-warn').innerText()).match(/on this (\w+)/)?.[1]})`);

console.log('starting transcription + note creation');
const t0=Date.now();
await page.getByRole('button',{name:/create note/i}).click();

let last=0, lastPhase='';
const deadline=Date.now()+TIMEOUT;
for(;;){
  if(Date.now()>deadline) throw new Error('timed out');
  if(await page.getByText('Note ready').count()) break;
  if(await page.getByText('Import failed').count()){
    console.log('FAILED:', await page.locator('.im-result__message').innerText().catch(()=>'?'));
    await b.close(); process.exit(1);
  }
  const phase=await page.locator('.lec-phase').innerText().catch(()=>'');
  const sub=await page.locator('.lec-sub').first().innerText().catch(()=>'');
  if(Date.now()-last>20000 || phase!==lastPhase){
    console.log(`  [${((Date.now()-t0)/1000).toFixed(0)}s] ${phase} ${sub}`.replace(/\s+/g,' '));
    last=Date.now(); lastPhase=phase;
  }
  await page.waitForTimeout(1000);
}
const totalSeconds=(Date.now()-t0)/1000;
console.log(`\n=== TRANSCRIPTION + NOTE: ${totalSeconds.toFixed(1)}s ===`);
console.log('result line:', await page.locator('.im-result__name').innerText().catch(()=>'?'));

// pull the created note back out of the API and show what actually landed
const notes=await (await page.request.get(`${BASE}/api/notes?sort=created&limit=1`)).json();
const id=notes.notes[0].id;
const full=await (await page.request.get(`${BASE}/api/notes/${id}`)).json();
console.log('\n=== NOTE ===');
console.log('title:', full.note.title);
const doc=full.note.contentJson ?? full.note.content_json;
const parsed=typeof doc==='string'?JSON.parse(doc):doc;
let images=0;
for(const n of parsed.content){
  if(n.type==='image'){ images++; console.log(`  [image] ${n.attrs.src} alt="${n.attrs.alt}"`); }
  else if(n.type==='heading') console.log(`  ## ${n.content?.[0]?.text}`);
  else if(n.type==='paragraph'&&n.content?.[0]?.text) console.log(`     ${n.content[0].text.slice(0,400)}`);
}
console.log(`\nimages in note: ${images}`);
await b.close();
