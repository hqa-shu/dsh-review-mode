import assert from 'node:assert/strict';
import {apply} from '../index.js';
const commands=new Map(),calls=[],events=[];
let text='合成问题一';
const agent={id:'s',session:{header:{id:'s'},seq:4,snapshotEvents:()=>[{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text}]}}],append(type,data){events.push({type,data});}},inject(){throw Error('No transcript injection');}};
const old=globalThis.setInterval;globalThis.setInterval=()=>0;
apply({logger:{warn(){},info(){}},reflect:{provide(){},get(){}},effect:f=>f(),on(){},
 inject(n,fn){fn({effect:f=>f(),commands:{register:d=>commands.set(d.name,d)}});},
 sessionProjections:{register(){},stateOf:()=> 'review'},agents:{list:()=>[agent],get:()=>agent,withoutInitiator:f=>f()},
 subagents:{start:async(name,req)=>{let resolve;const result=new Promise(r=>resolve=r);calls.push({req,resolve});return {id:'c'+calls.length,result,dispose:async()=>{}};}}
},{watchCodex:false,reviewTimeoutMs:80});
globalThis.setInterval=old;
const run=rawInput=>commands.get('review-mode').handler({agent,rawInput});
const tick=()=>new Promise(r=>setTimeout(r,10));
const output={output:[{type:'text',text:'结论: on-track\n一句话: 新结果\n## 具体对话\n- 合成原话\n## 对话概述\n概述\n## 分析\n- 洞察｜依据：合成原话｜洞察：解释\n## 建议\n- 下一步'}]};
run('dir self');run('dir self');await tick();assert.equal(calls.length,1);console.log('PASS 连续点相同目标只派一次');
text='合成问题二';run('dir self');await tick();assert.equal(calls.length,2);assert(calls[0].req.signal.aborted);
calls[0].resolve(output);await tick();assert.equal(events.filter(e=>e.data.reviewUpdate?.form==='notice').length,0);
calls[1].resolve(output);await tick();assert.equal(events.filter(e=>e.data.reviewUpdate?.form==='notice').length,1);console.log('PASS 旧请求取消后迟到结果不能覆盖新请求');
text='超时合成问题';run('dir self');await new Promise(r=>setTimeout(r,110));assert(calls[2].req.signal.aborted);assert(events.some(e=>e.data.reviewUpdate?.form==='failed' && /超时/.test(e.data.reviewUpdate?.review.message)));console.log('PASS 结果永不返回也会明确超时');
text='停止合成问题';run('dir self');await tick();assert.equal(run('stop').kind,'success');await tick();assert(calls[3].req.signal.aborted);assert(events.some(e=>e.data.reviewUpdate?.form==='stopped'));assert(!events.some(e=>e.data.reviewUpdate?.form==='failed' && /已停止/.test(e.data.reviewUpdate?.review.message)));console.log('PASS 用户停止实际取消请求且不留下红色失败');
