import type {SavePackage} from './schema.js';

export type CapabilityRule=NonNullable<NonNullable<SavePackage['definition']['ruleset']['capability_domains']>[string]>;

/**
 * Contesting bodies is a framework guarantee, not an optional authoring flourish.
 *
 * A world whose authoring model returned no capability profiles used to reach `prepareCheck`
 * with no declared domains at all, so every physical attempt resolved as a bare coin flip with
 * `actor_modifier:0 / opponent_modifier:0` and no record of why (REV435 was literally 1d20 vs
 * 1d20). These generic domains are therefore the floor every world gets. A world's own
 * `ruleset.capability_domains` always wins over them, and a legacy recorded value under the
 * domain's own key keeps its documented direct-modifier meaning (see `capability()`).
 *
 * The table declares where ability is *read from*. It never invents ability: an entity with no
 * recorded attribute or training sits at the neutral baseline, and no code may infer a number
 * from biography prose.
 */
export const genericCapabilityDomains=['strength','agility','endurance','perception','cognition','willpower','physique'] as const;
/** Domains that spend the body, so injury and fatigue are legitimate inputs for them. */
const bodily=new Set<string>(['strength','agility','endurance','physique']);

export function frameworkCapabilityDomains():Record<string,CapabilityRule>{
  const domains:Record<string,CapabilityRule>={};
  for(const domain of genericCapabilityDomains)
    domains[domain]={attribute:domain==='physique'?'strength':domain,skills:[],
      condition_sensitive:bodily.has(domain),exertion_cost:bodily.has(domain)?1:0};
  return domains;
}
/** The world's own rule when it declared one, otherwise the framework floor. Null means undeclared. */
export function capabilityRule(save:SavePackage,domain:string):{rule:CapabilityRule;source:'world_rule'|'framework_default'}|null{
  const declared=save.definition.ruleset.capability_domains?.[domain];
  if(declared)return {rule:declared,source:'world_rule'};
  const fallback=frameworkCapabilityDomains()[domain];
  return fallback?{rule:fallback,source:'framework_default'}:null;
}
/** Every domain a proposal may legitimately name in this world, used to reject invented ones. */
export function capabilityDomainNames(save:SavePackage):string[]{
  const declared=Object.keys(save.definition.ruleset.capability_domains??{});
  return declared.length?declared:[...genericCapabilityDomains];
}
