/**
 * Cloning wizards end to end: PCR, restriction cloning, Gibson assembly (primer design) and
 * Golden Gate, each from the Actions › Clone menu to the product opened as a new document.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// platform=linux: shortcuts use Ctrl (the browser keeps Cmd for itself on macOS).
const APP = '/?platform=linux&theme=light';
const SAMPLES = join(import.meta.dirname, '../src/samples');

async function openSample(page: Page, name: string) {
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.goto(APP);
  await page.getByText(name, { exact: true }).first().click();
  await expect(page.getByRole('toolbar', { name: 'Document' })).toContainText(name);
}

async function openFiles(page: Page, files: { name: string; buffer: Buffer }[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await chooser).setFiles(files.map((f) => ({ ...f, mimeType: 'text/plain' })));
}

const sampleFile = (name: string) => ({ name: `${name}.gb`, buffer: readFileSync(join(SAMPLES, `${name}.gb`)) });

async function openWizard(page: Page, item: string) {
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Clone' }).hover();
  await page.getByRole('menuitem', { name: item }).click();
}

async function selectFeature(page: Page, text: string) {
  await page.getByRole('treeitem').filter({ hasText: text }).first().click();
}

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Document' });

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('PCR of a selected region', async ({ page }) => {
  const errors = trackErrors(page);
  await openSample(page, 'pUC19');
  await selectFeature(page, 'Lac-operon'); // 1..230
  await openWizard(page, 'PCR…');
  const sheet = page.getByRole('dialog', { name: 'PCR' });
  await expect(sheet.getByTestId('product-size')).toHaveText('230 bp');
  await expect(sheet.getByRole('img', { name: /Gel: 230 bp product/ })).toBeVisible();

  // A primer that does not bind: the engine's error is shown and Create is disabled.
  const fwd = sheet.getByRole('textbox', { name: 'Forward primer sequence' });
  const original = await fwd.inputValue();
  await fwd.fill('ACGTTGCAACGTTGCAACGT');
  await expect(sheet.getByText('Cannot make the product')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Create Product' })).toBeDisabled();

  // A 5' tail is added to the product.
  await fwd.fill(`GAATTC${original}`);
  await expect(sheet.getByTestId('product-size')).toHaveText('236 bp');
  await sheet.getByRole('button', { name: 'Create Product' }).click();
  await expect(sheet).toBeHidden();
  await expect(toolbar(page)).toContainText('236 bp');
  await expect(toolbar(page)).toContainText('linear');
  expect(errors).toEqual([]);
});

test('restriction cloning of the pBR322 tet fragment into pUC19', async ({ page }) => {
  const errors = trackErrors(page);
  await openSample(page, 'pBR322');
  await openFiles(page, [sampleFile('pUC19')]); // becomes the active document: the vector
  await openWizard(page, 'Restriction cloning…');
  const sheet = page.getByRole('dialog', { name: 'Restriction Cloning' });
  await expect(sheet.getByRole('combobox', { name: 'Insert', exact: true })).toContainText('pBR322');

  // A directional pair in the MCS is suggested.
  await expect(sheet.getByRole('button', { name: 'Remove BamHI' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Remove EcoRI' })).toBeVisible();

  // Switch to BamHI + HindIII (the 346 bp tet fragment of pBR322 is one choice).
  await sheet.getByRole('button', { name: 'Remove EcoRI' }).click();
  await sheet.getByLabel('Filter enzymes').fill('HindIII');
  await sheet.getByRole('checkbox', { name: 'HindIII', exact: true }).click();
  await expect(sheet.getByTestId('junctions')).toContainText('HindIII (AGCT)');
  await expect(sheet.getByTestId('junctions')).toContainText('BamHI (GATC)');

  await sheet.getByRole('button', { name: 'Fragments and orientation' }).click();
  await sheet.getByRole('combobox', { name: 'Insert fragment' }).click();
  await page.getByRole('option', { name: /346 bp/ }).click();
  // pUC19 large HindIII-BamHI fragment (2,656 bp cut to cut) + 346 bp = 3,002 bp
  await expect(sheet.getByTestId('product-size')).toHaveText('3,002 bp');

  await sheet.getByRole('button', { name: 'Create Product' }).click();
  await expect(toolbar(page)).toContainText('3,002 bp');
  await expect(toolbar(page)).toContainText('circular');
  expect(errors).toEqual([]);
});

test('Gibson assembly with designed primers', async ({ page }) => {
  const errors = trackErrors(page);
  await openSample(page, 'pBR322');
  await selectFeature(page, 'tet'); // the insert: a selection of pBR322
  await openFiles(page, [sampleFile('pUC19')]);
  await selectFeature(page, 'polylinker'); // replaced by the insert
  await openWizard(page, 'Gibson assembly…');
  const sheet = page.getByRole('dialog', { name: 'Gibson Assembly' });
  await expect(sheet.getByRole('list', { name: 'Inserts' })).toContainText('pBR322 86..1,276');
  // 2,686 - 57 + 1,191
  await expect(sheet.getByTestId('product-size')).toHaveText('3,820 bp');
  await expect(sheet.getByRole('grid', { name: 'Junctions' }).getByRole('row')).toHaveCount(3);

  await sheet.getByRole('radio', { name: 'Primers (4)' }).click();
  await expect(sheet.getByRole('grid', { name: 'Designed primers' }).getByRole('row')).toHaveCount(5);
  await sheet.getByRole('radio', { name: 'DNA Amounts' }).click();
  await expect(sheet.getByRole('grid', { name: 'DNA amounts' })).toContainText('50.0 ng');
  await sheet.getByRole('spinbutton', { name: 'Vector amount' }).fill('100');
  await sheet.getByRole('spinbutton', { name: 'Vector amount' }).press('Tab');
  await expect(sheet.getByRole('grid', { name: 'DNA amounts' })).toContainText('100.0 ng');

  await sheet.getByRole('button', { name: 'Create Product' }).click();
  await expect(toolbar(page)).toContainText('3,820 bp');
  // The primers were added to the templates too.
  await page.getByRole('treeitem').filter({ hasText: 'pBR322' }).first().click();
  await expect(toolbar(page)).toContainText('Edited');
  await page.getByRole('searchbox', { name: 'Filter annotations' }).fill('1,276-');
  await expect(page.getByRole('treeitem').filter({ hasText: 'pBR322 86..1,276-F' })).toBeVisible();
  await expect(page.getByRole('treeitem').filter({ hasText: 'pBR322 86..1,276-R' })).toBeVisible();
  expect(errors).toEqual([]);
});

/** Deterministic DNA without BsaI / BsmBI sites. */
function body(seed: number, length: number): string {
  let x = seed;
  let s = '';
  while (s.length < length) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += 'ACGT'[(x >> 16) & 3];
    if (/GGTCTC|GAGACC|CGTCTC|GAGACG/.test(s)) s = s.slice(0, -1);
  }
  return s;
}
const part = (name: string, left: string, right: string, seed: number, n: number) => ({
  name: `${name}.fasta`,
  buffer: Buffer.from(`>${name}\nTTGACAGGTCTCA${left}${body(seed, n)}${right}TGAGACCTGTCAA\n`),
});

