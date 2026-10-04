import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mode=process.argv[2] ?? '--default';
if (!['--default','--portable','--integration'].includes(mode)) throw new Error('Unknown test mode');
const integration=new Set(['a-lane','cache','candidates','command','lane-watch','panel-button','panel-feed','remote','stream','target','watch','step10-panel']);
const all=fs.readdirSync(path.join(root,'test')).filter(n=>n.endsWith('-test.mjs')).sort();
// Explicit smoke subset. Full suites retain known snapshot failures; this is
// deliberately not a substitute for the validation report or host acceptance.
// These files pass in a clean checkout without the host-only Harness SDK.
const portable=new Set(['panel-state','panel-back','panel-reserve','panel-entry','panel-zebra','probe','update-signal','liveness']);
const selected=all.filter(n=> {
  const key=n.replace('-test.mjs','');
  return mode==='--portable' ? portable.has(key) : mode==='--integration' ? integration.has(key) : !integration.has(key);
});
const results=[];
const out=path.join(root,'artifacts');fs.mkdirSync(out,{recursive:true});
for (const file of selected) {
  const result=spawnSync(process.execPath,['--import',path.join(root,'scripts/test-isolation.mjs'),path.join(root,'test',file)],{cwd:root,encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024});
  fs.writeFileSync(path.join(out,`${file}.log`),(result.stdout??'')+(result.stderr??'')+(result.error?.message??''));
  results.push({file,passed:result.status===0,status:result.status});
  console.log(`${result.status===0?'PASS':'FAIL'} ${file}`);
}
const failed=results.filter(r=>!r.passed).length;
const report={mode,node:process.version,passed:results.length-failed,failed,results,modelCalls:0,records:'synthetic; home-directory discovery isolated'};
fs.writeFileSync(path.join(out,`${mode.slice(2)}-results.json`),JSON.stringify(report,null,2)+'\n');
console.log(`${report.passed}/${results.length} test files passed. Details are in ignored artifacts/.`);
process.exitCode=failed?1:0;
