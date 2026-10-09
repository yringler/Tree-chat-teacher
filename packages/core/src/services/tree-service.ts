import {
  DEFAULT_BRANCH_TITLE_PREFIX,
  DEFAULT_GROUNDING_MODE,
  DEFAULT_TREE_TITLE,
  MAX_LINKS_PER_TREE,
  REPLY_INTERRUPTED_ERROR,
  TRUNK_TITLE,
  createBranchRequestSchema,
  createLinkRequestSchema,
  createTreeRequestSchema,
  updateBranchRequestSchema,
  updateLinkRequestSchema,
  updateSettingsRequestSchema,
  updateTreeRequestSchema,
  clip,
  plainText,
  type Branch,
  type ChatNode,
  type CreateBranchRequest,
  type CreateLinkRequest,
  type CreateTreeRequest,
  type DeleteBranchResponse,
  type NodeLink,
  type SettingsResponse,
  type Tree,
  type TreeDetail,
  type TreeSummary,
  type UpdateBranchRequest,
  type UpdateLinkRequest,
  type UpdateSettingsRequest,
  type UpdateTreeRequest,
} from '@tangent/shared';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { pairKey } from '../links.js';
import type { Repositories } from '../repository.js';
import { descendantBranches, indexTree } from '../tree.js';
import { emptyToNull, type ServiceContext } from './context.js';

/** What a node left `streaming` by a generation that is gone is marked as. */
export const INTERRUPTED = {
  status: 'error',
  error: REPLY_INTERRUPTED_ERROR,
  errorKind: 'interrupted',
} as const;

/** Trees, branches, links and the account's settings: everything that never calls a model. */
export class TreeService {
  constructor(private readonly ctx: ServiceContext) {}

  private get repo() {
    return this.ctx.repos.trees;
  }

  // ---------------------------------------------------------------- trees

  listTrees(): Promise<TreeSummary[]> {
    return this.repo.listTrees(this.ctx.accountId);
  }

