import { expect, test, type Page } from '@playwright/test';

/** Collects page errors so every test fails on an uncaught exception or a console error. */
function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  return errors;
}

async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.locator('#viewport')).toBeVisible();
  await expect(page.locator('#layers-panel')).toBeVisible();
}

async function openSkinLab(page: Page, item: 'Skin…' | 'Eyes…') {
  await page.locator('.menu-btn', { hasText: 'Skin Lab' }).click();
  await page.locator('.popup-menu button', { hasText: item }).click();
  await expect(page.getByTestId('skinlab')).toBeVisible();
}

test('app starts without errors', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await expect(page.locator('#topbar')).toContainText('Moonfang');
  expect(errors).toEqual([]);
});

test('Skin Lab adds a skin folder to the layer stack', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await openSkinLab(page, 'Skin…');
  await page.getByRole('button', { name: /Olive/ }).click();
  await page.getByTestId('skinlab-add').click();
  await expect(page.locator('#layers-panel')).toContainText('Skin Lab Skin');
  expect(errors).toEqual([]);
});

test('pores are off by default and the toggle adds a Pores layer', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await openSkinLab(page, 'Skin…');
  const depth = page.locator('.field.slider', { hasText: 'Pore depth' });
  await expect(depth).toHaveCount(0);
  await page.getByTestId('skinlab').getByLabel('Pores').check();
  await expect(depth).toHaveCount(1);
  await page.getByTestId('skinlab-add').click();
  const names = await page.evaluate(() => (window as any).app.layers.find((l: any) => l.name === 'Skin Lab Skin').children.map((l: any) => l.name));
  expect(names).toContain('Pores');
  expect(errors).toEqual([]);
});

test('Skin Lab adds an eye folder from the Eyes tab', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await openSkinLab(page, 'Skin…');
  await page.getByTestId('skinlab-tab-eyes').click();
  await page.getByRole('button', { name: /Green/ }).click();
  await page.getByTestId('skinlab-add').click();
  await expect(page.locator('#layers-panel')).toContainText('Skin Lab Eye');
  expect(errors).toEqual([]);
});

test('eye gaze set in the Skin Lab can be moved for the whole eye from a layer\'s mask', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await openSkinLab(page, 'Eyes…');
  await page.locator('.field.slider', { hasText: 'Look left ↔ right' }).locator('input.num').fill('0.2');
  await page.locator('.field.slider', { hasText: 'Look left ↔ right' }).locator('input.num').press('Enter');
  await page.getByTestId('skinlab-add').click();
  await expect(page.locator('#layers-panel')).toContainText('Skin Lab Eye');
  const offsets = () =>
    page.evaluate(() => {
      const app = (window as any).app;
      const folder = app.layers.find((l: any) => l.name === 'Skin Lab Eye');
      return Object.fromEntries(folder.children.filter((l: any) => l.mask?.generator).map((l: any) => [l.name, l.mask.generator.offset[0]]));
    });
  expect(Object.values(await offsets()).every((x) => Math.abs((x as number) - 0.2) < 1e-6)).toBe(true);
  await page.evaluate(() => {
    const app = (window as any).app;
    const iris = app.layers.find((l: any) => l.name === 'Skin Lab Eye').children.find((l: any) => l.name === 'Iris');
    app.select(iris.id, 'content');
  });
  const centre = page.locator('#props-panel .field.slider', { hasText: 'Centre left ↔ right' }).locator('input.num');
  await expect(centre).toHaveValue('0.20');
  await centre.fill('-0.1');
  await centre.press('Enter');
  const moved = await offsets();
  expect(Object.values(moved).every((x) => Math.abs((x as number) + 0.1) < 1e-6)).toBe(true);
  expect(Object.keys(moved)).toContain('Pupil');
  expect(errors).toEqual([]);
});

test('a decal wraps around the model on its own layer and can be adjusted and placed again', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await page.waitForFunction(() => (window as any).app?.mesh && !(window as any).app.busy, null, { timeout: 120000 });
  // A ring on a white background, made in the page so the test needs no image file.
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#000';
    g.lineWidth = 16;
    g.beginPath();
    g.arc(64, 64, 44, 0, Math.PI * 2);
    g.stroke();
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.evaluate(() => (window as any).app.setTool('decal'));
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#props-panel .decal-pick.add').click();
  await (await chooser).setFiles({ name: 'ring.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('#props-panel .decal-pick:not(.add)')).toHaveCount(1);
  await page.locator('#props-panel .field', { hasText: 'Placement' }).locator('select').selectOption('wrap');
  await page.locator('#props-panel').getByLabel('One ink colour (tattoos)').check();
  const box = (await page.locator('#viewport').boundingBox())!;
  const centre = () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await centre();
  const projection = () => page.evaluate(() => (window as any).app.selected?.projection ?? null);
  await expect.poll(async () => (await projection())?.mapping ?? null).toBe('wrap');
  expect(await page.evaluate(() => (window as any).app.selected.name)).toBe('Decal ring');
  expect((await projection()).useImageColor).toBe(false);
  // Properties of the new layer: rotate it, then pick it up and drop it in the same spot again.
  const rotate = page.locator('#props-panel .field.slider', { hasText: 'Rotate' }).locator('input.num');
  await rotate.fill('45');
  await rotate.press('Enter');
  expect((await projection()).rotation).toBe(45);
  await page.getByTestId('decal-replace').click();
  await centre();
  await expect.poll(async () => page.evaluate(() => (window as any).app.pendingProjection)).toBeNull();
  expect((await projection()).rotation).toBe(45);
  expect(await page.evaluate(() => (window as any).app.layers.filter((l: any) => l.projection).length)).toBe(1);
  expect(errors).toEqual([]);
});

test('grime coats stack and can be added as their own folder', async ({ page }) => {
  const errors = trackErrors(page);
  await openApp(page);
  await openSkinLab(page, 'Skin…');
  await page.getByRole('button', { name: /\+ Dirt/ }).click();
  await page.getByRole('button', { name: /\+ Motor Oil/ }).click();
  const coats = page.getByTestId('skinlab-coat');
  await expect(coats).toHaveCount(2);
  // The top card is the top coat.
  await expect(coats.first().locator('.coat-name')).toHaveValue('Motor Oil');
  await page.getByTestId('skinlab-add-grime').click();
  await expect(page.locator('#layers-panel')).toContainText('Skin Lab Grime');
  await page.getByTestId('skinlab-add').click();
  await expect(page.locator('#layers-panel')).toContainText('Skin Lab Skin');
  expect(errors).toEqual([]);
});

test('skin presets update the live preview colour', async ({ page }) => {
  await openApp(page);
  await openSkinLab(page, 'Skin…');
  const preview = page.getByTestId('skinlab-preview');
  const before = await preview.evaluate((el) => (el as HTMLElement).style.background);
  await page.getByRole('button', { name: /Deep/ }).click();
  const after = await preview.evaluate((el) => (el as HTMLElement).style.background);
  expect(after).not.toBe(before);
});
