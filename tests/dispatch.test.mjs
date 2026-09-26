import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function api() {
  const module = await import('../dist/model-catalog.js').catch(()=>({}));
  assert.equal(typeof module.selectRouting,'function');return module;
}
test('availability filters role preferences and explicit provider overrides',async()=>{
  const {selectRouting,DEFAULT_CATALOG}=await api();
  const inventory={agy:['claude-opus-4-6-thinking','gemini-3.8-flash-high'],codex:['gpt-6-sol']};
  const routing=selectRouting(DEFAULT_CATALOG,inventory);
  assert.equal(routing.primary.provider,'agy');assert.equal(routing.ui.model,'gemini-3.8-flash-high');
  const strongest=selectRouting(DEFAULT_CATALOG,{...inventory,codex:['gpt-6-astra','gpt-6-sol']});
  assert.equal(strongest.primary.model,'gpt-6-astra');
  assert.throws(()=>selectRouting(DEFAULT_CATALOG,inventory,'single',{primary:'codex/gpt-6-astra'}),/不可用/);
  const swapped=selectRouting(DEFAULT_CATALOG,inventory,'single',{ui:'codex/gpt-6-sol'});
  assert.equal(swapped.ui.provider,'codex');
});
test('fresh sourced role scores and measured reliability affect ranking; stale scores do not',async()=>{
  const {selectRouting,DEFAULT_CATALOG}=await api();
  const catalog=structuredClone(DEFAULT_CATALOG),opus=catalog.models.find(m=>m.model==='claude-opus-4-6-thinking');
  opus.benchmark={checkedAt:new Date().toISOString(),source:'https://example.org/my-eval',scores:{primary:100}};
  const astra=catalog.models.find(m=>m.model==='gpt-6-astra');
  astra.benchmark={...opus.benchmark,scores:{primary:50}};
  const inv={agy:['claude-opus-4-6-thinking','gemini-3.8-flash-high'],codex:['gpt-6-astra','gpt-6-sol']};
  assert.equal(selectRouting(catalog,inv).primary.model,opus.model);
  opus.benchmark.checkedAt='2000-01-01';astra.benchmark.checkedAt='2000-01-01';
  assert.equal(selectRouting(catalog,inv).primary.model,astra.model);
  opus.benchmark.source='';assert.throws(()=>selectRouting(catalog,inv),/榜单/);
});

test('a consistently failing delivery model is deprioritized only with enough observations',async()=>{
  const {selectRouting,DEFAULT_CATALOG}=await api();
  const catalog=structuredClone(DEFAULT_CATALOG),flash=catalog.models.find(m=>m.model==='gemini-3.8-flash-high');
  const inv={agy:['claude-opus-4-6-thinking','gemini-3.8-flash-high'],codex:['gpt-6-astra','gpt-6-sol']};
  flash.reliability={attempts:4,accepted:0};assert.equal(selectRouting(catalog,inv).ui.model,flash.model);
  flash.reliability={attempts:5,accepted:0};assert.equal(selectRouting(catalog,inv).ui.model,'gpt-6-astra');
});
test('skills filter by phase/role and freeze file contents',async()=>{
  const module=await import('../dist/skills.js').catch(()=>({}));
  assert.equal(typeof module.loadSkills,'function');
  const root=await mkdtemp(join(tmpdir(),'crew-skills-'));
  await writeFile(join(root,'SKILL.md'),'Use accessible labels.');
  await writeFile(join(root,'skills.json'),JSON.stringify({skills:[{id:'labels',path:'SKILL.md',roles:['ui'],phases:['implement','repair']}]}));
  const skills=await module.loadSkills(join(root,'skills.json'));
  await writeFile(join(root,'SKILL.md'),'changed later');
  assert.match(module.skillContext({skills},'implement','ui'),/Use accessible labels/);
  assert.doesNotMatch(module.skillContext({skills},'review','review'),/Use accessible labels/);
  skills.find(s=>s.id==='labels').content='tampered';
  assert.throws(()=>module.skillContext({skills},'implement','ui'),/哈希/);
});
