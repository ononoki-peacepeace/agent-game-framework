/**
 * Feature Idea Guide.
 *
 * Someone who cannot program still deserves to say "我想加个潜力系统" and get somewhere. Between a vague
 * development wish and the DevelopmentTask there is one lightweight step: understand what the player already
 * said, ask at most one question about *experience* (never about hooks, schemas, migrations or capability
 * gaps), and let "我不知道" be a first-class answer that produces a safe, small, reversible MVP.
 */
export interface GuideOption { id: string; label: string; detail: string }
export interface FeatureGuide {
  guide_type: 'feature';
  request: string;
  subject: string;
  understood: string[];
  unresolved: string[];
  current_question: string | null;
  options: GuideOption[];
  recommended_default: string | null;
  user_can_delegate: true;
  draft: string[];
  status: 'asking' | 'proposing' | 'confirmed';
  rounds: number;
}
const delegateIntent = /^(我不知道|不知道|不懂|我什么都不懂|你帮我选|你决定|你看着办|随便|都行|都可以|按正常|按默认|简单一?(点|些)|简单点|你觉得|给我推荐|推荐一个|没有想法|无所谓)/;
const confirmationIntent = /^(开始制作|开始吧|开始|就这样|这样做|可以|好|好的|行|确认|没问题|ok|OK)/;
const ideaWanted = /(不知道|没想好|没有想法|不清楚).{0,8}(是什么|做什么|加什么|要什么|玩法|系统)|给我(点)?灵感|随便来一个|想不出来/;
const directionOptions: GuideOption[] = [
  { id: 'social', label: '围绕人物与关系', detail: '更多 NPC、关系变化与日常互动' },
  { id: 'growth', label: '围绕成长与收集', detail: '数值、能力、进度与积累' },
  { id: 'crisis', label: '围绕危机与探索', detail: '事件压力、地图探索与抉择' },
  { id: 'delegate', label: '我不知道，你帮我选', detail: '我按最好上手的那个方向做第一版' },
];
function experienceOptions(subject: string): GuideOption[] {
  return [
    { id: 'display', label: `先只做展示：把「${subject}」作为信息显示出来`, detail: '不改数值结果，最容易回滚' },
    { id: 'mechanics', label: `影响实际结果：让「${subject}」改变数值或成长`, detail: '会改变强弱与平衡' },
    { id: 'world', label: `影响世界与剧情：「${subject}」由事件和人物反应体现`, detail: '不改硬数值，靠世界运行体现' },
    { id: 'delegate', label: '我不知道，你帮我选', detail: '我按最简单可回滚的版本先做' },
  ];
}
export function featureSubject(text: string) {
  const clean = String(text ?? '').replace(/[。！？!?，,、\s]+/g, ' ').trim();
  const match = clean.match(/(?:加|增加|新增|添加|想要|希望|来个|做)(?:一个|个)?([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)(?:系统|玩法|功能|机制|模式)?(?:\s|$)/);
  const raw = (match?.[1] ?? '').replace(/^(一个|个)/, '').trim();
  return (raw || clean).slice(0, 12) || '这个想法';
}
export function isDelegateAnswer(text: string) { return delegateIntent.test(String(text ?? '').trim()); }
export function isGuideConfirmation(text: string) { return confirmationIntent.test(String(text ?? '').trim()); }
export function wantsIdeas(text: string) { return ideaWanted.test(String(text ?? '').trim()); }
function axisFor(text: string): 'display' | 'mechanics' | 'world' | null {
  const clean = String(text ?? '');
  if (/(限制|上限|成长|升级|数值|变强|平衡|惩罚|奖励|不能|真的一直)/.test(clean)) return 'mechanics';
  if (/(剧情|故事|事件|关系|社交|世界|隐藏|慢慢发现|发现)/.test(clean)) return 'world';
  if (/(展示|显示|看到|参考|信息|查看|只做|一点)/.test(clean)) return 'display';
  return null;
}
export function featureMvpDraft(subject: string, axis: 'display' | 'mechanics' | 'world') {
  const shared = [
    `所有角色都会获得「${subject}」这项信息，旧角色也会补上默认值`,
    `人物页增加一个「${subject}」区域`,
    `第一版只做最简单的一层，以后可以再加规则`,
    `不改动现有属性、资质与关系数据`,
  ];
  if (axis === 'mechanics') return [`「${subject}」分成低/中/高/极高几档，并在需要时影响成长结果`, ...shared.slice(1)];
  if (axis === 'world') return [`「${subject}」主要由事件、剧情和人物反应体现`, `有些内容可以一开始隐藏，在剧情里慢慢发现`, ...shared.slice(1)];
  return [`「${subject}」只作为成长参考展示，不限制玩家继续提升`, ...shared.slice(1)];
}
export function startFeatureGuide(request: string): FeatureGuide {
  const text = String(request ?? '').trim(), subject = featureSubject(text);
  if (wantsIdeas(text)) {
    return {
      guide_type: 'feature', request: text, subject,
      understood: [`你希望增加新的玩法，但还没有决定具体是什么`], unresolved: ['大致方向'],
      current_question: '你想要哪种大致方向？', options: directionOptions, recommended_default: 'social',
      user_can_delegate: true, draft: [], status: 'asking', rounds: 1,
    };
  }
  return {
    guide_type: 'feature', request: text, subject,
    understood: [`你想增加一个「${subject}」`], unresolved: [`「${subject}」应该带来什么体验`],
    current_question: `你希望「${subject}」主要给玩家带来什么？`, options: experienceOptions(subject),
    recommended_default: 'display', user_can_delegate: true, draft: [], status: 'asking', rounds: 1,
  };
}
/** One question per round at most: merge the answer and only ask again if it truly changes the outcome. */
export function advanceFeatureGuide(guide: FeatureGuide, answer: string): FeatureGuide {
  const text = String(answer ?? '').trim();
  if (isDelegateAnswer(text)) {
    const axis = (guide.recommended_default === 'mechanics' || guide.recommended_default === 'world' ? guide.recommended_default : 'display') as 'display' | 'mechanics' | 'world';
    return {
      ...guide, status: 'proposing', draft: featureMvpDraft(guide.subject, axis), unresolved: [],
      understood: [...guide.understood, `剩下交给我：先按${axis === 'display' ? '只做展示' : axis === 'mechanics' ? '影响数值' : '由世界剧情体现'}的简单版本做`],
      current_question: '这样做吗？', options: [
        { id: 'confirm', label: '开始制作', detail: '按这个最小版本准备候选' },
        { id: 'adjust', label: '继续调整', detail: '还可以补充或改方向' },
        { id: 'cancel', label: '算了', detail: '不做了' },
      ], recommended_default: null, rounds: guide.rounds + 1,
    };
  }
  const axis = axisFor(text);
  if (axis) {
    return {
      ...guide, status: 'proposing', draft: featureMvpDraft(guide.subject, axis), unresolved: [],
      understood: [...guide.understood, `方向：${axis === 'display' ? '只做展示' : axis === 'mechanics' ? '影响数值与成长' : '由世界与剧情体现'}`],
      current_question: '这样做吗？', options: [
        { id: 'confirm', label: '开始制作', detail: '按这个最小版本准备候选' },
        { id: 'adjust', label: '继续调整', detail: '还可以补充或改方向' },
        { id: 'cancel', label: '算了', detail: '不做了' },
      ], recommended_default: null, rounds: guide.rounds + 1,
    };
  }
  // Free text that does not decide the experience: keep it, and ask the one question once more.
  const asked = [...guide.understood, text.slice(0, 60)];
  if (guide.rounds >= 2) {
    const axis2 = (guide.recommended_default ?? 'display') as 'display' | 'mechanics' | 'world';
    return { ...guide, status: 'proposing', understood: asked, draft: featureMvpDraft(guide.subject, axis2), unresolved: [], current_question: '我先按最简单的方式做，可以吗？', options: [
      { id: 'confirm', label: '开始制作', detail: '按这个最小版本准备候选' },
      { id: 'cancel', label: '算了', detail: '不做了' },
    ], rounds: guide.rounds + 1 };
  }
  return { ...guide, understood: asked, unresolved: guide.unresolved, current_question: guide.current_question, options: guide.options, rounds: guide.rounds + 1 };
}
export function featureGuideMessage(guide: FeatureGuide) {
  const lines: string[] = [];
  if (guide.understood.length) lines.push(guide.understood.map(line => `· ${line}`).join('\n'));
  if (guide.draft.length) lines.push(guide.draft.map(line => `· ${line}`).join('\n'));
  if (guide.current_question) lines.push(guide.current_question);
  return lines.join('\n\n').trim();
}
/** The DevelopmentTask requirement: player-level, minimal, and explicit that this is a first version. */
export function featureRequirement(guide: FeatureGuide) {
  return [
    guide.request,
    guide.draft.length ? `第一版就做这些：\n${guide.draft.map(line => `- ${line}`).join('\n')}` : '',
    '只做最小可用版本：不要引入成长限制 hook、可见性框架、数据迁移或额外核心能力，除非玩家明确要求这些行为。',
  ].filter(Boolean).join('\n');
}
