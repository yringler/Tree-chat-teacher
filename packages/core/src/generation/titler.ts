import {
  DEFAULT_TREE_TITLE,
  type Branch,
  type ChatMessage,
  type ChatNode,
  type Tree,
} from '@tangent/shared';
import { buildTitlePrompt, cleanTitle } from '../context/render.js';
import { errorText, type ServiceContext } from '../services/context.js';
import { collectText } from './context-resolver.js';

const TITLE_TIMEOUT_MS = 15_000;

/** Titles a branch (and a tree, for the trunk) after its first exchange. */
export class Titler {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Titles `branch` after its first exchange when `settings.autoTitle` is on:
   * the branch as it now is (null when nothing changed). Best-effort.
   */
  async titleFirstExchange(
    tree: Tree,
    branch: Branch,
    userNode: ChatNode,
    assistantNode: ChatNode,
  ): Promise<Branch | null> {
    if (!this.ctx.settings.autoTitle || assistantNode.seq !== 1) return null;
    return this.autoTitle(tree, branch, userNode, assistantNode);
  }

  /** Titles a default-titled branch (and a default-titled tree, for the trunk). Best-effort. */
  private async autoTitle(
    tree: Tree,
    branch: Branch,
    userNode: ChatNode,
    assistantNode: ChatNode,
  ): Promise<Branch | null> {
    const isTrunk = branch.parentBranchId === null;
    const titleBranch = branch.titleSource === 'default' && !isTrunk;
    const titleTree = isTrunk && tree.title === DEFAULT_TREE_TITLE;
    if (!titleBranch && !titleTree) return null;
    try {
      const { provider, model } = this.ctx.routes.summaryTarget(branch);
      // The test provider (kind `fake`) would just echo the prompt; keep the readable default title.
      if (provider.kind === 'fake') return null;
      const messages: ChatMessage[] = [];
      if (branch.anchorQuote)
        messages.push({ role: 'user', content: `Focus: ${branch.anchorQuote}` });
      messages.push({ role: 'user', content: userNode.content });
      messages.push({ role: 'assistant', content: assistantNode.content.slice(0, 4000) });
      const raw = await collectText(
        provider,
        model,
        buildTitlePrompt(messages),
        AbortSignal.timeout(TITLE_TIMEOUT_MS),
        { purpose: 'title', treeId: tree.id, branchId: branch.id, nodeId: null },
        this.ctx.settings.summaryEffort,
        (error) =>
          this.ctx.log('auto_title_failed', {
            treeId: tree.id,
            branchId: branch.id,
            providerId: provider.id,
            model,
            code: error.code,
            error: error.message,
          }),
      );
      const title = raw ? cleanTitle(raw) : null;
      if (!title) return null;
      const now = this.ctx.now();
      const repo = this.ctx.repos.trees;
      if (titleTree) await repo.updateTree(tree.id, { title, updatedAt: now });
      if (titleBranch) {
        return await repo.updateBranch(branch.id, { title, titleSource: 'auto', updatedAt: now });
      }
      return null;
    } catch (err) {
      this.ctx.log('auto_title_failed', {
        treeId: tree.id,
        branchId: branch.id,
        error: errorText(err),
      });
      return null;
    }
  }
}
