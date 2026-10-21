import type {AIRequest} from '../../src/ai/contracts.js';
/** No credentials, callbacks, threads or mutable game state enter the handoff. */
export function narratorRequestEnvelope(request:AIRequest){
 if(request.role!=='narrator')throw Error('Only Narrator requests belong in this queue');
 return {role:'narrator' as const,prompt:request.prompt,schema:request.schema,
  maxOutputTokens:request.maxOutputTokens,reasoningEffort:request.reasoningEffort};
}
