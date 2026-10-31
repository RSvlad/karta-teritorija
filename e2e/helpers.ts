import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/** Opens the app and waits until the city data is loaded (the search field is there only then). Fields are found by id: their labels follow the script. */
export async function openApp(page: Page): Promise<void> {
  await page.goto('./');
  await expect(page.locator('#street')).toBeVisible();
}

/** Types a street (and a house number) like a user and returns the result card once it shows that house number. */
export async function lookup(page: Page, street: string, house?: string): Promise<Locator> {
  await page.locator('#street').fill(street);
  if (house) await page.locator('#house').fill(house);
  const card = page.locator('.result .card');
  await expect(card).toBeVisible();
  if (house) await expect(card.locator('.card-title')).toContainText(house);
  return card;
}
