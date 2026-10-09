/**
 * Smoke test of the main flows: open a sample → the map renders → click a feature → digest
 * sheet shows a gel → edit the sequence and undo.
 */
import { expect, test, type Page } from '@playwright/test';

// platform=linux: shortcuts use Ctrl (the browser keeps Cmd for itself on macOS).
const APP = '/?platform=linux&theme=light';

async function openSample(page: Page, name: string) {
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.goto(APP);
  await page.getByText(name, { exact: true }).first().click();
  await expect(page.getByRole('toolbar', { name: 'Document' })).toContainText(name);
}

test('open sample, select feature, digest and gel', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openSample(page, 'pBAD30');

  // The circular map draws the record's name and features.
  const canvas = page.locator('svg').filter({ hasText: 'pBAD30' }).first();
  await expect(canvas).toBeVisible();
  await expect(page.getByText('4,923 bp').first()).toBeVisible();

  // Selecting a feature in the sidebar selects its bases and opens the Feature card.
  await page.getByRole('treeitem').filter({ hasText: 'araC' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: 'Selection 1,082..1,960' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Feature', exact: true })).toBeVisible();

  // Digest & gel: choose EcoRI and HindIII, fragments and lanes appear.
  await page.keyboard.press('Control+d');
  const sheet = page.getByRole('dialog', { name: 'Digest & Gel' });
  await expect(sheet).toBeVisible();
  // Start from an empty choice (the sheet preselects a unique cutter).
  const chips = sheet.getByRole('button', { name: /^Remove / });
  while ((await chips.count()) > 0) await chips.first().click();
  for (const name of ['EcoRI', 'HindIII']) {
    const box = sheet.getByRole('checkbox', { name, exact: true });
    if (!(await box.isChecked())) await box.click();
  }
  await expect(sheet.getByText('EcoRI – HindIII').first()).toBeVisible();
  await expect(sheet.getByText(/1 kb Plus/).first()).toBeVisible(); // ladder lane
  const rows = sheet.getByRole('row');
  expect(await rows.count()).toBeGreaterThan(2);

  // Open the first fragment as a new linear document.
  await rows.nth(1).click();
  await sheet.getByRole('button', { name: 'Open Fragment' }).click();
  await expect(page.getByRole('toolbar', { name: 'Document' })).toContainText('linear');
  expect(errors).toEqual([]);
});

test('edit the sequence and undo', async ({ page }) => {
  await openSample(page, 'pUC19');
  await page.keyboard.press('Control+2'); // Sequence view
  const seq = page.locator('[data-hh-sequence]');
  await expect(seq).toBeVisible();
  const box = (await seq.boundingBox())!;
  await page.mouse.click(box.x + 160, box.y + 30);
  await page.keyboard.type('GATTACA');

  const toolbar = page.getByRole('toolbar', { name: 'Document' });
  await expect(toolbar).toContainText('2,693 bp');
  await expect(toolbar).toContainText('Edited');

  await page.keyboard.press('Control+z');
  await expect(toolbar).toContainText('2,686 bp');
  await expect(toolbar).not.toContainText('Edited');

  await page.keyboard.press('Control+Shift+z');
  await expect(toolbar).toContainText('2,693 bp');
});

test('find bar selects the next hit', async ({ page }) => {
  await openSample(page, 'pUC19');
  await page.keyboard.press('Control+f');
  await page.keyboard.type('GAATTC');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: /Selection [\d,]+\.\.[\d,]+ · 6 bp/ })).toBeVisible();
});

test('save downloads a GenBank file and clears the edited mark', async ({ page }) => {
  await openSample(page, 'pUC19');
  await page.keyboard.press('Control+2');
  const box = (await page.locator('[data-hh-sequence]').boundingBox())!;
  await page.mouse.click(box.x + 160, box.y + 30);
  await page.keyboard.type('A');
  const toolbar = page.getByRole('toolbar', { name: 'Document' });
  await expect(toolbar).toContainText('Edited');

  await page.keyboard.press('Control+s');
  const sheet = page.getByRole('dialog', { name: 'Save As' });
  await expect(sheet).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), sheet.getByRole('button', { name: 'Save' }).click()]);
  expect(download.suggestedFilename()).toBe('pUC19.gb');
  const text = await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
  expect(text).toMatch(/^LOCUS\s+\S+\s+2687 bp/);
  await expect(toolbar).not.toContainText('Edited');
});
