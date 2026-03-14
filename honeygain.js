import { chromium } from 'patchright';

import { resolve, jsonDb, datetime, stealth, notify } from './src/util.js';
import { existsSync } from 'fs';
import { cfg } from './src/config.js';

const EMAIL = cfg.honeygain_email;
const PASSWORD = cfg.honeygain_password;

function cookieFileForEmail(email) {
  const safe = email.replace(/[^a-zA-Z0-9._-]/g, '_');
  return resolve(`data/honeygain-cookies-${safe}.json`);
}

if (!EMAIL || !PASSWORD) {
  console.error('ERROR: Please set HONEYGAIN_EMAIL and HONEYGAIN_PASSWORD.');
  process.exit(1);
}

const COOKIE_FILE = cookieFileForEmail(EMAIL);

(async () => {
  const browser = await chromium.launch({
    headless: cfg.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-position=0,0',
      `--window-size=${cfg.width},${cfg.height}`
    ]
  });

  const contextOptions = {
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: cfg.width, height: cfg.height }
  };

  if (existsSync(COOKIE_FILE)) {
    console.log(`🍪 Loading cookies for ${EMAIL} from ${COOKIE_FILE}...`);
    contextOptions.storageState = COOKIE_FILE;
  } else {
    console.log(`No cookie file found for ${EMAIL}, starting fresh login.`);
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const startTime = Date.now();

  try {
    console.log('--- Honeygain Claimer Start ---');
    console.log(`Using account: ${EMAIL}`);

    // 1. Navigate to Dashboard
    console.log('Navigating to Honeygain Dashboard...');
    const response = await page.goto('https://dashboard.honeygain.com', {
      waitUntil: 'domcontentloaded',
      timeout: cfg.timeout
    });

    if (response && response.status() === 403) {
      console.error('🚨 403 FORBIDDEN - Blocked.');
      await takeScreenshot(page, 'honeygain-blocked.png');
      process.exit(1);
    }

    await page.waitForTimeout(randomDelay(3000, 5000));
    const title = await page.title();
    if (title.includes('Access Denied')) {
      console.error('🚨 Access Denied detected in title');
      await takeScreenshot(page, 'honeygain-blocked.png');
      process.exit(1);
    }

    // 2. Login detection
    try {
      await Promise.race([
        page.waitForURL(
          url => url.toString().includes('login'),
          { timeout: 8000 }
        ),
        page.waitForSelector(
          'input[name="email"], input[type="email"]',
          { timeout: 8000 }
        )
      ]);
      console.log('🔒 Login page detected.');
      await performLogin(page, context);

      console.log('Returning to Dashboard after login...');
      await page.goto('https://dashboard.honeygain.com', {
        waitUntil: 'domcontentloaded',
        timeout: cfg.timeout
      });
      await page.waitForTimeout(randomDelay(4000, 8000));

    } catch (e) {
      console.log('ℹ️ No login required or already logged in:', e.message);
    }

    // 3. Accept cookie banner if present
    try {
      const cookieBtn = page.locator('button:has(span:has-text("Accept all"))');
      if (await cookieBtn.isVisible({ timeout: 5000 })) {
        console.log('🍪 Clicking cookie banner...');
        await cookieBtn.click();
        await page.waitForTimeout(randomDelay(2000, 6000));
      }
    } catch (e) {
      if (cfg.debug) console.log('No cookie banner detected (continuing).');
    }

    // 4. Wait for Lucky Pot area to appear
    console.log('Searching for Lucky Pot area...');
    const luckyPotArea = page.locator('img[src*="/images/lucky_pot/"]');  // FIX: *= statt =
    try {
      await luckyPotArea.first().waitFor({
        state: 'visible',
        timeout: cfg.timeout
      });
      console.log('✅ Lucky Pot area found.');
    } catch (e) {
      console.log('⚠️ Lucky Pot area not found within timeout.');
    }

    // 5. Check if already claimed today
    const claimedImg = page.locator('img[src="/images/lucky_pot/lucky_pot_claimed.svg"]');
    const isClaimed = await claimedImg.isVisible({ timeout: 3000 }).catch(() => false);
    if (isClaimed) {
      console.log('✅ Lucky Pot bereits für heute geclaimed.');
      await takeScreenshot(page, 'honeygain-already-claimed.png');
      console.log(`⏱️ Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
      await browser.close();
      return;
    }

    // 6. Claim Lucky Pot
    console.log('🎯 Lucky Pot nicht geclaimed – starte Claim...');
    const unlockedImg = page.locator('img[src="/images/lucky_pot/lucky_pot_unlocked.svg"]');
    try {
      await unlockedImg.waitFor({ state: 'visible', timeout: 5000 });
      await humanClick(page, unlockedImg);
      console.log('Lucky Pot geöffnet, warte auf Claim Button...');
      await page.waitForTimeout(randomDelay(2000, 6000));
      await humanClick(page, 'button:has-text("Open Lucky Pot")');
      console.log('✅ Lucky Pot geklickt.');
      await takeScreenshot(page, 'honeygain-claimed.png');
      console.log('🎉 Claim erfolgreich!');
    } catch (e) {
      console.log('⚠️ Lucky Pot unlock button nicht gefunden:', e.message);
      await takeScreenshot(page, 'honeygain-claim-failed.png');
    }

    console.log(`⏱️ Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  } catch (error) {
    console.error('❌ Unhandled error:', error);
    await takeScreenshot(page, 'honeygain-error.png');
  } finally {
    await browser.close();
  }

})();

// ─── Helper Functions ────────────────────────────────────────────────────────

async function performLogin(page, context) {
  console.log('✍️ Starting login process...');
  await takeScreenshot(page, 'debug-login-page.png');

  // Email field
  let emailField = null;
  for (const selector of ['input[name="email"]', 'input[type="email"]']) {
    try {
      emailField = page.locator(selector).first();
      await emailField.waitFor({ state: 'visible', timeout: 3000 });
      console.log(`✅ Email field found: ${selector}`);
      break;
    } catch (e) {
      if (cfg.debug) console.log(`Trying next email selector: ${selector}`);
    }
  }
  if (!emailField) throw new Error('No email input field found on login page');
  await emailField.type(EMAIL, { delay: 80 + Math.random() * 120 });

  // Password field
  let pwdField = null;
  for (const selector of ['input[type="password"]']) {
    try {
      pwdField = page.locator(selector).first();
      await pwdField.waitFor({ state: 'visible', timeout: 3000 });
      console.log(`✅ Password field found: ${selector}`);
      break;
    } catch (e) {}
  }
  if (!pwdField) throw new Error('No password input field found');
  await pwdField.type(PASSWORD, { delay: 80 + Math.random() * 120 });

  // Submit button
  let submitBtn = null;
  for (const selector of ['.hg-login-with-email', 'button[type="submit"]']) {
    try {
      submitBtn = page.locator(selector).first();
      await submitBtn.waitFor({ state: 'visible', timeout: 2000 });
      console.log(`✅ Submit button found: ${selector}`);
      break;
    } catch (e) {}
  }

  if (submitBtn) {
    await humanClick(page, submitBtn);
  } else {
    console.log('⚠️ No submit button found, trying Enter key...');
    await page.keyboard.press('Enter');
  }

  // Wait for successful login
  await page.waitForURL(
    url => !url.toString().includes('login'),
    { timeout: cfg.login_timeout }
  );
  console.log('✅ Login successful.');
  await takeScreenshot(page, 'debug-post-login.png');

  await context.storageState({ path: COOKIE_FILE });
  console.log(`💾 Session saved for ${EMAIL} at ${COOKIE_FILE}.`);
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function takeScreenshot(page, filename) {
  const dir = cfg.dir.screenshots;
  if (dir === '0') return;
  const path = `${dir}/${filename}`;
  await page.screenshot({ path, fullPage: true });
  if (cfg.debug) console.log(`📸 Screenshot: ${path}`);
}

async function humanClick(page, selectorOrLocator) {
  let element;
  try {
    element = typeof selectorOrLocator === 'string'
      ? page.locator(selectorOrLocator).first()
      : selectorOrLocator;
    await element.waitFor({ state: 'visible', timeout: 3000 });
    await element.waitFor({ state: 'attached', timeout: 2000 });
  } catch (e) {
    throw new Error(`humanClick failed: Element not found/visible`);
  }

  const box = await element.boundingBox();
  if (box) {
    const viewport = page.viewportSize();
    if (box.y < 0 || box.y + box.height > viewport.height) {
      console.log('📜 Scrolling to element...');
      const targetY = box.y - viewport.height / 2;
      const steps = 5 + Math.floor(Math.random() * 5);
      for (let i = 1; i <= steps; i++) {
        await page.mouse.wheel(0, (targetY / steps) * i);
        await page.waitForTimeout(randomDelay(50, 150));
      }
      await page.waitForTimeout(randomDelay(500, 1000));
    }

    const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
    const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);
    await page.mouse.move(targetX, targetY, { steps: 35 });
    await page.waitForTimeout(randomDelay(300, 600));
    await page.mouse.down();
    await page.waitForTimeout(randomDelay(100, 250));
    await page.mouse.up();
  }

  console.log('🖱️ Executing force click...');
  await element.click({ force: true, noWaitAfter: true });
  await page.waitForTimeout(randomDelay(1500, 3000));
}
