import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { lookup, openApp } from './helpers';

const THEME_KEY = 'moj-paroh:theme';
const SCRIPT_KEY = 'moj-paroh:script';
const MIN_TARGET = 44;

/** Screens worth checking: each one shows different components. */
const screens: { name: string; show: (page: Page) => Promise<void> }[] = [
  { name: 'почетни екран', show: async () => {} },
  { name: 'резултат са граничним бројем', show: async (page) => { await lookup(page, 'Футошка', '15'); } },
  { name: 'недодељена улица', show: async (page) => { await lookup(page, 'Дунавска'); } },
  {
    name: 'листа предлога',
    show: async (page) => {
      await page.getByRole('combobox', { name: 'Улица или тачка' }).fill('шк');
      await expect(page.getByRole('listbox')).toBeVisible();
    },
  },
  {
    name: 'панел мапе',
    show: async (page) => {
      await page.getByRole('button', { name: 'Прикажи мапу' }).click();
      await expect(page.getByRole('list', { name: 'Територије' })).toBeVisible();
    },
  },
];

async function prepare(page: Page, theme: 'light' | 'dark', script: 'cyr' | 'lat') {
  await page.addInitScript(
    ([themeKey, themeValue, scriptKey, scriptValue]) => {
      localStorage.setItem(themeKey!, themeValue!);
      localStorage.setItem(scriptKey!, scriptValue!);
    },
    [THEME_KEY, theme, SCRIPT_KEY, script],
  );
  // Map tiles are not what is checked here, and the network must not decide the outcome.
  await page.route('https://tiles.openfreemap.org/**', (route) => route.abort());
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`WCAG AA, ${theme === 'light' ? 'светла' : 'тамна'} тема`, () => {
    for (const screen of screens) {
      test(screen.name, async ({ page }) => {
        await prepare(page, theme, 'cyr');
        await openApp(page);
        await screen.show(page);
        const { violations } = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          // The map canvas is third-party; the same territories are reachable through the buttons above it.
          .exclude('.maplibregl-map')
          .analyze();
        expect(
          violations.map((v) => ({ rule: v.id, impact: v.impact, nodes: v.nodes.map((n) => `${n.target.join(' ')}: ${n.failureSummary}`) })),
        ).toEqual([]);
      });
    }
  });
}

test('латиница: исте провере приступачности', async ({ page }) => {
  await prepare(page, 'light', 'lat');
  await openApp(page);
  await lookup(page, 'Futoska', '15');
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('.maplibregl-map').analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
});

test.describe(`мете за додир ≥ ${MIN_TARGET} px`, () => {
  for (const screen of screens) {
    test(screen.name, async ({ page }) => {
      await prepare(page, 'light', 'cyr');
      await openApp(page);
      await screen.show(page);
      const tooSmall = await page.evaluate((min) => {
        // A checkbox is operated through its label, so the label is the target.
        const targets = [...document.querySelectorAll<HTMLElement>(
          'button, a.button, select, input:not([type=checkbox]), label:has(> input[type=checkbox]), [role=option]',
        )].filter((el) => !el.closest('.maplibregl-map'));
        return targets
          .map((el) => ({ el, box: el.getBoundingClientRect() }))
          .filter(({ box }) => box.width > 0 && box.height > 0 && (box.width < min || box.height < min))
          .map(({ el, box }) => `${el.tagName.toLowerCase()}.${el.className} „${(el.textContent ?? '').trim().slice(0, 30)}“ ${Math.round(box.width)}×${Math.round(box.height)}`);
      }, MIN_TARGET);
      expect(tooSmall).toEqual([]);
    });
  }
});
