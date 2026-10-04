// Preloaded in test subprocesses only. Conversation discovery uses temporary,
// synthetic records, never the user's real home directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { zstdCompressSync } from 'node:zlib';

const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-review-tests-'));
os.homedir = () => fixtureHome;
syncBuiltinESMExports();
const codex = path.join(fixtureHome,'.codex');
const sessions = path.join(codex,'sessions','2026','01','01');
fs.mkdirSync(sessions,{recursive:true});
fs.mkdirSync(path.join(codex,'archived_sessions'),{recursive:true});
fs.mkdirSync(path.join(fixtureHome,'.dsh','sessions'),{recursive:true});
const index=[];
const assignment={};
for (let i=0;i<12;i++) {
  const id=`019c0000-0000-0000-0000-${String(i+1).padStart(12,'0')}`;
  const rows=[{type:'session_meta',payload:{id,cwd:'/tmp/review-fixture/project'}}];
  if (i<11) rows.push({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Compare two approaches and cite evidence.'}]}});
  rows.push({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Here is a synthetic response for a regression test.'}]}});
  rows.push({type:'event_msg',payload:{item:{type:'AgentMessage',content:[{type:'output_text',text:'Synthetic answer.'}]}}});
  fs.writeFileSync(path.join(sessions,`rollout-2026-01-01T00-00-00-${id}.jsonl`),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  index.push({id,thread_name:`Synthetic conversation ${i+1}`,updated_at:new Date().toISOString()});
  assignment[id]={projectId:'synthetic'};
}
fs.writeFileSync(path.join(codex,'session_index.jsonl'),index.map(r=>JSON.stringify(r)).join('\n'));
fs.writeFileSync(path.join(codex,'.codex-global-state.json'),JSON.stringify({'local-projects':{synthetic:{name:'Synthetic project'}},'thread-project-assignments':assignment}));
const dshSession = path.join(fixtureHome,'.dsh','sessions','synthetic-workspace','session-synthetic-dsh');
fs.mkdirSync(dshSession,{recursive:true});
const dshEvents=[
  {type:'session',data:{header:{cwd:'/tmp/review-fixture/project'}}},
  {type:'session/title',data:{title:'Synthetic DSH conversation'}},
  {type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Compare two approaches.'}]}},
  {type:'assistant/message',data:{content:[{type:'text',text:'A synthetic answer.'}]}}
];
fs.writeFileSync(path.join(dshSession,'session.v4.jsonl.zstd'),zstdCompressSync(Buffer.from(dshEvents.map(r=>JSON.stringify(r)).join('\n'))));
process.on('exit',()=>fs.rmSync(fixtureHome,{recursive:true,force:true}));
