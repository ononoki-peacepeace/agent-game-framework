import { useState } from 'react';

export interface ClarificationChoice { id: string; label: string; detail?: string }
export interface ClarificationCardProps {
  question: string;
  options?: ClarificationChoice[];
  onAnswer: (answer: string) => void;
  onChoose?: (option: ClarificationChoice) => void;
  disabled?: boolean;
  /** The same interaction everywhere: question, suggested answers, self-answer, and "you decide for me". */
  title?: string;
  delegateLabel?: string;
  freeTextLabel?: string;
  placeholder?: string;
}

export function ClarificationCard({ question, options = [], onAnswer, onChoose, disabled, title = '需要你回答这一项', delegateLabel = '你帮我决定', freeTextLabel = '或者自己填写', placeholder = '用一句话回答' }: ClarificationCardProps) {
  const [text, setText] = useState('');
  return <section className="clarification-card" aria-label={title}>
    <strong>{title}</strong>
    <p className="clarification-question">{question}</p>
    {options.length > 0 && <div className="button-row compact">{options.map(option => <button key={option.id} type="button" className="quiet" title={option.detail ?? ''} disabled={disabled} onClick={() => (onChoose ?? (choice => onAnswer(choice.label)))(option)}>{option.label}</button>)}</div>}
    <div className="button-row compact"><button type="button" className="quiet" disabled={disabled} onClick={() => onAnswer(delegateLabel)}>{delegateLabel}</button></div>
    <label>{freeTextLabel}<textarea aria-label="回答" value={text} onChange={event => setText(event.target.value)} maxLength={600} placeholder={placeholder}/></label>
    <button type="button" disabled={disabled || !text.trim()} onClick={() => onAnswer(text.trim())}>提交回答</button>
  </section>;
}
