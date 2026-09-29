'use strict';
// Run with a local preview server and Playwright on NODE_PATH; all data is fictional.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../output/acceptance');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.RENTAL_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(process.env.RENTAL_TEST_URL || 'http://127.0.0.1:8765');
    await page.locator('[data-panel="finance"]').click();
    assert.equal(await page.locator('#rental-deposit-months').inputValue(), '2');
    assert.equal(await page.locator('#prepaid-months').inputValue(), '0');
    const before = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    const cases = [
      ['A', '0', '36', '2026-09-15'],
      ['B', '2', '36', '2026-09-15'],
      ['C', '3', '36', '2026-09-15'],
      ['D', '3', '36', '2026-12-31'],
      ['E60', '3', '60', '2026-12-31'],
      ['F120', '3', '120', '2026-12-31']
    ];
    const report = [];
    for (const [name, prepaid, terms, firstDate] of cases) {
      for (const [id, value] of Object.entries({ 'car-price': '100000', 'rental-vehicle': '丰田 赛那（虚构测试车辆）', 'rental-customer': '测试客户', term: terms, 'monthly-rate': '1', 'prepaid-months': prepaid, 'rental-deposit-months': '2', 'rental-first-date': firstDate })) await page.locator('#' + id).fill(value);
      await page.locator('#rental-calculate').click();
      assert.equal(await page.locator('#finance-error').innerText(), '');
      await page.locator('#rental-confirm').click();
      const result = await page.evaluate(() => calculationResult);
      const tableRows = await page.locator('#rental-preview tbody tr').allTextContents();
      assert.equal(tableRows.length, Number(terms));
      for (let index = 0; index < tableRows.length; index++) {
        const cells = await page.locator('#rental-preview tbody tr').nth(index).locator('td').allTextContents();
        const row = result.paymentSchedule[index];
        const fmt = cents => (cents / 100).toLocaleString('zh-CN', {minimumFractionDigits:2, maximumFractionDigits:2});
        assert.deepEqual(cells, [String(row.term), row.dueDate, fmt(row.plannedCents), fmt(row.offsetCents), fmt(row.dueCents)]);
      }
      const text = (await page.locator('#rental-preview').innerText()) + (await page.locator('#rental-summary-content').innerText()) + (await page.locator('#finance-message').inputValue());
      assert.equal(result.depositCents,result.fixedMonthlyCents*2);
      assert.equal(result.prepaidCents,result.fixedMonthlyCents*Number(prepaid));
      for (const word of ['月费率','资金成本','融资金额','还款本金','还款利息','剩余本金','贷款年利率','贷款余额','本息合计','总额','合计','剩余']) assert.ok(!text.includes(word), word);
      for (const format of ['png', 'pdf']) {
        const waiting = page.waitForEvent('download', { timeout: 90000 });
        await page.locator('#rental-' + format).click();
        const download = await waiting;
        assert.equal(await download.failure(), null);
        await download.saveAs(path.join(output, `${name}.${format}`));
        assert.ok(fs.statSync(path.join(output, `${name}.${format}`)).size > 10000);
      }
      fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(result, null, 2));
      if (name === 'C') await page.locator('.rental-sheet').screenshot({ path: path.join(output, 'C-preview.png') });
      report.push({ name, terms, fixedMonthlyCents: result.fixedMonthlyCents, totalRentCents: result.totalRentCents, prepaidCents: result.prepaidCents, outstandingCents: result.outstandingCents, tailAdjustmentCents: result.tailAdjustmentCents, rowsVerified: tableRows.length });
      await page.locator('#rental-close').click();
    }
    // Invalid input must erase all previous customer results and exportability.
    await page.locator('#prepaid-months').fill('999999999');
    assert.equal(await page.locator('#rental-results').isVisible(), false);
    assert.equal(await page.evaluate(() => calculationResult), null);
    // Reverse mode uses the full vehicle scheme amount, never prepaid principal reduction.
    await page.locator('#prepaid-months').fill('0');
    await page.locator('#term').fill('36');
    await page.locator('[data-mode="reverse"]').click();
    await page.locator('#target-payment').fill('4500');
    assert.equal(await page.locator('#car-price').inputValue(), '119117.64');
    await page.locator('#prepaid-months').fill('3');
    assert.equal(await page.locator('#car-price').inputValue(), '119117.64');
    await page.locator('[data-mode="quote"]').click();
    assert.equal(await page.locator('#car-price').isEditable(), true);
    // Missing vehicle cannot be exported; HTML characters are treated as text.
    await page.locator('#rental-vehicle').fill('');
    await page.locator('#rental-confirm').click();
    assert.equal(await page.locator('#rental-dialog').isVisible(), false);
    await page.locator('#rental-vehicle').fill('<img src=x onerror=alert(1)>');
    await page.locator('#rental-confirm').click();
    assert.equal(await page.locator('#rental-preview img').count(), 0);
    await page.locator('#rental-close').click();
    // Layout on a phone-sized viewport. Does not replace actual OPPO acceptance.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#rental-vehicle').fill('丰田 赛那（虚构测试车辆）');
    await page.locator('#car-price').fill('100000');
    await page.locator('#rental-confirm').click();
    await page.screenshot({ path: path.join(output, 'mobile-preview.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const mobileDownload = page.waitForEvent('download');
    await page.locator('#rental-png').click();
    await (await mobileDownload).saveAs(path.join(output, 'mobile.png'));
    await page.locator('#rental-close').click();
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage })), before);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'browser-report.json'), JSON.stringify({ cases: report, consoleErrors: errors, storageUnchanged: true, mobileDownload: true }, null, 2));
    console.log(JSON.stringify({ cases: report.length, consoleErrors: errors, storageUnchanged: true, output }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
