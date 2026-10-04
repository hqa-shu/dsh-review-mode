import assert from 'node:assert/strict';
import {setTarget, currentTarget, evidenceFromEvents} from '../reviewer.js';
import * as mod from '../index.js';
const ticks=[], commands=new Map(), starts=[], events=[];
const original=globalThis.setInterval;
globalThis.setInterval=(fn)=>{ticks.push(fn);return 0;};
const agent={id:'synthetic-review',session:{header:{id:'synthetic-review',cwd:'/tmp'},seq:2,snapshotEvents:()=>[
  {type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'制定30分钟Python复习计划'}]}}
],append(type,data,opts){events.push({type,data,opts});}}, inject(){throw Error('No chat injection');}};
mod.apply({logger:{warn(){},info(){}},reflect:{provide(){},get(){}},effect:f=>f(),on(){},
 inject(names,fn){fn({effect:f=>f(),commands:{register:def=>commands.set(def.name,def)}});},
 sessionProjections:{register(){},stateOf:()=> 'review'},
 agents:{list:()=>[agent],get:()=>agent,withoutInitiator:f=>f()},
 subagents:{start:async(name,req)=>{starts.push(req);return {id:'synthetic-child',result:Promise.resolve({output:[{type:'text',text:'结论: on-track\n一句话: 把复习目标改为自测\n## 具体对话\n- 你：「制定30分钟Python复习计划」\n## 对话概述\n安排学习时间\n## 分析\n- 要检验会不会\n## 建议\n- 先做一题'}]}),dispose:async()=>{}};}}
},{watchCodex:true,watchIntervalMs:5000});
globalThis.setInterval=original;
setTarget(null);
await ticks[0](); await new Promise(r=>setTimeout(r,20));
assert.equal(starts.length,0,'Unselected session must not review an unrelated conversation');
console.log('PASS 未选目标不派单');
const run=input=>commands.get('review-mode').handler({agent,rawInput:input});
const selected=JSON.parse(run('dir self').text);
assert.equal(selected.self,true);assert.equal(currentTarget().id,agent.id);
assert.equal(selected.evidence.youSaid[0],'制定30分钟Python复习计划');
await new Promise(r=>setTimeout(r,20));assert.equal(starts.length,1);
assert.equal(JSON.parse(run('ping').text).selection.kind,'self');
console.log('PASS 本会话一步取证、派单并回报所选目标');
const actualShape=evidenceFromEvents([{type:'assistant/message',data:{message:{role:'assistant',content:[{type:'reasoning',text:'hidden'},{type:'text',text:'先做一道Python题'}]}}}]);
assert.deepEqual(actualShape.otherSaid,['先做一道Python题']);
assert(!starts[0].prompt[0].text.includes('其余角度有证据就写'));
console.log('PASS SDK真实assistant/message形状保留AI原话且不含推理内容');
