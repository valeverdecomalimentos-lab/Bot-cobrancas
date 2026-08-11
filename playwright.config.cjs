const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests/e2e',
    workers: 1,
    timeout: 60_000,
    outputDir: '.artifacts/playwright',
    reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
    expect: { timeout: 10_000 },
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
});
