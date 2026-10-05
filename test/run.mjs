import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const portable=['evidence-packet','ux-hook-order','ux-entry','ux-concurrency','ux-monitor','ux-qa','model-inherit','client','liveness-scope','panel-back','panel-focus','panel-reserve','update-signal','schema','thread-merge','panel-scope','panel-zebra','stamp','panel-entry','opening','probe','trigger'];
const tests=process.argv.includes('--host') ? ['ux-transport','tool-filter'] : portable;
const home=mkdtempSync(path.join(tmpdir(),'review-mode-tests-'));
let failed=0,passed=0;
try {
 for(const name of tests){
  const fixture=path.join(home,name);mkdirSync(fixture,{recursive:true});
  const proc=spawnSync(process.execPath,[path.join(root,'test',`${name}-test.mjs`)],{cwd:root,env:{...process.env,HOME:fixture},encoding:'utf8',timeout:30000});
  const output=proc.stdout ?? '';passed+=output.split('\n').filter(l=>/^PASS/.test(l)).length;
  if(proc.status!==0 || /^FAIL/m.test(output)){failed++;console.error(`FAIL script ${name}\n${output}${proc.stderr ?? ''}`);}else console.log(`PASS script ${name}`);
 }
 console.log(JSON.stringify({scripts:tests.length,assertionsPassed:passed,failedScripts:failed}));
}finally{rmSync(home,{recursive:true,force:true});}
process.exitCode=failed ? 1 : 0;
