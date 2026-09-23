import { z } from 'zod';
import { assert, dictionary, id, integer } from '../core/schema.js';
import type { ActionContext, Module } from '../core/registry.js';
import type { Inventory } from './inventory.js';
export type Wallet = { balances: Record<string, number> };
export type Shop = { currency_id: string; stock: Record<string, number>; prices: Record<string, { buy: number; sell: number }> };
function trade(c: ActionContext, buying: boolean) {
  assert(c.action.target_id, '请选择商店');
  const shopId = c.action.target_id, item = c.action.parameters.item_id as string, qty = c.action.parameters.quantity as number;
  const shop = c.store.component<Shop>(shopId, 'shop');
  assert(c.store.component<{ location_id: string }>(shopId, 'location').location_id === c.store.component<{ location_id: string }>(c.action.actor_id, 'location').location_id, '商店不在当前位置');
  const inv = c.store.component<Inventory>(c.action.actor_id, 'inventory');
  const wallet = c.store.component<Wallet>(c.action.actor_id, 'wallet');
  const till = c.store.component<Wallet>(shopId, 'wallet');
  assert(shop.prices[item], '商店不交易该物品');
  const total = shop.prices[item][buying ? 'buy' : 'sell'] * qty;
  assert(Number.isSafeInteger(total), '交易金额超出范围');
  const payer = buying ? wallet : till, payee = buying ? till : wallet;
  assert((payer.balances[shop.currency_id] ?? 0) >= total, buying ? '余额不足' : '商店余额不足');
  assert((buying ? shop.stock[item] ?? 0 : inv.items[item] ?? 0) >= qty, buying ? '库存不足' : '背包数量不足');
  payer.balances[shop.currency_id] -= total;
  payee.balances[shop.currency_id] = (payee.balances[shop.currency_id] ?? 0) + total;
  shop.stock[item] = (shop.stock[item] ?? 0) + (buying ? -qty : qty);
  inv.items[item] = (inv.items[item] ?? 0) + (buying ? qty : -qty);
  c.advance(c.save.definition.ruleset.trade_minutes);
  c.emit({ type: 'on_entity_changed', entity_id: shopId });
  c.emit({ type: 'on_entity_changed', entity_id: c.action.actor_id });
  c.facts.push(`${buying ? '购买' : '出售'} ${qty} × ${c.store.component<{ name: string }>(item, 'identity').name}，金额 ${total} ${c.save.definition.ruleset.currencies[shop.currency_id]}。`);
}
export const commerceModule: Module = {
  id: 'commerce', version: '0.1.0', requires: ['inventory'],
  components: {
    wallet: { schema: z.strictObject({ balances: dictionary(integer) }), project: (d, e, s) => e.id === s.player_state.entity_id ? d : undefined },
    shop: { schema: z.strictObject({ currency_id: id, stock: dictionary(integer), prices: dictionary(z.strictObject({ buy: integer.min(1), sell: integer })) }), project: d => d },
  },
  panels: [{ id: 'commerce', label: '商店' }],
  actions: Object.fromEntries(['BUY', 'SELL'].map(type => [type, { ui: { label: type === 'BUY' ? '买入' : '卖出', visibility: 'panel', target_component: 'shop' }, parameters: z.strictObject({ item_id: id, quantity: integer.min(1).max(100) }), execute: (c: ActionContext) => trade(c, type === 'BUY') }])),
  validate(save) {
    for (const e of save.entities) {
      const wallet = e.components.wallet as Wallet | undefined;
      for (const currency of Object.keys(wallet?.balances ?? {})) assert(Object.hasOwn(save.definition.ruleset.currencies, currency), '未知货币');
      const shop = e.components.shop as Shop | undefined;
      if (!shop) continue;
      assert(wallet && e.components.location && Object.hasOwn(wallet.balances, shop.currency_id), '商店缺少钱包或地点');
      for (const key of new Set([...Object.keys(shop.stock), ...Object.keys(shop.prices)])) {
        assert(save.entities.some(i => i.id === key && i.components.item), '商店引用未知物品');
        assert(shop.prices[key] && shop.prices[key].sell <= shop.prices[key].buy, '售价不得高于买价');
      }
    }
  },
};
