import assert from 'node:assert/strict';
import {apply} from '../index.js';
async function probe(header,options){
 const commands=new Map(),requests=[];
 const agent={id:'model-test',options,session:{header:{id:'model-test'},seq:1,requestHeader:()=>header,snapshotEvents:()=>[{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'合成用户材料'}]}}],append(){}},inject(){throw Error('No injection');}};
 const old=globalThis.setInterval;globalThis.setInterval=()=>0;
 apply({logger:{warn(){},info(){}},reflect:{provide(){},get(){}},effect:f=>f(),on(){},inject(n,fn){fn({effect:f=>f(),commands:{register:d=>commands.set(d.name,d)}});},sessionProjections:{register(){},stateOf:()=> 'review'},agents:{list:()=>[agent],get:()=>agent,withoutInitiator:f=>f()},subagents:{start:async(n,req)=>{requests.push(req);return {id:'c',result:Promise.resolve({output:[{type:'text',text:'结论: on-track\n一句话: 合成审核\n## 分析\n- 合成洞察'}]}),dispose:async()=>{}};}}},{watchCodex:false});globalThis.setInterval=old;
 commands.get('review-mode').handler({agent,rawInput:'dir self'});await new Promise(r=>setTimeout(r,10));assert.equal(requests.length,1);assert.equal(requests[0].parent,agent);assert.deepEqual(requests[0].toolFilter,{allow:[]});assert(requests[0].prompt[0].text.includes('合成用户材料'));return requests[0];
}
const configured={provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'high'};
assert.deepEqual((await probe({config:configured},{provider:'wrong',model:'wrong'})).agentOptions,configured);console.log('PASS 当前requestHeader模型优先于创建默认，route/model/effort完整继承');
assert.deepEqual((await probe(undefined,configured)).agentOptions,configured);console.log('PASS requestHeader缺失时继承宿主创建选项');
assert.equal((await probe(undefined,undefined)).agentOptions,undefined);console.log('PASS 模型来源未知时不猜路由，每次复审上下文独立且零工具');
