import {
  BUILT_IN_PROVIDER_ID,
  LEGACY_BUILT_IN_PROVIDER_ID,
  type TreeBackupInput,
} from '@tangent/shared';

/**
 * What a backup imported into Learn is adapted to: Learn's one provider, the
 * models it offers there (Smart and Simple), and the system prompt a new
 * Learn lesson gets.
 */
export interface LearnImportTarget {
  /** Learn's provider: the built-in endpoint (`openrouter`). */
  providerId: string;
  /** The model ids Learn offers on it (the Smart/Simple toggle). */
  models: readonly string[];
  /** The model of a branch Learn can't run as it is: Learn's default (Smart). */
  defaultModel: string;
  /** The prompt of the imported lesson: what a new lesson in this account gets. */
  systemPrompt: string | null;
}

/**
 * A backup as Learn imports it (docs/DECISIONS.md "Import and export in
 * Learn"). Learn runs on one provider with two models, shows each branch as
 * its whole path and has no system-prompt editor, so a tree made in power
 * mode is adapted to what Learn can show and continue:
 *
 * - a branch Learn can't run (another provider, or a model Learn doesn't
 *   offer) moves to Learn's provider on its default model (Smart); a branch
 *   already on one of Learn's models keeps it;
 * - every branch uses `path` context, which is what Learn shows (a `summary`
 *   or `independent` branch would answer from context the learner can't see);
 * - the lesson gets Learn's prompt (`target.systemPrompt`), since a learner
 *   could neither see nor change a custom one;
 * - every branch is `own-key`: Learn decides who pays per request, and an
 *   import never moves anything onto credit or the pool.
 *
 * Messages, titles, anchor quotes and privacy are kept as they are, and so is
 * the provider each reply ran on (it is history). Pure: the input is not
 * changed, and adapting a Learn backup again changes nothing.
 */
export function adaptBackupForLearn(
  backup: TreeBackupInput,
  target: LearnImportTarget,
): TreeBackupInput {
  const runnable = (providerId: string, model: string): boolean =>
    learnProviderId(providerId) === target.providerId && target.models.includes(model);
  return {
    ...backup,
    tree: { ...backup.tree, systemPrompt: target.systemPrompt },
    branches: backup.branches.map((b) => ({
      ...b,
      providerId: target.providerId,
      model: runnable(b.providerId, b.model) ? b.model : target.defaultModel,
      contextMode: 'path' as const,
      funding: 'own-key' as const,
    })),
  };
}

/** The legacy built-in id (`tangent`) names the built-in endpoint. */
function learnProviderId(providerId: string): string {
  return providerId === LEGACY_BUILT_IN_PROVIDER_ID ? BUILT_IN_PROVIDER_ID : providerId;
}
