import {assert,type SavePackage} from '../core/schema.js';
import type {Calendar} from './schema.js';
export const absoluteTime=(s:SavePackage)=>s.runtime.time.day*s.definition.ruleset.minutes_per_day+s.runtime.time.minute;
export function dateAt(calendar:Calendar,runtimeDay:number) {
 let month=calendar.anchor_month,day=calendar.anchor_date,yearOffset=0,offset=runtimeDay-calendar.anchor_day;
 day+=offset;
 while(day>calendar.month_lengths[month-1]){day-=calendar.month_lengths[month-1];month++;if(month>12){month=1;yearOffset++;}}
 while(day<1){month--;if(month<1){month=12;yearOffset--;}day+=calendar.month_lengths[month-1];}
 return {month,day,yearOffset,weekday:((calendar.anchor_weekday-1+offset)%7+7)%7+1};
}
export function calendarText(save:SavePackage){if(!save.calendar)return '日历映射待确认';const d=dateAt(save.calendar,save.runtime.time.day);const m=save.runtime.time.minute;return d.month+'月'+d.day+'日 周'+['一','二','三','四','五','六','日'][d.weekday-1]+' '+String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');}
export function calendarDay(calendar:Calendar,month:number,day:number){assert(month>=1&&month<=12&&day>=1&&day<=calendar.month_lengths[month-1],'任务日期不合法');return calendar.anchor_day+calendar.month_lengths.slice(0,month-1).reduce((a,b)=>a+b,0)+day-calendar.month_lengths.slice(0,calendar.anchor_month-1).reduce((a,b)=>a+b,0)-calendar.anchor_date;}
