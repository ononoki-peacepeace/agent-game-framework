/**
 * Estimated turn progress.
 *
 * The player sees an *estimate*, not a measurement: it is driven by the real execution stage the server reports and
 * only fills the budget of that stage over time. A stage is never marked finished by the estimate, and no number is
 * ever presented as a precise completion statistic.
 *
 * Growth inside a stage is `from + (to - from) * (1 - e^(-elapsed/expected))`, which is smooth, monotonic and
 * decelerating: it approaches the stage ceiling without reaching it, so a stage that outlives its expectation parks
 * near its own ceiling instead of running away or reversing.
 */

export type TurnPhase='submitted'|'interpreting'|'planning'|'resolving'|'narrating'|'committing'|'finalizing';

export interface PhaseBand{phase:TurnPhase;label:string;from:number;to:number;expectedMs:number}

/**
 * Bands are contiguous on purpose: the next stage starts exactly where the previous one was heading, so a real stage
 * change can only step the estimate forward.
 */
const WORLD_BANDS:readonly PhaseBand[]=[
  {phase:'submitted',label:'请求已发送',from:1,to:5,expectedMs:1500},
  {phase:'interpreting',label:'理解输入',from:5,to:24,expectedMs:9000},
  {phase:'planning',label:'规划与校验',from:24,to:48,expectedMs:16000},
  {phase:'resolving',label:'动作结算',from:48,to:66,expectedMs:12000},
  {phase:'narrating',label:'叙事生成',from:66,to:87,expectedMs:22000},
  {phase:'committing',label:'保存结果',from:87,to:96,expectedMs:3000},
  {phase:'finalizing',label:'整理反馈',from:96,to:99,expectedMs:2500},
];

/**
 * A direct registered action (`/api/action`) has no free-text interpretation and no plan audit, so the same wall
 * clock should not spend time in the "understanding" budget.
 */
const ACTION_BANDS:readonly PhaseBand[]=[
  {phase:'submitted',label:'请求已发送',from:1,to:6,expectedMs:1000},
  {phase:'interpreting',label:'理解输入',from:6,to:14,expectedMs:4000},
  {phase:'planning',label:'规划与校验',from:14,to:38,expectedMs:12000},
  {phase:'resolving',label:'动作结算',from:38,to:64,expectedMs:14000},
  {phase:'narrating',label:'叙事生成',from:64,to:87,expectedMs:24000},
  {phase:'committing',label:'保存结果',from:87,to:96,expectedMs:3000},
  {phase:'finalizing',label:'整理反馈',from:96,to:99,expectedMs:2500},
];

export type ProgressProfile='world'|'action';

export const progressProfileFor=(path:'input'|'action'):ProgressProfile=>path==='action'?'action':'world';

/** A stage the client cannot identify still gets a conservative estimate instead of an endless animation. */
const CONSERVATIVE_BAND:PhaseBand={phase:'interpreting',label:'处理中',from:2,to:26,expectedMs:30000};

export function progressBands(profile:ProgressProfile='world'):readonly PhaseBand[]{
  return profile==='action'?ACTION_BANDS:WORLD_BANDS;
}

/** Only real, server-observed stages have a name; an unknown phase is never given an invented label. */
export const PHASE_LABELS:Readonly<Record<TurnPhase,string>>=Object.freeze(
  Object.fromEntries(WORLD_BANDS.map(band=>[band.phase,band.label])) as Record<TurnPhase,string>);

export function isKnownPhase(phase:string|null|undefined):phase is TurnPhase{
  return typeof phase==='string'&&Object.prototype.hasOwnProperty.call(PHASE_LABELS,phase);
}

export function phaseBand(phase:string|null|undefined,profile:ProgressProfile='world'):PhaseBand{
  if(!isKnownPhase(phase))return CONSERVATIVE_BAND;
  return progressBands(profile).find(band=>band.phase===phase)??CONSERVATIVE_BAND;
}

export interface ProgressInput{phase:string|null|undefined;state:'running'|'completed'|'failed'|'partial'|'unknown';
  phaseStartedAt:number;now:number;profile?:ProgressProfile}

/**
 * Terminal states close the floating progress card after a short, fixed delay. `completed` and `partial` both mean
 * the request *finished processing* (so the bar reaches 100%), while the title keeps the success / partial-success
 * distinction. `failed` and `unknown` are terminal too but are never presented as finished.
 */
export const TERMINAL_TURN_STATES=['completed','partial','failed','unknown'] as const;
export type TerminalTurnState=typeof TERMINAL_TURN_STATES[number];
export const AUTO_DISMISS_MS=2500;
export function isTerminalTurnState(state:string|undefined):state is TerminalTurnState{
  return typeof state==='string'&&(TERMINAL_TURN_STATES as readonly string[]).includes(state);
}

/**
 * 0-100 estimate. `100` means the request finished processing: either full success or a committed partial result.
 * A failed or unconfirmed result keeps whatever the estimate had reached and can never display completion.
 */
export function estimateTurnProgress({phase,state,phaseStartedAt,now,profile='world'}:ProgressInput):number{
  if(state==='completed'||state==='partial')return 100;
  const band=phaseBand(phase,profile);
  const elapsed=Number.isFinite(phaseStartedAt)?Math.max(0,now-phaseStartedAt):0;
  const fraction=1-Math.exp(-elapsed/Math.max(1,band.expectedMs));
  const value=Math.min(band.to,band.from+(band.to-band.from)*fraction);
  return Math.min(99,state==='running'?Math.max(1,value):Math.max(0,value));
}

/** Observed stages in the order the server reported them; the estimate never adds a stage of its own. */
export function observedPhases(history:readonly string[],phase:string|null|undefined):TurnPhase[]{
  const seen:TurnPhase[]=[];
  for(const entry of history)if(isKnownPhase(entry)&&!seen.includes(entry))seen.push(entry);
  if(isKnownPhase(phase)&&!seen.includes(phase))seen.push(phase);
  return seen;
}
