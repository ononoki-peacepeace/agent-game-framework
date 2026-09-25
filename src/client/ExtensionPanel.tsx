import {DevelopmentPanel} from './DevelopmentPanel.js';
import {useEffect,useState} from 'react';
import type {PublicView} from '../shared/contracts.js';
import type {ExtensionManifest} from '../extensions/schema.js';
import {request,clientRequestId} from './api.js';
export interface ExtensionIntent {kind:'extension_request'|'extension_open';template:'blackjack'|'turn_based_combat'|'declarative'|null;request:string;extension_id?:string}
interface Installed {id:string;name:string;version:string;enabled:boolean;installed:boolean;available:boolean;can_open:boolean;manifest:ExtensionManifest;warning:string|null;state:any}
const cards=(values:(number|null)[])=>values.map((c,i)=><span className="playing-card" key={i}>{c===null?'背面':['A','2','3','4','5','6','7','8','9','10','J','Q','K'][c%13]+['♠','♥','♦','♣'][Math.floor(c/13)]}</span>);
export function ExtensionPanel({view,intent,onView,showDevelopment=true}:{view:PublicView;intent:ExtensionIntent|null;onView:(v:PublicView)=>void;showDevelopment?:boolean}){
 const [items,setItems]=useState<Installed[]>([]),[selected,setSelected]=useState<string|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[stake,setStake]=useState(0);
 const [editing,setEditing]=useState<string|null>(null);
 const tx=()=>({game_id:view.game_id,expected_revision:view.revision,request_id:clientRequestId()});
 async function refresh(){setItems(await request<Installed[]>('extensions'));}
 useEffect(()=>{let live=true,inFlight=false;const update=async()=>{if(inFlight)return;inFlight=true;try{const list=await request<Installed[]>('extensions');if(live)setItems(list);}catch(e){if(live)setError((e as Error).message);}finally{inFlight=false;}};void update();const timer=setInterval(()=>void update(),1200);return()=>{live=false;clearInterval(timer);};},[view.game_id]);
 useEffect(()=>{if(intent?.extension_id)setSelected(intent.extension_id);},[intent]);
 async function change(path:string,body:unknown){setBusy(true);setError('');try{onView(await request<PublicView>(path,body));await refresh();}catch(e){setError((e as Error).message);onView(await request<PublicView>('state'));}finally{setBusy(false);}}
 const current=items.find(x=>x.id===selected),playing=current?.state?.phase==='playing';
 return <div className="extension-panel"><h3>功能扩展</h3><p>描述你希望游戏本身发生的变化，系统会判断如何处理。</p>
 {(showDevelopment||editing)&&<DevelopmentPanel key={editing??'new'} view={view} onView={onView} extensionId={editing??selected??undefined}/>}
 {error&&<p role="alert">{error}</p>}
 {items.map(e=><article className="entity" key={e.id}><strong>{e.name} {e.version}</strong><button className="quiet" onClick={()=>setEditing(e.id)}>修改这个功能</button><p>{e.warning??(e.enabled&&e.installed?'已启用':'已停用 / 休眠')}</p><div className="button-row"><button disabled={!e.can_open} onClick={()=>setSelected(e.id)}>查看玩法</button>{(['enable','disable','rollback','uninstall'] as const).map(command=><button className="quiet" disabled={busy} key={command} onClick={()=>void change('extensions/'+e.id+'/'+command,tx())}>{({enable:'启用',disable:'禁用',rollback:'回滚',uninstall:'卸载并保留状态'})[command]}</button>)}</div>{!e.can_open&&e.enabled&&<small>当前场景不符合此功能的启用条件。</small>}</article>)}
 {current&&current.manifest.template==='declarative'&&<section className="minigame" aria-label={current.manifest.name}><div className="item-row"><h3>{current.name}</h3><button className="quiet" onClick={()=>setSelected(null)}>关闭界面</button></div><p>{current.manifest.description}</p><ul className="declarative-values">{current.manifest.fields.map((field,index)=><li key={field.key}>状态 {index+1}：{String(current.state?.values?.[field.key]??field.initial)}</li>)}</ul><div className="button-row">{current.manifest.declarative_actions.map(action=><button disabled={busy||!current.can_open} key={action.id} onClick={()=>void change('extensions/'+current.id+'/action',{...tx(),action:{type:action.id}})}>{action.label}
</button>)}</div><small>声明式扩展只能修改自己的状态命名空间，不写入世界正史。</small></section>}
 {current&&current.manifest.template!=='declarative'&&<section className="minigame" aria-label={current.manifest.template==='blackjack'?'21 点牌桌':'回合制训练'}><div className="item-row"><h3>{current.name}</h3><button className="quiet" onClick={()=>setSelected(null)}>关闭界面，保留本局</button></div>
 {current.manifest.template==='blackjack'?<><p>庄家</p><div className="cards">{cards(current.state?.dealer??[])}</div><p>你的手牌</p><div className="cards">{cards(current.state?.player??[])}</div>{!playing&&current.manifest.allow_betting&&<label>下注（0 为练习）<input aria-label="下注金额" type="number" min={0} max={current.manifest.max_stake} value={stake} onChange={e=>setStake(Number(e.target.value))}/></label>}</>:<><p>玩家生命：{String(view.entities.find(e=>e.id===view.player_id)?.components.condition?.hp??'未定义')}</p><p>训练对手生命：{current.state?.enemy_hp??20}</p><p>训练会造成真实生命变化；撤退不会产生奖励。</p></>}
 <p>{current.state?.result}</p><div className="button-row">{(playing?(current.manifest.template==='blackjack'?['hit','stand']:['attack','flee']):['start']).map(type=><button disabled={busy||!current.can_open} key={type} onClick={()=>void change('extensions/'+current.id+'/action',{...tx(),action:{type,...(type==='start'&&current.manifest.template==='blackjack'?{stake:current.manifest.allow_betting?stake:0,currency:Object.keys(view.currencies)[0]}:{})}})}>{({start:'新一局',hit:'要牌',stand:'停牌',attack:'攻击',flee:'逃跑'} as Record<string,string>)[type]}</button>)}</div><small>刷新或关闭界面保留未完成局；不会自动重新扣费或结算。</small></section>}
 </div>;
}
