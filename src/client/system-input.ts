/**
 * Lifecycle of the System composer. The textarea is cleared only after a request was really submitted and
 * answered; a failed submission keeps the text so the player does not lose what they typed. This is one
 * generic rule for every category (clarification, behaviour configuration, development, feedback, …).
 */
export interface SystemInputState { value: string; pending: string | null; error: string }
export const initialSystemInput: SystemInputState = { value: '', pending: null, error: '' };
export function submitStarted(state: SystemInputState, text: string): SystemInputState {
  return { value: text, pending: text, error: '' };
}
export function clearSystemError(state: SystemInputState): SystemInputState {
  return state.error ? { ...state, error: '' } : state;
}
export function submitSucceeded(_state: SystemInputState): SystemInputState {
  return { value: '', pending: null, error: '' };
}
export function submitFailed(state: SystemInputState, error: string): SystemInputState {
  return { value: state.pending ?? state.value, pending: null, error };
}
