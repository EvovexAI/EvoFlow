/** @type {import('@playwright/test').PlaywrightTestConfig} */
export default {
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.EVOFLOW_E2E_BASE_URL || 'http://127.0.0.1:1421',
    headless: process.env.EVOFLOW_E2E_HEADED !== '1',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:1421',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      EVOFLOW_GATEWAY_PORT: process.env.EVOFLOW_GATEWAY_PORT || '8070',
      EVOFLOW_GATEWAY_URL: process.env.EVOFLOW_GATEWAY_URL || 'http://127.0.0.1:8070',
      EVOFLOW_VITE_PORT: process.env.EVOFLOW_VITE_PORT || '1421',
      EVOFLOW_VITE_HOST: process.env.EVOFLOW_VITE_HOST || '127.0.0.1',
    },
  },
}
