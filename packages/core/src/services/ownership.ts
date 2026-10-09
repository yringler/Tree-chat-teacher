import type { Branch, ChatNode, NodeLink, Tree } from '@tangent/shared';
import { NotFoundError } from '../errors.js';
import type { TreeRepository } from '../repository.js';

/**
 * Loads rows of trees owned by one account. A missing row, or one in another
 * account's tree, is reported as not found, so every entry point that loads
 * through here is scoped to the account.
 */
export class Ownership {
  constructor(
    private readonly repo: TreeRepository,
    readonly accountId: string,
  ) {}

  async tree(treeId: string): Promise<Tree> {
    const tree = await this.repo.getTree(treeId);
    if (!tree || tree.accountId !== this.accountId) throw new NotFoundError('Tree');
    return tree;
  }

  /** A branch with its (already loaded) tree. */
  async branch(branchId: string): Promise<{ branch: Branch; tree: Tree }> {
    const branch = await this.repo.getBranch(branchId);
    if (!branch) throw new NotFoundError('Branch');
    const tree = await this.repo.getTree(branch.treeId);
    if (!tree || tree.accountId !== this.accountId) throw new NotFoundError('Branch');
    return { branch, tree };
  }

  async node(nodeId: string): Promise<ChatNode> {
    const node = await this.repo.getNode(nodeId);
    if (!node) throw new NotFoundError('Node');
    const tree = await this.repo.getTree(node.treeId);
    if (!tree || tree.accountId !== this.accountId) throw new NotFoundError('Node');
    return node;
  }

  async link(linkId: string): Promise<NodeLink> {
    const link = await this.repo.getLink(linkId);
    if (!link) throw new NotFoundError('Link');
    const tree = await this.repo.getTree(link.treeId);
    if (!tree || tree.accountId !== this.accountId) throw new NotFoundError('Link');
    return link;
  }
}
