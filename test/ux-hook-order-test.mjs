import assert from 'node:assert/strict';
let hooks=[],slots=[],cursor=0,module,panel;
const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),useState(value){hooks.push('state');const i=cursor++;if(!(i in slots))slots[i]=typeof value==='function' ? value():value;return [slots[i],v=>slots[i]=typeof v==='function' ? v(slots[i]):v];},useRef:v=>{hooks.push('ref');return {current:v};},useEffect(){hooks.push('effect');}};
globalThis.window={innerWidth:1000,__ModuleLoader__:{load({factory}){module=factory(id=>id==='react' ? React:{});}},localStorage:{getItem:()=>null,setItem(){}},addEventListener(){},removeEventListener(){}};
await import('../client.js');module.apply({remote:{commands:{execute:async()=>({})}},slots:{inject:(n,fn)=>fn(),register:(def,component)=>{if(def.id==='review-mode-panel')panel=component;}}});
const render=preset=>{hooks=[];cursor=0;const tree=panel({sessionId:'s',useSessions:selector=>selector({byId:{s:{projectionValues:{agentPreset:preset,reviewMode:{feed:[],reviews:0}}}}})});return {tree,hooks:[...hooks]};};
const standard=render('standard'),review=render('review'),back=render('standard');assert.equal(standard.tree,null);assert(review.tree);assert.deepEqual(review.hooks,standard.hooks);assert.deepEqual(back.hooks,review.hooks);console.log('PASS 标准模式→审核模式→标准模式始终调用相同数量与顺序的React hooks');
