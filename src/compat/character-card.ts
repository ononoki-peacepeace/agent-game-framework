import { GameError } from '../core/schema.js';

export type CharacterCardSource = 'v1' | 'v2' | 'v3' | 'text';
export interface NormalizedCharacterCard {
  source_spec: CharacterCardSource;
  spec_version: string;
  name: string;
  nickname: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  system_prompt: string;
  post_history_instructions: string;
  creator_notes: string;
  alternate_greetings: string[];
  tags: string[];
  creator: string;
  character_version: string;
  extensions: Record<string, unknown>;
  raw: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const asText = (value: unknown, limit = 100_000) => typeof value === 'string' ? value.slice(0, limit) : '';
const asTextArray = (value: unknown, max = 100) => Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string').slice(0, max).map(x => x.slice(0, 100_000)) : [];
const asExtensions = (value: unknown) => isRecord(value) ? structuredClone(value) : {};

/**
 * Normalize JSON Character Cards without trusting card content as engine policy.
 * V1 is the legacy flat Tavern card. V2/V3 use the `data` envelope.
 * Unknown fields remain available in `raw` so importing and later migration does
 * not silently destroy third-party extensions.
 */
export function normalizeCharacterCard(input: unknown): NormalizedCharacterCard {
  if (!isRecord(input)) throw new GameError('角色卡 JSON 必须是对象');
  const spec = asText(input.spec, 40);
  let source: CharacterCardSource;
  let data: Record<string, unknown>;
  let specVersion = '';
  if (spec === 'chara_card_v3') {
    if (!isRecord(input.data)) throw new GameError('Character Card V3 缺少 data');
    source = 'v3'; data = input.data; specVersion = asText(input.spec_version, 30) || '3.0';
  } else if (spec === 'chara_card_v2') {
    if (!isRecord(input.data)) throw new GameError('Character Card V2 缺少 data');
    source = 'v2'; data = input.data; specVersion = asText(input.spec_version, 30) || '2.0';
  } else {
    // Legacy Tavern/V1 cards are flat JSON objects.
    data = input; source = 'v1'; specVersion = '1';
  }
  const name = asText(data.name, 120).trim();
  if (!name) throw new GameError('角色卡缺少有效 name');
  const raw = structuredClone(input);
  return {
    source_spec: source,
    spec_version: specVersion,
    name,
    nickname: asText(data.nickname, 120),
    description: asText(data.description),
    personality: asText(data.personality),
    scenario: asText(data.scenario),
    first_mes: asText(data.first_mes),
    mes_example: asText(data.mes_example),
    system_prompt: asText(data.system_prompt),
    post_history_instructions: asText(data.post_history_instructions),
    creator_notes: asText(data.creator_notes),
    alternate_greetings: asTextArray(data.alternate_greetings, 100),
    tags: asTextArray(data.tags, 100).map(x => x.slice(0, 120)),
    creator: asText(data.creator, 300),
    character_version: asText(data.character_version, 100),
    extensions: asExtensions(data.extensions),
    raw,
  };
}

/** A small adapter for pasted Markdown/text cards; external text remains source material. */
export function normalizeCharacterSource(input:unknown):NormalizedCharacterCard{
  if(typeof input!=='string')return normalizeCharacterCard(input);
  const source=input.trim();
  if(!source||source.length>100_000)throw new GameError('人物卡文本必须为 1–100000 字符');
  const first=source.split(/\r?\n/).find(line=>line.trim())?.trim()??'';
  const name=first.replace(/^#{1,6}\s*/,'').replace(/^(?:name|姓名|名字)\s*[:：]\s*/i,'').trim().slice(0,120);
  if(!name)throw new GameError('人物卡需要首行姓名或标题');
  return {source_spec:'text',spec_version:'1',name,nickname:'',description:source,personality:'',scenario:'',
    first_mes:'',mes_example:'',system_prompt:'',post_history_instructions:'',creator_notes:'',alternate_greetings:[],
    tags:[],creator:'',character_version:'',extensions:{},raw:source};
}