test('Golden Gate assembly of four parts', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(APP);
  await openFiles(page, [part('promoter', 'AATG', 'AGGT', 1, 400), part('cds', 'AGGT', 'GCTT', 2, 900), part('terminator', 'GCTT', 'CGCT', 3, 250), part('backbone', 'CGCT', 'AATG', 4, 2200)]);
  await expect(toolbar(page)).toBeVisible();
  await openWizard(page, 'Golden Gate…');
  const sheet = page.getByRole('dialog', { name: 'Golden Gate Assembly' });
  await expect(sheet.getByRole('combobox', { name: 'Enzyme' })).toContainText('BsaI');
  // 408 + 908 + 258 + 2,208 - 4 × 4 shared overhangs
  await expect(sheet.getByTestId('product-size')).toHaveText('3,766 bp');
  const order = sheet.getByRole('grid', { name: 'Assembly order' });
  await expect(order.getByRole('row')).toHaveCount(5);

  // Without the terminator the circle cannot close.
  await sheet.getByRole('button', { name: 'Remove terminator' }).click();
  await expect(sheet.getByText('Cannot make the product')).toBeVisible();
  await sheet.getByRole('combobox', { name: 'Add part' }).click();
  await page.getByRole('option', { name: /^terminator/ }).click();
  await expect(sheet.getByTestId('product-size')).toHaveText('3,766 bp');

  await sheet.getByRole('button', { name: 'Create Product' }).click();
  await expect(toolbar(page)).toContainText('3,766 bp');
  await expect(toolbar(page)).toContainText('circular');
  expect(errors).toEqual([]);
});
