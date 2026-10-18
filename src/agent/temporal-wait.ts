/** A single foreground WAIT may contain many world ticks. Only a standalone wait is admitted here. */
export interface TemporalWait {minutes:number;kind:'vague'|'duration'|'until';target:{day:number;minute:number}}
export interface TemporalWaitSlot {standalone:boolean;mode:TemporalWait['kind'];duration_minutes:number|null;
  target_day_offset:number|null;target_minute:number|null}
export type ResolvedTemporalWait=TemporalWait&{source:'clock_grammar'|'semantic_slot'};

const digit:Record<string,number>={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
function number(token:string):number|null{
  if(/^\d+$/.test(token))return Number(token);
  if(token==='半')return 0.5;
  if(Object.hasOwn(digit,token))return digit[token];
  const tens=token.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/);
  return tens?(tens[1]?digit[tens[1]]:1)*10+(tens[2]?digit[tens[2]]:0):null;
}
function target(now:{day:number;minute:number},minutesPerDay:number,clockMinute:number,tomorrow:boolean){
  if(clockMinute>=minutesPerDay)return null;
  const day=now.day+(tomorrow?1:clockMinute<=now.minute?1:0);
  const delta=(day-now.day)*minutesPerDay+clockMinute-now.minute;
  return delta>0&&delta<=10000?{minutes:delta,target:{day,minute:clockMinute}}:null;
}

export function parseTemporalWait(input:string,now:{day:number;minute:number},minutesPerDay=1440):TemporalWait|null{
  const text=input.normalize('NFKC').trim().replace(/[。！!]+$/u,'').trim();
  // A following action is a compound goal, not permission to execute just its wait clause.
  if(/(?:再|然后|接着|之后|顺便).*(?:去|找|做|问|买|卖|走|行动)/u.test(text))return null;
  const lead='(?:我)?(?:一直|先|就在这里|在这里|稍微|现在)?\\s*';
  const verb='(?:等|等待|待|待着)';
  const noon=text.match(new RegExp(`^${lead}${verb}(?:到|至|直到)\\s*(明天|明日|次日|今天)?\\s*中午$`,'u'));
  if(noon){const resolved=target(now,minutesPerDay,720,Boolean(noon[1]&&/明|次日/u.test(noon[1])));
    return resolved?{...resolved,kind:'until'}:null;}
  const clock=text.match(new RegExp(`^${lead}${verb}(?:到|至|直到)?\\s*(明天|明早|明日|次日|今天|今晚)?\\s*(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\\s*([0-9]{1,2}):([0-9]{2})(?:点|时)?$`,'u'));
  const absolute=clock??text.match(new RegExp(`^${lead}${verb}(?:到|至|直到)?\\s*(明天|明早|明日|次日|今天|今晚)?\\s*(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\\s*([0-9零一二两三四五六七八九十]{1,4})?\\s*(?:点|时)\\s*(半|[0-9零一二两三四五六七八九十]{1,4}分)?$`,'u'));
  if(absolute){
    const [,dayPart,period,hourPart,minutePart]=absolute;
    const tomorrow=Boolean(dayPart&&/明|次日/u.test(dayPart));
    let hour=hourPart?number(hourPart):period==='中午'?12:null;
    if(hour===null)return null;
    if(period==='下午'||period==='晚上'||period==='傍晚'||period==='夜里'||dayPart==='今晚'){
      if(hour<12)hour+=12;
    }else if(period==='中午'&&hour<11)hour+=12;
    if(hour>23)return null;
    const minute=minutePart?(minutePart==='半'?30:number(minutePart.replace(/分$/u,''))):0;
    if(minute===null||minute>59)return null;
    const resolved=target(now,minutesPerDay,hour*60+minute,tomorrow);
    return resolved?{...resolved,kind:'until'}:null;
  }
  const duration=text.match(new RegExp(`^${lead}${verb}\\s*(半|[0-9零一二两三四五六七八九十]{1,5})\\s*(?:个)?\\s*(小时|分钟)$`,'u'));
  if(duration){
    const amount=number(duration[1]);
    const minutes=amount===null?0:Math.ceil(amount*(duration[2]==='小时'?60:1));
    if(minutes<1||minutes>10000)return null;
    const absoluteNow=now.day*minutesPerDay+now.minute+minutes;
    return {kind:'duration',minutes,target:{day:Math.floor(absoluteNow/minutesPerDay),minute:absoluteNow%minutesPerDay}};
  }
  if(new RegExp(`^${lead}${verb}(?:一会儿|一会|一下|一阵|一阵子|会儿|会|等)?$`,'u').test(text)){
    const absoluteNow=now.day*minutesPerDay+now.minute+5;
    return {kind:'vague',minutes:5,target:{day:Math.floor(absoluteNow/minutesPerDay),minute:absoluteNow%minutesPerDay}};
  }
  return null;
}

/** The semantic slot covers natural phrasing outside the small clock grammar; Core still checks bounds. */
export function resolveTemporalWait(input:string,now:{day:number;minute:number},minutesPerDay:number,
  slot:TemporalWaitSlot|null|undefined):ResolvedTemporalWait|null{
  const parsed=parseTemporalWait(input,now,minutesPerDay);
  if(parsed)return {...parsed,source:'clock_grammar'};
  if(!slot?.standalone)return null;
  let minutes:number;
  if(slot.mode==='vague')minutes=5;
  else if(slot.mode==='duration')minutes=slot.duration_minutes??0;
  else if(slot.mode==='until'&&slot.target_day_offset!==null&&slot.target_minute!==null){
    if(slot.target_minute>=minutesPerDay)return null;
    minutes=slot.target_day_offset*minutesPerDay+slot.target_minute-now.minute;
  }else return null;
  if(!Number.isInteger(minutes)||minutes<1||minutes>10000)return null;
  const end=now.day*minutesPerDay+now.minute+minutes;
  return {kind:slot.mode,minutes,target:{day:Math.floor(end/minutesPerDay),minute:end%minutesPerDay},
    source:'semantic_slot'};
}
