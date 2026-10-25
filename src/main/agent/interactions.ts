import { randomUUID } from 'node:crypto';
import type { PendingInteraction, ApprovalRequest, QuestionRequest, ApprovalDecision, AnswerPayload } from '../../shared/types';

type ApprovalEntry = { view: ApprovalRequest; settle: (decision: ApprovalDecision) => void };
type QuestionEntry = { view: QuestionRequest; settle: (answers: AnswerPayload['answers'] | null) => void };
/** Live callbacks only. This queue is intentionally never written to disk. */
export class InteractionQueue {
  private approvals = new Map<string, ApprovalEntry>();
  private questions = new Map<string, QuestionEntry>();
  private order: string[] = [];
  constructor(private readonly changed: () => void) {}
  snapshot(): PendingInteraction[] {
    return this.order.map(id => this.approvals.get(id)?.view ?? this.questions.get(id)?.view).filter((entry): entry is PendingInteraction => !!entry);
  }
  approval(view: Omit<ApprovalRequest, 'id' | 'kind'>, settle: ApprovalEntry['settle'], id: string = randomUUID()): string {
    if (this.approvals.has(id) || this.questions.has(id)) throw new Error('审批请求重复。');
    this.approvals.set(id, { view: { ...view, id, kind: 'approval' }, settle });
    this.order.push(id); this.changed(); return id;
  }
  question(view: Omit<QuestionRequest, 'id' | 'kind'>, settle: QuestionEntry['settle'], id: string = randomUUID()): string {
    if (this.approvals.has(id) || this.questions.has(id)) throw new Error('提问请求重复。');
    this.questions.set(id, { view: { ...view, id, kind: 'question' }, settle });
    this.order.push(id); this.changed(); return id;
  }
  approve(id: string, decision: ApprovalDecision): void {
    const entry = this.approvals.get(id);
    if (!entry) throw new Error('这条审批已过期或已处理，请查看当前请求。');
    if (decision === 'session' && !entry.view.supportsSession) throw new Error('此操作仅支持本次授权。');
    if (!['allow', 'deny', 'stop', 'session'].includes(decision)) throw new Error('无效审批结果。');
    this.remove(id); entry.settle(decision);
  }
  answer(payload: AnswerPayload): void {
    const entry = this.questions.get(payload.id);
    if (!entry) throw new Error('这条问题已过期或已回答。');
    const answers: AnswerPayload['answers'] = {};
    for (const question of entry.view.questions) {
      const value = payload.answers[question.id];
      if (!Array.isArray(value) || !value.length || value.some(answer => typeof answer !== 'string' || !answer.trim() || answer.length > 32_000)) throw new Error('请回答全部问题后继续。');
      answers[question.id] = value;
    }
    this.remove(payload.id); entry.settle(answers);
  }
  remove(id: string): void {
    this.approvals.delete(id); this.questions.delete(id);
    this.order = this.order.filter(entry => entry !== id); this.changed();
  }
  clear(): void {
    const approvals = [...this.approvals.values()];
    const questions = [...this.questions.values()];
    this.approvals.clear(); this.questions.clear(); this.order = [];
    this.changed();
    for (const entry of approvals) entry.settle('deny');
    for (const entry of questions) entry.settle(null);
  }
}
