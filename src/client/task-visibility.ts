export const endedTask=(status?:string)=>['completed','cancelled','canceled','failed','resolved','finished','已完成','已取消','失败'].includes(status??'');
export function taskGroups<T extends {status?:string}>(entries:Record<string,T>,hidden:string[]){
 return {active:Object.entries(entries).filter(([,v])=>!endedTask(v.status)),ended:Object.entries(entries).filter(([id,v])=>endedTask(v.status)&&!hidden.includes(id)),hidden:Object.entries(entries).filter(([id,v])=>endedTask(v.status)&&hidden.includes(id))};
}

