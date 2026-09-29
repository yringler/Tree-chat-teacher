import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('D1 smoke', () => {
  it('supports recursive CTEs', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO trees (id,title,trunk_branch_id,created_at,updated_at) VALUES ('t','T','b','x','x')`,
      ),
      env.DB.prepare(
        `INSERT INTO branches (id,tree_id,context_mode,title,title_source,provider_id,model,created_at,updated_at) VALUES ('b','t','path','Trunk','default','fake','m','x','x')`,
      ),
      env.DB.prepare(
        `INSERT INTO nodes (id,tree_id,branch_id,parent_id,seq,role,content,status,created_at) VALUES ('n1','t','b',NULL,0,'user','a','complete','x'),('n2','t','b','n1',1,'assistant','b','complete','x'),('n3','t','b','n2',2,'user','c','complete','x')`,
      ),
    ]);
    const { results } = await env.DB.prepare(
      `WITH RECURSIVE anc(id, parent_id, depth) AS (
         SELECT id, parent_id, 0 FROM nodes WHERE id = ?1
         UNION ALL
         SELECT n.id, n.parent_id, anc.depth + 1 FROM nodes n JOIN anc ON n.id = anc.parent_id
       ) SELECT nodes.id FROM nodes JOIN anc ON nodes.id = anc.id ORDER BY anc.depth DESC`,
    )
      .bind('n3')
      .all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(['n1', 'n2', 'n3']);
  });
});
