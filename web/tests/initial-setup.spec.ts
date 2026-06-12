import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_COLLECTION_NAME, TEST_LOCATION, TEST_PASSWORD, TEST_USERNAME } from './testConstants';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const authFile = path.join(__dirname, '../playwright/.auth/user.json');

test.describe('initial setup tests', () => {
  test('can click through initial setup flow', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('Welcome to Vox!')).toBeVisible();
    await page.getByTestId('submit-welcome').click();

    await expect(page.getByText('Music Sources')).toBeVisible();
    await expect(page.getByTestId('submit-mount-dirs')).toBeDisabled();
    await page.getByLabel('location').fill(TEST_LOCATION);
    await page.getByLabel('name').fill(TEST_COLLECTION_NAME);
    await page.getByTestId('submit-mount-dirs').click();

    await expect(page.getByText('User Account')).toBeVisible();
    await expect(page.getByTestId('submit-user')).toBeDisabled();
    await page.getByLabel('username').fill(TEST_USERNAME);
    await page.getByLabel('password').first().fill(TEST_PASSWORD);
    await page.getByLabel('confirm password').fill(TEST_PASSWORD);
    await page.getByTestId('submit-user').click();

    await page.waitForURL('**/files');

    await page.context().storageState({ path: authFile });
  });
});
