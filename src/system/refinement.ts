/**
 * Is an incoming development request a refinement of the task that is already open, or a different goal?
 *
 * The client sends a selected task id whenever the development workspace is open, so the *server* has to decide:
 * "给人物增加疲劳值" must not be swallowed by an unrelated "笔记模块" task. Explicit refinement wording always
 * counts as a refinement; otherwise the two requirement texts have to share enough content to look like the same
 * piece of work. Nothing here is sentence-specific — it is a small, deterministic text-similarity rule.
 */
const REFINEMENT_WORDS = /(继续|接着|再|另外|还有|补充|调整|修改一下|改成|换成|去掉|删除掉|加上|加一点|这个功能|那个功能|刚才那个|上面那个|同一个|细化|完善)/;
/** Wording that points back at the task that is already open ("给这个笔记功能加一个开关"). */
const DEFINITE_REFERENCE = /(这个|那个|该|刚才|上面|当前|同一个|它还|它|这次|继续|接着|补充|调整|改成|换成|去掉|加上|再加)/;
export function isRefinementOf(existing: string, incoming: string) {
  const next = String(incoming ?? '').trim();
  if (!next) return true;
  if (REFINEMENT_WORDS.test(next)) return true;
  const left = grams(String(existing ?? '')), right = grams(next);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const gram of right) if (left.has(gram)) shared += 1;
  // A short follow-up that both points at the open task and shares its wording is a refinement; a sentence that
  // merely reuses a word ("给人物增加疲劳值" after a notes task) is a different goal.
  if (DEFINITE_REFERENCE.test(next) && shared >= 1) return true;
  const union = left.size + right.size - shared;
  return shared / Math.max(union, 1) >= 0.18;
}

/** Character bigrams are a cheap, language-agnostic way to compare two short requirement texts. */
function grams(text: string) {
  const clean = text.replace(/[\s，,。.！!？?、；;：:"“”'‘’()（）\[\]【】-]/g, '');
  const set = new Set<string>();
  for (let index = 0; index + 1 < clean.length; index += 1) set.add(clean.slice(index, index + 2));
  if (clean.length === 1) set.add(clean);
  return set;
}
