import type { TreeBackupInput } from '@tangent/shared';

/**
 * What a backup imported into Learn is adapted to: Learn's one provider and
 * the models it offers there (Normal and Max).
 */
export interface LearnImportTarget {
  /** Learn's provider: the built-in endpoint (`openrouter`). */
  providerId: string;
  /** The model ids Learn offers on it (the Normal/Max toggle). */
  models: readonly string[];
  /** The model of a branch Learn can't run as it is: Learn's default (Normal). */
  defaultModel: string;
}

/**
 * A backup as Learn imports it. Learn runs on one provider with two models, shows each branch as
 * its whole path and has no system-prompt editor, so a tree made in power
 * mode is adapted to what Learn can show and continue:
 *
 * - a branch Learn can't run (another provider, or a model Learn doesn't
 *   offer) moves to Learn's provider on its default model (Normal); a branch
 *   already on one of Learn's models keeps it;
 * - every branch uses `path` context, which is what Learn shows (a `summary`
 *   or `independent` branch would answer from context the learner can't see);
 * - the lesson keeps no system prompt, as a new lesson does: Learn sends its
 *   tutor prompt instead, and a learner could neither see nor change a
 *   custom one;
 * - every branch is `own-key`: Learn decides who pays per request, and an
 *   import never moves anything onto credit or the pool.
 *
 * Messages, titles, anchor quotes, privacy and the learner's instructions are
 * kept as they are, and so is the provider each reply ran on (it is history).
 * Pure: the input is not changed, and adapting a Learn backup again changes
 * nothing.
 */
export function adaptBackupForLearn(
  backup: TreeBackupInput,
  target: LearnImportTarget,
): TreeBackupInput {
  const runnable = (providerId: string, model: string): boolean =>
    providerId === target.providerId && target.models.includes(model);
  return {
    ...backup,
    tree: { ...backup.tree, systemPrompt: null },
    branches: backup.branches.map((b) => ({
      ...b,
      providerId: target.providerId,
      model: runnable(b.providerId, b.model) ? b.model : target.defaultModel,
      contextMode: 'path' as const,
      funding: 'own-key' as const,
    })),
  };
}
