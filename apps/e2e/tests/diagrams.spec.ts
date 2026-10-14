import { expect, test, type Page } from '@playwright/test';
import { withExampleLesson } from './example-lesson';
import { membership, newEmail, paymentWebhook, sameOrigin, signIn } from './helpers';

/*
 * Mermaid diagrams in a reply, against the Worker and its real CSP (Trusted
 * Types included): the example lesson with its first reply replaced by one
 * holding a diagram, a source mermaid can't parse, and one that tries markup.
 */

const FLOWCHART = 'flowchart LR\n  A[Request] --> B{Cached?}\n  B -- yes --> C[Return it]\n';
const REPLY = [
  'Here is the flow:',
  '```mermaid\n' + FLOWCHART + '```',
  'And one that is broken:',
  '```mermaid\nflowchart TD\n  A[Start] -->\n  B{{{ broken\n```',
  'And one that tries markup:',
  '```mermaid\nflowchart TD\n  A["<img src=x onerror=alert(1)>"] --> B["<script>alert(2)</script>"]\n  click A "javascript:alert(3)"\n```',
].join('\n\n');

/** Page errors, console errors and every CSP (and so Trusted Types) violation. */
async function collectErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('dialog', (d) => {
    errors.push(`dialog: ${d.message()}`);
    void d.dismiss();
  });
  await page.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`CSP violation: ${e.violatedDirective} ${e.sample}`),
    ),
  );
  return errors;
}

test('learn: a finished reply draws its diagrams, sanitized, in the colour scheme', async ({
  page,
  context,
  baseURL,
}) => {
  const errors = await collectErrors(page);
  const treeId = await withExampleLesson(context, baseURL!, 'learn', REPLY);
  await page.goto(`/learn/t/${treeId}`);
  const diagrams = page.locator('.msg-body .diagram');
  await expect(diagrams).toHaveCount(3);

  const [drawn, broken, markup] = [diagrams.nth(0), diagrams.nth(1), diagrams.nth(2)];
  const figure = drawn.locator('.diagram-figure');
  await expect(figure.locator('svg')).toBeVisible();
  await expect(figure).toHaveAttribute('role', 'img');
  await expect(figure).toHaveAttribute('aria-label', 'Diagram: Request, Cached?, Return it');
  await expect(drawn.locator('pre')).toBeHidden();

  // What mermaid can't parse stays readable, as its source under a note.
  await expect(broken.locator('.diagram-note')).toHaveText('This diagram could not be drawn.');
  await expect(broken.locator('pre')).toContainText('B{{{ broken');

  // Markup in labels is drawn as nothing that runs or fetches.
  await expect(markup.locator('.diagram-figure svg')).toBeVisible();
  expect(
    await markup.evaluate((d) => ({
      fetching: d.querySelectorAll('img, image, script, iframe').length,
      handlers: [...d.querySelectorAll('*')].some((e) =>
        [...e.attributes].some((a) => a.name.startsWith('on') || /javascript:/i.test(a.value)),
      ),
    })),
  ).toEqual({ fetching: 0, handlers: false });

  // The source is a click away.
  await drawn.getByRole('button', { name: 'Show source' }).click();
  await expect(drawn.locator('pre')).toHaveText(FLOWCHART);
  await expect(figure).toBeHidden();
  await drawn.getByRole('button', { name: 'Show diagram' }).click();
  await expect(figure).toBeVisible();

  // A dark colour scheme redraws it in mermaid's dark theme.
  const fill = () =>
    figure.evaluate((f) => {
      const shape = f.querySelector('.node rect, .node polygon');
      return shape ? getComputedStyle(shape).fill : '';
    });
  const light = await fill();
  expect(light).not.toBe('');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(fill).not.toBe(light);
  await expect(drawn.locator('.diagram-figure')).toHaveCount(1);

  expect(errors).toEqual([]);
});

test('power: a selection inside a diagram quotes its whole source', async ({
  page,
  context,
  baseURL,
}) => {
  const errors = await collectErrors(page);
  const treeId = await withExampleLesson(context, baseURL!, 'power', REPLY);
  await page.goto(`/t/${treeId}`);
  const figure = page.locator('.msg-body .diagram-figure').first();
  await expect(figure.locator('svg')).toBeVisible();

  await figure.evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.textContent !== 'Cached?') continue;
      const range = document.createRange();
      range.setStart(n, 0);
      range.setEnd(n, 6);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      return;
    }
    throw new Error('no label');
  });
  const bar = page.locator('app-selection-ask');
  await bar.getByRole('button', { name: /^More: Tangent from here/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Tangent from here' });
  await expect(dialog.getByRole('textbox', { name: /^Anchor quote/ })).toHaveValue(
    '```mermaid\n' + FLOWCHART + '```',
  );
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});

test('power: a streamed reply draws its diagram once it ends', async ({
  page,
  context,
  baseURL,
}) => {
  const errors = await collectErrors(page);
  const userId = await signIn(context, baseURL!, newEmail('diagrams'));
  // A member, so the conversation on the offline test provider can be sent to.
  await paymentWebhook(context.request, [membership(userId, 'active', 1)]);
  const created = await context.request.post('/api/trees', {
    headers: sameOrigin(baseURL!),
    data: { title: 'Caching', providerId: 'fake', model: 'fake-1' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { tree } = (await created.json()) as { tree: { id: string } };
  await page.goto(`/t/${tree.id}`);

  const composer = page.locator('#composer-input');
  await composer.fill('Draw the cache flow');
  await composer.press('Enter');
  const reply = page.locator('.msg-assistant').last();
  await expect(reply.locator('.diagram-figure svg')).toBeVisible();
  await expect(reply.locator('.diagram-figure')).toHaveAttribute(
    'aria-label',
    'Diagram: Request, Cached?',
  );
  expect(errors).toEqual([]);
});

test('flutter: a finished reply loads the diagram library and draws its diagram', async ({
  page,
  context,
  baseURL,
}) => {
  const errors = await collectErrors(page);
  // The library is a deferred part of the app, loaded through a Trusted Types
  // policy of its own (FLUTTER_APP_CSP).
  const part = page.waitForResponse((r) => /\/app\/main\.dart\.js_\d+\.part\.js$/.test(r.url()));
  const treeId = await withExampleLesson(context, baseURL!, 'learn', REPLY);
  await page.goto(`/app/t/${treeId}`);
  expect((await part).status()).toBe(200);

  // Flutter draws to a canvas; its semantics tree carries the diagram's label
  // and the reply's text, with the note on the source mermaid can't parse.
  await page.locator('flt-semantics-placeholder').dispatchEvent('click');
  // The main thread opens at its end, and the tree holds only what is near
  // the view: scroll up to the first diagram.
  await page.mouse.move(640, 360);
  await page.mouse.wheel(0, -5000);
  await expect(page.getByLabel('Diagram: Request, Cached?, Return it')).toBeAttached();
  await expect(page.getByLabel(/This diagram could not be drawn\./)).toBeAttached();
  expect(errors).toEqual([]);
});
