export function extensionIntent(input:string):{kind:'extension_request'|'extension_open';template:'blackjack'|'turn_based_combat'|null;request:string}|null{
 const text=input.trim(),blackjack=/21点|21 点|二十一点|blackjack/i.test(text),combat=/战斗|combat/i.test(text);
 const request=/(开发|增加|加一个|加个|扩展|系统|小游戏|希望.*以后|想要一个)/.test(text);
 if(request&&/21点|21 点|二十一点|blackjack|战斗|钓鱼|炼金|房屋布置|扩展|小游戏/i.test(text))return {kind:'extension_request',template:blackjack?'blackjack':combat?'turn_based_combat':null,request:text};
 if(!/随便|自动|不想手动/.test(text)&&(/玩.*(?:21点|21 点|二十一点)|blackjack/i.test(text)||/开始.*回合制|回合制.*训练/.test(text)))return {kind:'extension_open',template:blackjack?'blackjack':'turn_based_combat',request:text};
 return null;
}
