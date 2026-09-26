import { test, expect } from '@playwright/test';

test('AC-CRUD and AC-PERSIST: adding and completing survive reload', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('todo-input').fill('写周报');
  await page.getByTestId('todo-submit').click();
  await expect(page.getByText('写周报')).toBeVisible();
  await page.reload();
  await expect(page.getByText('写周报')).toBeVisible();
  await page.getByTestId('toggle-todo').first().click();
  await page.reload();
  await expect(page.getByTestId('toggle-todo').first()).toBeChecked();
});

test('AC-DRAG: pointer drag moves a todo into another category and persists', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('category-input').fill('工作');
  await page.getByTestId('category-submit').click();
  await page.getByTestId('todo-input').fill('开会');
  await page.getByTestId('todo-submit').click();
  const targetColumn = page.getByTestId('category-column').filter({ has: page.getByRole('heading', { name: '工作', exact: true }) });
  await page.getByTestId('todo-row').filter({ hasText: '开会' }).dragTo(targetColumn);
  await expect(targetColumn.getByText('开会')).toBeVisible();
  await page.reload();
  await expect(targetColumn.getByText('开会')).toBeVisible();
});