  /**
   * Creates the tree and an empty trunk (on the route the request names, else
   * the default route, `defaultRoute`; the provider's default model unless
   * one is named). Without a system prompt in the request, the tree gets the
   * account's saved default, else the built-in one (`deps.defaultSystemPrompt`).
   */
  async createTree(request: CreateTreeRequest): Promise<TreeDetail> {
    const req = createTreeRequestSchema.parse(request);
    const route = await this.ctx.routes.newTreeRoute(req);
    const provider = this.ctx.routes.requireProvider(route);
    const model = req.model ?? provider.defaultModel();
    const systemPrompt = emptyToNull(req.systemPrompt) ?? (await this.newTreeSystemPrompt());
    const now = this.ctx.now();
    const tree: Tree = {
      id: this.ctx.newId(),
      accountId: this.ctx.accountId,
      title: req.title ?? DEFAULT_TREE_TITLE,
      systemPrompt,
      trunkBranchId: this.ctx.newId(),
      createdAt: now,
      updatedAt: now,
    };
    const trunk: Branch = {
      id: tree.trunkBranchId,
      treeId: tree.id,
      parentBranchId: null,
      branchPointNodeId: null,
      contextMode: 'path',
      anchorQuote: null,
      title: TRUNK_TITLE,
      titleSource: 'default',
      isPrivate: false,
      providerId: route.providerId,
      model,
      grounding: DEFAULT_GROUNDING_MODE,
      funding: route.funding,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.createTree(tree, trunk);
    return { tree, branches: [trunk], nodes: [], links: [] };
  }

  async getTreeDetail(treeId: string): Promise<TreeDetail> {
    const tree = await this.ctx.owned.tree(treeId);
    const [branches, nodes, links] = await Promise.all([
      this.repo.listBranches(treeId),
      this.repo.listNodes(treeId),
      this.repo.listLinks(treeId),
    ]);
    return { tree, branches, nodes, links };
  }

  async updateTree(treeId: string, request: UpdateTreeRequest): Promise<Tree> {
    const req = updateTreeRequestSchema.parse(request);
    await this.ctx.owned.tree(treeId);
    const patch: Partial<Pick<Tree, 'title' | 'systemPrompt' | 'updatedAt'>> = {
      updatedAt: this.ctx.now(),
    };
    if (req.title !== undefined) patch.title = req.title;
    if (req.systemPrompt !== undefined) patch.systemPrompt = emptyToNull(req.systemPrompt);
    const tree = await this.repo.updateTree(treeId, patch);
    if (!tree) throw new NotFoundError('Tree');
    return tree;
  }

  /**
   * Deletes a tree with everything in it. `stopGenerations` (the Worker's
   * Durable Object, which owns generations) runs once the tree is known to be
   * this account's, to stop its runs before their nodes go.
   */
  async deleteTree(
    treeId: string,
    options: { stopGenerations?: () => Promise<void> } = {},
  ): Promise<void> {
    await this.ctx.owned.tree(treeId);
    await options.stopGenerations?.();
    const deleted = await this.repo.deleteTree(treeId);
    if (!deleted) throw new NotFoundError('Tree');
  }

  // ------------------------------------------------------------- settings

  /** The account's settings, with the built-in default prompt a client can show ("Use default"). */
  async getSettings(): Promise<SettingsResponse> {
    const saved = await this.ctx.repos.settings.getSettings(this.ctx.accountId);
    return this.settingsResponse(saved?.systemPrompt ?? null);
  }

  /** Saves the account's default system prompt; a blank one means the built-in default (null). */
  async updateSettings(request: UpdateSettingsRequest): Promise<SettingsResponse> {
    const req = updateSettingsRequestSchema.parse(request);
    const systemPrompt = emptyToNull(req.systemPrompt);
    await this.ctx.repos.settings.putSettings(this.ctx.accountId, { systemPrompt }, this.ctx.now());
    return this.settingsResponse(systemPrompt);
  }

  private settingsResponse(systemPrompt: string | null): SettingsResponse {
    return { systemPrompt, defaultSystemPrompt: this.ctx.defaultSystemPrompt ?? '' };
  }

  /** The account's saved default prompt, else the built-in one. */
  async newTreeSystemPrompt(): Promise<string | null> {
    const saved = await this.ctx.repos.settings.getSettings(this.ctx.accountId);
    return emptyToNull(saved?.systemPrompt) ?? emptyToNull(this.ctx.defaultSystemPrompt);
  }

  // ------------------------------------------------------------- branches

  /** New branch hanging off `fromNodeId`; inherits provider/model from the parent branch. */
  async createBranch(request: CreateBranchRequest): Promise<Branch> {
    const req = createBranchRequestSchema.parse(request);
    const node = await this.ctx.owned.node(req.fromNodeId);
    const parent = await this.repo.getBranch(node.branchId);
    if (!parent) throw new NotFoundError('Branch');

    const requested = this.ctx.routes.requestedRoute(req, parent);
    const provider = this.ctx.routes.requireProvider(requested);
    // Learn writes only routes it can run (`RouteResolver.runnable`).
    const route = this.ctx.routes.runnable({
      ...requested,
      model:
        req.model ??
        (requested.providerId === parent.providerId ? parent.model : provider.defaultModel()),
    });
    const anchorQuote = emptyToNull(req.anchorQuote?.trim());
    const now = this.ctx.now();
    const branch: Branch = {
      id: this.ctx.newId(),
      treeId: node.treeId,
      parentBranchId: parent.id,
      branchPointNodeId: node.id,
      contextMode: req.contextMode,
      anchorQuote,
      title: req.title ?? defaultBranchTitle(anchorQuote, node),
      titleSource: req.title ? 'user' : 'default',
      isPrivate: req.isPrivate ?? false,
      providerId: route.providerId,
      model: route.model,
      grounding: req.grounding ?? parent.grounding ?? DEFAULT_GROUNDING_MODE,
      funding: route.funding,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.createBranch(branch);
    await this.repo.updateTree(branch.treeId, { updatedAt: now });
    return branch;
  }

  async updateBranch(branchId: string, request: UpdateBranchRequest): Promise<Branch> {
    const req = updateBranchRequestSchema.parse(request);
    const { branch } = await this.ctx.owned.branch(branchId);
    const isTrunk = branch.parentBranchId === null;
    if (isTrunk && (req.contextMode !== undefined || req.anchorQuote !== undefined)) {
      throw new ValidationError('The main thread has no context mode or anchor quote');
    }
    const patch: Parameters<Repositories['trees']['updateBranch']>[1] = {
      updatedAt: this.ctx.now(),
    };
    if (req.title !== undefined) {
      patch.title = req.title;
      patch.titleSource = 'user';
    }
    if (req.contextMode !== undefined) patch.contextMode = req.contextMode;
    if (req.anchorQuote !== undefined) patch.anchorQuote = emptyToNull(req.anchorQuote?.trim());
    if (req.isPrivate !== undefined) patch.isPrivate = req.isPrivate;
    if (req.grounding !== undefined) patch.grounding = req.grounding;
    if (req.providerId !== undefined || req.funding !== undefined || req.model !== undefined) {
      const route = this.ctx.routes.requestedRoute(req, branch);
      const provider = this.ctx.routes.requireProvider(route);
      const runnable = this.ctx.routes.runnable({
        ...route,
        model:
          req.model ??
          (route.providerId === branch.providerId ? branch.model : provider.defaultModel()),
      });
      patch.providerId = runnable.providerId;
      patch.funding = runnable.funding;
      patch.model = runnable.model;
    }
    const updated = await this.repo.updateBranch(branchId, patch);
    if (!updated) throw new NotFoundError('Branch');
    return updated;
  }

  /**
   * Deletes a branch with every branch below it: child branches hang off
   * its messages, so they cannot outlive it. Their messages, the links
   * touching them, the summaries anchored on them and the shares targeting
   * them go too. The trunk cannot be deleted (delete the tree instead).
   *
   * Without `stopGenerations` it rejects with ConflictError while any of
   * those branches is generating. With it, the caller (the Worker's Durable
   * Object, which owns generations) is handed the doomed branch ids to stop
   * its runs first, and leftover `streaming` nodes are deleted as orphans.
   */
  async deleteBranch(
    branchId: string,
    options: { stopGenerations?: (branchIds: ReadonlySet<string>) => Promise<void> } = {},
  ): Promise<DeleteBranchResponse> {
    const { branch, tree } = await this.ctx.owned.branch(branchId);
    if (branch.parentBranchId === null || branch.id === tree.trunkBranchId) {
      throw new ValidationError(
        'The main thread cannot be deleted; delete the conversation instead',
      );
    }

    const index = indexTree(await this.repo.listBranches(tree.id), []);
    const branchIds = [branch.id, ...descendantBranches(index, branch.id).map((b) => b.id)];
    const doomed = new Set(branchIds);
    if (options.stopGenerations) {
      await options.stopGenerations(doomed);
    } else {
      const streaming = await this.repo.listStreamingNodes(tree.id);
      if (streaming.some((n) => doomed.has(n.branchId))) {
        throw new ConflictError('A reply is still being generated in this branch; stop it first');
      }
    }
    const nodeIds = (await this.repo.listNodes(tree.id))
      .filter((n) => doomed.has(n.branchId))
      .map((n) => n.id);
    await this.repo.deleteBranches(tree.id, branchIds, this.ctx.now());
    return { treeId: tree.id, branchIds, nodeIds };
  }

  // ---------------------------------------------------------------- links

  /**
   * Links two messages of the same tree (both must be this account's: 404
   * otherwise). Linking a pair that is already linked, either way round,
   * changes nothing and returns the existing link with `created: false`.
   * Never generates, so read-only power branches can be linked too.
   */
  async createLink(request: CreateLinkRequest): Promise<{ link: NodeLink; created: boolean }> {
    const req = createLinkRequestSchema.parse(request);
    const from = await this.ctx.owned.node(req.fromNodeId);
    const to = await this.ctx.owned.node(req.toNodeId);
    if (from.treeId !== to.treeId) {
      throw new ValidationError('Only messages of the same conversation can be linked');
    }
    const links = await this.repo.listLinks(from.treeId);
    const key = pairKey(from.id, to.id);
    const existing = links.find((l) => pairKey(l.sourceNodeId, l.targetNodeId) === key);
    if (existing) return { link: existing, created: false };
    if (links.length >= MAX_LINKS_PER_TREE) {
      throw new ValidationError(
        `A conversation can hold at most ${MAX_LINKS_PER_TREE} links; remove one first`,
      );
    }
    const now = this.ctx.now();
    return this.repo.createLink(
      {
        id: this.ctx.newId(),
        treeId: from.treeId,
        sourceNodeId: from.id,
        targetNodeId: to.id,
        note: emptyToNull(req.note),
        origin: 'user',
        createdAt: now,
        updatedAt: now,
      },
      now,
    );
  }

  /** Changes a link's note (blank = none). */
  async updateLink(linkId: string, request: UpdateLinkRequest): Promise<NodeLink> {
    const req = updateLinkRequestSchema.parse(request);
    await this.ctx.owned.link(linkId);
    const updated = await this.repo.updateLink(linkId, {
      note: emptyToNull(req.note),
      updatedAt: this.ctx.now(),
    });
    if (!updated) throw new NotFoundError('Link');
    return updated;
  }

  async deleteLink(linkId: string): Promise<void> {
    await this.ctx.owned.link(linkId);
    if (!(await this.repo.deleteLink(linkId))) throw new NotFoundError('Link');
  }

  // ------------------------------------------------------------- recovery

  /**
   * Marks leftover `streaming` nodes of a tree as `error` ("interrupted").
   * Only for a caller that knows no generation of the tree is running (a
   * fresh process): a live reply in another branch would be failed too.
   */
  async recoverInterrupted(treeId: string): Promise<number> {
    const stale = await this.repo.listStreamingNodes(treeId);
    for (const node of stale) await this.repo.updateNode(node.id, INTERRUPTED);
    return stale.length;
  }

  /**
   * Marks one node `error` ("interrupted") if it is still `streaming`, for a
   * caller that knows no generation of it is running. Returns the node as it
   * now stands (null if there is none).
   */
  async recoverInterruptedNode(nodeId: string): Promise<ChatNode | null> {
    const node = await this.repo.getNode(nodeId);
    if (node?.status !== 'streaming') return node;
    await this.repo.updateNode(node.id, INTERRUPTED);
    return { ...node, ...INTERRUPTED };
  }
}

function defaultBranchTitle(anchorQuote: string | null, node: ChatNode): string {
  // A quote is plain text already; a message is Markdown ("**a confident kitten**").
  const source = anchorQuote ? anchorQuote.replace(/\s+/g, ' ').trim() : plainText(node.content);
  if (!source) return 'New branch';
  const clipped = clip(source.split(' ').slice(0, 6).join(' '), 48);
  return anchorQuote ? clipped : `${DEFAULT_BRANCH_TITLE_PREFIX}${clipped}`;
}
