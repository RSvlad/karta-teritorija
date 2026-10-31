import { expect, test } from '@playwright/test';
import { lookup, openApp } from './helpers';

// Data: fixtures/demo-novi-sad.json. Futoška has rules up to 15 (Либерти), odd from 15 (Либерти, deputy) and even from 16 (Лиман).
test.describe('претрага', () => {
  test.beforeEach(({ page }) => openApp(page));

  test('„Futoska 15“, „Футошка 15“ и „futoška 15“ дају исти резултат', async ({ page }) => {
    const texts: string[] = [];
    for (const query of ['Futoska', 'Футошка', 'futoška']) {
      await page.goto('./');
      const card = await lookup(page, query, '15');
      texts.push(await card.innerText());
    }
    expect(texts[0]).toContain('Футошка 15');
    expect(texts[1]).toBe(texts[0]);
    expect(texts[2]).toBe(texts[0]);
  });

  test('гранични број наводи оба задужења и упозорава', async ({ page }) => {
    const card = await lookup(page, 'Футошка', '15');
    await expect(card).toContainText('граничан');
    await expect(card.getByRole('heading', { level: 2, name: /Територија 14/ })).toBeVisible();
  });

  test('број који није гранични нема упозорење', async ({ page }) => {
    const card = await lookup(page, 'Футошка', '16');
    await expect(card).toContainText('Територија 15');
    await expect(card).not.toContainText('граничан');
  });

  test('„линијар“: улица без броја приказује све делове', async ({ page }) => {
    const card = await lookup(page, 'Футошка');
    await expect(card).toContainText('Улица је подељена по бројевима');
    await expect(card).toContainText('Територија 14');
    await expect(card).toContainText('Територија 15');
  });

  test('улица која није подељена даје своју територију', async ({ page }) => {
    const card = await lookup(page, 'Железничка');
    await expect(card).toContainText('Територија 15');
    await expect(card).not.toContainText('подељена');
  });

  test('недодељена улица се јасно означава', async ({ page }) => {
    const card = await lookup(page, 'Дунавска');
    await expect(card).toContainText('Улица није додељена.');
  });

  test('непозната улица даје поруку, без картице', async ({ page }) => {
    await page.getByRole('combobox', { name: 'Улица или тачка' }).fill('ццццц');
    await expect(page.locator('.result')).toContainText('Улица или тачка није пронађена.');
    await expect(page.locator('.result .card')).toHaveCount(0);
  });

  test('број у непознатом облику се објашњава', async ({ page }) => {
    await page.getByRole('combobox', { name: 'Улица или тачка' }).fill('Футошка');
    await page.getByLabel('Број (опционо)').fill('abc');
    await expect(page.getByText('Број није у препознатом облику')).toBeVisible();
  });
});

test.describe('брзина', () => {
  test('резултат стиже за < 200 ms на успореном процесору (≈ средњи телефон)', async ({ page }) => {
    await openApp(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    // Measured inside the page, from the input event to the DOM update: no test-runner round trips in the number.
    const timeToCard = (field: 'street' | 'house', value: string, titleHas: string) =>
      page.evaluate(
        ({ field, value, titleHas }) =>
          new Promise<number>((resolve) => {
            const input = document.getElementById(field) as HTMLInputElement;
            const t0 = performance.now();
            const observer = new MutationObserver(() => {
              if (document.querySelector('.result .card-title')?.textContent?.includes(titleHas)) {
                observer.disconnect();
                resolve(performance.now() - t0);
              }
            });
            observer.observe(document.querySelector('.result')!, { childList: true, subtree: true, characterData: true });
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }),
        { field, value, titleHas },
      );

    const street = await timeToCard('street', 'Футошка', 'Футошка');
    const house = await timeToCard('house', '15', 'Футошка 15');

    expect(street, 'улица → картица (ms)').toBeLessThan(200);
    expect(house, 'број → картица (ms)').toBeLessThan(200);
  });
});