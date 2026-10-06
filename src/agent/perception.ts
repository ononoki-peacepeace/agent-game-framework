/** A request to use the character's senses is an action even when it contains a question word. */
export function isActivePerception(input:string){
  const text=input.trim().replace(/^(?:我|现在|我现在)\s*/,'');
  // Reading an already recorded value is a query even when phrased as “take a look”.
  if(/时间|几点|余额|多少钱|我在哪|关系|计划|日程|已公开|已登记|记录|资料|状态|档案|面板|界面|页面|日志/.test(text))return false;
  return /^(?:去)?(?:看(?:看|一眼|一下)?|瞧(?:瞧|一眼)?|观察(?:一下)?|检查(?:一下)?|查看(?:一下)?|搜(?:索|查|一下)?|找找|寻找|调查(?:一下)?|探查(?:一下)?|侦查(?:一下)?|仔细看(?:一下)?)/.test(text);
}
