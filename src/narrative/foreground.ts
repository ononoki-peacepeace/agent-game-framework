import type {SavePackage} from '../core/schema.js';
/** Preserve canonical foreground state; render only the registered clock label.
 * Reaching its time proves neither attendance nor fulfilment of the appointment. */
export function foregroundNarrative(foreground:SavePackage['foreground']){
 const reason=foreground?.reason;
 const scheduled=foreground?.blocker==='task'?/^已到安排时间：([\s\S]+)$/.exec(reason??''):null;
 return scheduled?`「${scheduled[1]}」的时间到了。`:reason;
}
