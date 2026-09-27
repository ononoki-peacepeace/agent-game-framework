import { describe, expect, it } from 'vitest';
import { planGameRequest } from '../src/agent/game.js';
import { queryRuntimeTruth, queryWorldTruth } from '../src/agent/truth-query.js';
import { sparseSetup } from './sparse-fixture.js';

describe('unified truth queries', () => {
  it('uses one explicit status vocabulary for canonical facts and runtime availability', async () => {
    const f=await sparseSetup(),view=(await f.service.view())!;
    const player=view.entities.find(entity=>entity.id===view.player_id)!;
    player.components.wallet={balances:{credit:12}};
    delete player.components.identity!.avatar_id;

    expect(queryWorldTruth(view,'我有多少钱？')?.status).toBe('FOUND');
    expect(queryWorldTruth(view,'我的角色有没有头像？')?.status).toBe('NOT_DEFINED');
    expect(queryWorldTruth(view,'有没有一个叫王明的人？')?.status).toBe('NOT_FOUND');
    expect(queryWorldTruth(view,'这个世界创建时是不是设定所有人都有秘密？')?.status).toBe('UNKNOWN');
    expect(queryRuntimeTruth(view,'图片生成服务是否可用？',{text_provider:'fixture',image_provider:null})?.status).toBe('UNAVAILABLE');

    const characters=view.entities.filter(entity=>entity.components.character).slice(0,2);
    expect(characters).toHaveLength(2);
    for(const character of characters)character.components.identity!.name='同名人物';
    expect(queryWorldTruth(view,'同名人物有没有头像？')?.status).toBe('AMBIGUOUS');
  });

  it('projects truth status through the existing Game Agent result', async () => {
    const f=await sparseSetup(),view=(await f.service.view())!;
    const missing=planGameRequest(view,'有没有一个叫王明的人？');
    const avatar=planGameRequest(view,'我的角色有没有头像？');
    expect(missing).toMatchObject({awareness_status:'NOT_FOUND'});
    expect(avatar).toMatchObject({awareness_status:'NOT_DEFINED'});
    expect(avatar?.message).toContain('还没有头像');
  });
});
