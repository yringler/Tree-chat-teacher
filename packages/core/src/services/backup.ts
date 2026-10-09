import {
  errorKindOf,
  treeBackupSchema,
  type Branch,
  type ChatNode,
  type NodeLink,
  type ProviderRegistry,
  type Tree,
  type TreeBackup,
  type TreeBackupInput,
  type TreeDetail,
} from '@tangent/shared';
import { BrokenChainError, checkBranches } from '../context/assemble.js';
import { ValidationError } from '../errors.js';
import { adaptBackupForLearn, type LearnImportTarget } from '../learn-import.js';
import { pairKey } from '../links.js';
import { emptyToNull, type ServiceContext } from './context.js';
import { INTERRUPTED, type TreeService } from './tree-service.js';

/** Tree backups: export, and import under fresh ids. */
export class BackupService {
  /**
   * `learnProviders`: Learn adapts every import (`adaptBackupForLearn`) onto
   * this registry's default provider and its models, `path` context, and the
   * prompt a new tree gets. Null: imports are restored as they are.
   */
  constructor(
    private readonly ctx: ServiceContext,
    private readonly trees: TreeService,
    private readonly learnProviders: ProviderRegistry | null,
  ) {}

  async exportBackup(treeId: string): Promise<TreeBackup> {
    const detail = await this.trees.getTreeDetail(treeId);
    return {
      format: 'tangent-tree-backup',
      version: 1,
      exportedAt: this.ctx.now(),
      tree: detail.tree,
      branches: detail.branches,
      nodes: detail.nodes,
      links: detail.links,
    };
  }

  /**
   * Restores a backup under fresh ids, in this instance's account. Learn
   * first adapts it to what Learn can run. A backed-up branch without a
   * funding is on `own-key`: an imported conversation never spends credit
   * until its owner picks Tangent credit for it (Learn's fixed funding wins,
   * as for any write).
   */
  async importBackup(backup: TreeBackup | TreeBackupInput): Promise<TreeDetail> {
    const parsed = treeBackupSchema.parse(backup);
    const data = this.learnProviders
      ? adaptBackupForLearn(parsed, await this.learnImportTarget(this.learnProviders))
      : parsed;
    const newId = () => this.ctx.newId();
    const branchIds = new Map(data.branches.map((b) => [b.id, newId()] as const));
    const nodeIds = new Map(data.nodes.map((n) => [n.id, newId()] as const));
    const mapBranch = (id: string): string => {
      const mapped = branchIds.get(id);
      if (!mapped) throw new ValidationError(`Backup references unknown branch ${id}`);
      return mapped;
    };
    const mapNode = (id: string): string => {
      const mapped = nodeIds.get(id);
      if (!mapped) throw new ValidationError(`Backup references unknown node ${id}`);
      return mapped;
    };
    const trunks = data.branches.filter((b) => b.parentBranchId === null);
    if (trunks.length !== 1 || trunks[0]?.id !== data.tree.trunkBranchId) {
      throw new ValidationError('Backup must contain exactly one trunk branch');
    }
    // A broken branch would import, then fail every send on it.
    try {
      checkBranches(data.tree, data.branches, data.nodes);
    } catch (err) {
      if (!(err instanceof BrokenChainError)) throw err;
      throw new ValidationError(`This backup can't be restored: ${err.problem}`);
    }
    const treeId = newId();
    const now = this.ctx.now();
    const { accountId: _ignored, ...backupTree } = data.tree;
    const tree: Tree = {
      ...backupTree,
      id: treeId,
      accountId: this.ctx.accountId,
      trunkBranchId: mapBranch(data.tree.trunkBranchId),
      updatedAt: now,
    };
    const branches: Branch[] = data.branches.map((b) => ({
      ...b,
      id: mapBranch(b.id),
      treeId,
      parentBranchId: b.parentBranchId === null ? null : mapBranch(b.parentBranchId),
      branchPointNodeId: b.branchPointNodeId === null ? null : mapNode(b.branchPointNodeId),
      ...this.ctx.routes.runnableRoute({
        providerId: b.providerId,
        funding: b.funding ?? 'own-key',
      }),
    }));
    const nodes: ChatNode[] = data.nodes.map((n) => ({
      ...n,
      id: mapNode(n.id),
      treeId,
      branchId: mapBranch(n.branchId),
      parentId: n.parentId === null ? null : mapNode(n.parentId),
      // A backup made before nodes had a kind: read it from the message.
      errorKind: errorKindOf(n),
      ...(n.status === 'streaming' ? INTERRUPTED : {}),
    }));
    const links = importedLinks(data.links ?? [], nodeIds, treeId, newId);
    await this.ctx.repos.trees.importTree(tree, branches, nodes, links);
    return { tree, branches, nodes, links };
  }

  /** What Learn adapts an import to: its one provider and models, and a new tree's prompt. */
  private async learnImportTarget(providers: ProviderRegistry): Promise<LearnImportTarget> {
    const provider = providers.get(providers.defaultProviderId());
    if (!provider) throw new ValidationError('There is no provider to import onto');
    return {
      providerId: provider.id,
      models: provider.models().map((m) => m.id),
      defaultModel: provider.defaultModel(),
      systemPrompt: await this.trees.newTreeSystemPrompt(),
    };
  }
}

/**
 * A backup's links under the restored node ids. A link whose ends aren't
 * both in the backup, a self-link and a second link between the same pair
 * are dropped rather than failing the import: they are only cross-references.
 */
function importedLinks(
  links: NonNullable<TreeBackupInput['links']>,
  nodeIds: ReadonlyMap<string, string>,
  treeId: string,
  newId: () => string,
): NodeLink[] {
  const out: NodeLink[] = [];
  const pairs = new Set<string>();
  for (const l of links) {
    const source = nodeIds.get(l.sourceNodeId);
    const target = nodeIds.get(l.targetNodeId);
    if (!source || !target || source === target) continue;
    const key = pairKey(source, target);
    if (pairs.has(key)) continue;
    pairs.add(key);
    out.push({
      id: newId(),
      treeId,
      sourceNodeId: source,
      targetNodeId: target,
      note: emptyToNull(l.note?.trim()),
      origin: l.origin ?? 'user',
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    });
  }
  return out;
}
