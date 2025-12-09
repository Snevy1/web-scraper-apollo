// selector-monitor.ts
import { PlaywrightCrawler, log } from 'crawlee';
//import { chromium } from 'playwright-extra';
//import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';

import dotenv from "dotenv";
dotenv.config();

// ⭐ NEW: Import SELECTORS from the dedicated file
import { SELECTORS } from './selectors.js';

// === CONFIGURATION ===
const EMAIL: string = process.env.EMAIL_USER ?? ""
const PASSWORD: string = process.env.APOLLO_PASS ?? ""
const LOGIN_URL = 'https://app.apollo.io/#/login?locale=en';
const TARGET_PEOPLE_URL = "https://app.apollo.io/#/people?sortAscending=false&sortByField=recommendations_score&contactLabelIds[]=6931d8f3d25a7e000db60102&prospectedByCurrentTeam[]=yes&recommendationConfigId=score";

// Email configuration
const transporter = nodemailer.createTransport({
    service: "Gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

const REPORT_EMAIL = process.env.REPORT_EMAIL || 'your-default-report-email@example.com'; // Use a dedicated report email or fallback
const REPORT_FILE = 'selector-monitor-report.txt';

// Helper for random delays
const randomDelay = (minMs: number = 1000, maxMs: number = 3000): Promise<void> => {
    const delay = Math.random() * (maxMs - minMs) + minMs;
    return new Promise(resolve => setTimeout(resolve, delay));
};

//chromium.use(StealthPlugin());

// === TYPE DEFINITIONS ===
interface SelectorTestResult {
    exists: boolean;
    count: number;
    description: string;
    textContent?: string;
    foundSelector?: string;
}

interface TextContentResult {
    exists: boolean;
    hasText: boolean;
    textContent?: string;
}

// === MONITORING FUNCTIONS ===
async function testSelector(pageOrElement: any, selector: string, description: string, timeout: number = 5000): Promise<SelectorTestResult> {
    try {
        await pageOrElement.waitForSelector(selector, { timeout });
        const count = await pageOrElement.locator(selector).count();
        return { exists: true, count, description };
    } catch (error) {
        return { exists: false, count: 0, description };
    }
}

async function testMultipleSelectors(page: any, selectors: string[], description: string, _timeout: number = 5000): Promise<SelectorTestResult> {
    for (const selector of selectors) {
        try {
            await page.waitForSelector(selector, { timeout: 2000 });
            const count = await page.locator(selector).count();
            return { exists: true, count, description, foundSelector: selector };
        } catch (error) {
            continue;
        }
    }
    return { exists: false, count: 0, description };
}

async function checkTextContentFromElement(element: any, selector: string): Promise<TextContentResult> {
    try {
        const targetElement = await element.locator(selector).first().waitFor({ state: 'visible', timeout: 2000 });
        const text = await targetElement.textContent();
        // Use innerText for name fields to grab full content, including hidden spans
        const cleanText = selector.includes('contact-name-cell') ? await targetElement.innerText() : text;
        
        return {
            exists: true,
            hasText: !!cleanText?.trim(),
            textContent: cleanText?.trim().substring(0, 50).replace(/[-—]{2,}\s?/, '') // Clean up name noise
        };
    } catch (error) {
        return { exists: false, hasText: false };
    }
}

async function handlePreScrapeChecks(page: any, log: any) {
    try {
        await page.waitForSelector(SELECTORS.postLogin.mainApp, { timeout: 60000 });
        log.info('✅ Dashboard loaded (mainApp found).');
    } catch (e) {
        log.error('Login failed: Post-login element not found.');
        throw new Error('Login failed / App not loaded.');
    }
    
    // Check for bot challenge (Cloudflare, etc.)
    const isChallengePresent = await page.evaluate(() => {
        return document.body.innerText.includes('Verifying your browser') 
            || document.body.innerHTML.includes('cf-norobot-container');
    }).catch(() => false);

    if (isChallengePresent) {
        log.warning('⚠️ Bot challenge detected! Waiting up to 60s...');
        try {
            // Wait for the challenge to pass by waiting for a post-login element
            await page.waitForSelector(SELECTORS.postLogin.mainApp, { timeout: 60000 });
            log.info('✅ Challenge passed.');
        } catch (e) {
            log.error('❌ Challenge not passed within 60s.');
            // We continue, but the data checks might fail
        }
    }

    // Check modals (e.g., welcome, new feature info)
    for (const selector of SELECTORS.modals) {
        try {
            const modal = await page.locator(selector).first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => null);
            if (modal) {
                log.info(`⚠️ Modal found: ${selector}`);
            }
        } catch (e) { /* continue */ }
    }

    await randomDelay(3000, 5000);
}


// In selector-monitor.ts, after the summary
async function handleSelectorFailures(results: any[], log: any) {
  const failedSelectors = results
    .flatMap(cat => cat.results)
    .filter(r => !r.exists && r.count === 0)
    .map(r => r.description);
  
  if (failedSelectors.length > 3) { // Threshold for auto-mining
    log.warning(`⚠️ ${failedSelectors.length} selectors failed, suggesting auto-mining`);
    
    // Optionally trigger miner automatically
    const shouldAutoMine = process.env.AUTO_MINE_ON_FAILURE === 'true';
    if (shouldAutoMine) {
      log.info('🔄 Triggering selector miner...');
      // You could spawn the miner as a child process here
    }
  }
}

// === REPORT GENERATION ===
function generateReport(results: any[]): string {
    const timestamp = new Date().toISOString();
    let report = `=== APOLLO.IO SELECTOR MONITORING REPORT ===\n`;
    report += `Generated: ${timestamp}\n`;
    report += `=============================================\n\n`;

    let passed = 0;
    let failed = 0;
    let warnings = 0;

    for (const category of results) {
        report += `\n## ${category.category}\n`;
        report += '-'.repeat(50) + '\n';

        for (const result of category.results) {
            const status = result.exists ? '✅' : '❌';
            const countInfo = result.count > 0 ? ` (Count: ${result.count})` : '';
            const selectorInfo = result.foundSelector ? ` [Selector: ${result.foundSelector}]` : '';
            
            report += `${status} ${result.description}${countInfo}${selectorInfo}\n`;
            
            if (result.exists) passed++;
            else failed++;
            
            // Add text content if available
            if (result.textContent) {
                report += `   Text: "${result.textContent}"\n`;
            }
            
            // Add warning for low row count
            if (result.exists && result.count > 0 && result.count < 5 && result.description.includes('row')) {
                report += `   ⚠️ Warning: Only ${result.count} rows found (expected more)\n`;
                warnings++;
            }
        }
    }

    // Summary
    report += `\n\n=== SUMMARY ===\n`;
    report += `Total checks: ${passed + failed}\n`;
    report += `✅ Passed: ${passed}\n`;
    report += `❌ Failed: ${failed}\n`;
    report += `⚠️ Warnings: ${warnings}\n`;
    report += `Success rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%\n`;

    // Recommendations
    report += `\n=== RECOMMENDATIONS ===\n`;
    if (failed > 0) {
        report += `1. Review failed selectors immediately. This indicates structural changes.\n`;
        report += `2. Run selector-miner.ts manually to generate new dynamic selectors.\n`;
        report += `3. Verify results manually in a browser.\n`;
    } else {
        report += `All critical selectors are stable. System running optimally.\n`;
    }


    

    return report;
}



// === EMAIL FUNCTION ===
async function sendEmailReport(report: string, attachmentPath?: string) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.warn('⚠️ SMTP credentials not configured. Skipping email.');
        return false;
    }
    
    try {
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: REPORT_EMAIL,
            subject: `Apollo.io Selector Monitor Report - ${new Date().toLocaleDateString()}`,
            text: report,
            attachments: attachmentPath ? [{
                filename: path.basename(attachmentPath),
                path: attachmentPath,
                contentType: 'text/plain'
            }] : []
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Email sent: ${info.messageId}`);
        return true;
    } catch (error) {
        console.error('❌ Failed to send email:', error);
        return false;
    }
}

// === MAIN MONITORING FUNCTION ===
async function monitorSelectors() {
    const results: any[] = [];
    
    const crawler = new PlaywrightCrawler({
        /* launchContext: {
            launcher: chromium,
            launchOptions: {
                headless: false, // Run headless for monitoring stability
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--window-size=1920,1080',
                ],
            },
        }, */

            launchContext: {
        launchOptions: {
            headless: false,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1920,1080',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--disable-web-security',
            ],
        },
    },
        browserPoolOptions: {
            useFingerprints: true,
        },

        requestHandlerTimeoutSecs: 300,

        preNavigationHooks: [
            async ({ page }) => {
                // Stealth adjustments
                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, });
                    const w = window as any;
                    if (w.chrome) { Object.defineProperty(w, 'chrome', { get: () => undefined, }); }
                    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5], });
                    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], });
                });
                await page.setViewportSize({ width: 1920, height: 1080 });
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Referer': 'https://www.google.com/',
                });
            },
        ],

        async requestHandler({ page, log }) {
            log.info('🔐 Starting selector monitoring...');
            
            // === LOGIN PAGE CHECK ===
            const loginResults: SelectorTestResult[] = [];
            await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await randomDelay(2000, 3000);

            // Test login selectors
            loginResults.push(await testSelector(page, SELECTORS.login.emailInput, 'Email input field'));
            loginResults.push(await testSelector(page, SELECTORS.login.passwordInput, 'Password input field'));
            loginResults.push(await testSelector(page, SELECTORS.login.submitButton, 'Login submit button'));

            results.push({ category: 'LOGIN PAGE', results: loginResults });

            // Perform login
            log.info('🔐 Attempting login...');
            await page.fill(SELECTORS.login.emailInput, EMAIL);
            await randomDelay(200, 500);
            await page.fill(SELECTORS.login.passwordInput, PASSWORD);
            await randomDelay(200, 500);
            
            const loginBtn = page.locator(SELECTORS.login.submitButton);
            if (await loginBtn.count() > 0) {
                 await loginBtn.click();
            } else {
                 log.error('Login submit button not found, skipping click.');
            }
            await randomDelay(8000, 12000); // Increased delay for post-login loading

            // === POST-LOGIN CHECK ===
            const postLoginResults: SelectorTestResult[] = [];
            try {
                await handlePreScrapeChecks(page, log);
                postLoginResults.push({ exists: true, count: 1, description: 'Main app container' });
            } catch (e) {
                postLoginResults.push({ exists: false, count: 0, description: 'Main app container' });
            }

            // Check modals (although handled in pre-scrape, good to report existence)
            const modalTest = await testMultipleSelectors(page, SELECTORS.modals, 'Modal popups');
            if (modalTest.exists) {
                log.warning('⚠️ Modal detected post-login.');
            }
            postLoginResults.push(modalTest);
            results.push({ category: 'POST-LOGIN', results: postLoginResults });

            // === NAVIGATE TO TARGET PAGE ===
            log.info('🔍 Navigating to target page...');
            await page.goto(TARGET_PEOPLE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await randomDelay(5000, 8000);

            // === TABLE STRUCTURE & DATA CHECK ===
            const tableResults: SelectorTestResult[] = [];
            let firstRow: any = null;

            // 1. Test row selectors
            const rowResult = await testMultipleSelectors(page, SELECTORS.table.rowSelectors, 'Data table rows (Check if data loaded)');
            tableResults.push(rowResult);

            if (rowResult.exists && rowResult.foundSelector) {
                // Get a locator for the first actual data row
                firstRow = page.locator(rowResult.foundSelector).first();
                if (await firstRow.count() > 0) {
                    // Test cells in first row
                    const cellResult = await testSelector(firstRow, SELECTORS.table.cell, 'Table cells in first row');
                    tableResults.push(cellResult);
                } else {
                    tableResults.push({ exists: false, count: 0, description: 'First data row located, but not found.' });
                }
            }

            // 2. Test specific data field selectors against the first row
            if (firstRow) {
                const cells = await firstRow.locator(SELECTORS.table.cell).all();
                
                if (cells.length >= 10) {
                    // MAPPING CHECK: Index 1 (Name)
                    const nameCheck = await checkTextContentFromElement(cells[1], SELECTORS.table.name);
                    tableResults.push({
                        exists: nameCheck.exists,
                        count: nameCheck.exists ? 1 : 0,
                        description: `Name in cell 1 (using T.name)`,
                        textContent: nameCheck.textContent
                    });

                    // MAPPING CHECK: Index 2 (Job Title)
                    const jobTitleCheck = await checkTextContentFromElement(cells[2], SELECTORS.table.jobTitle);
                    tableResults.push({
                        exists: jobTitleCheck.exists,
                        count: jobTitleCheck.exists ? 1 : 0,
                        description: `Job title in cell 2 (using T.jobTitle)`,
                        textContent: jobTitleCheck.textContent
                    });

                    // MAPPING CHECK: Index 3 (Company)
                    const companyCheck = await checkTextContentFromElement(cells[3], SELECTORS.table.companyName);
                    tableResults.push({
                        exists: companyCheck.exists,
                        count: companyCheck.exists ? 1 : 0,
                        description: `Company name in cell 3 (using T.companyName)`,
                        textContent: companyCheck.textContent
                    });

                    // MAPPING CHECK: Index 4 (Email)
                    const emailSpanCheck = await checkTextContentFromElement(cells[4], SELECTORS.table.email);
                    const emailButtonCheck = await checkTextContentFromElement(cells[4], SELECTORS.table.emailRequiresAccess);
                    tableResults.push({
                        exists: emailSpanCheck.exists || emailButtonCheck.exists,
                        count: (emailSpanCheck.exists ? 1 : 0) + (emailButtonCheck.exists ? 1 : 0),
                        description: `Email field in cell 4 (using T.email/T.emailRequiresAccess)`,
                        textContent: emailSpanCheck.textContent || emailButtonCheck.textContent
                    });

                    // MAPPING CHECK: Index 5 (Phone)
                    const phoneLinkCheck = await checkTextContentFromElement(cells[5], SELECTORS.table.phoneRequestLink);
                    const phoneSpanCheck = await checkTextContentFromElement(cells[5], SELECTORS.table.phoneVisible);
                    tableResults.push({
                        exists: phoneLinkCheck.exists || phoneSpanCheck.exists,
                        count: (phoneLinkCheck.exists ? 1 : 0) + (phoneSpanCheck.exists ? 1 : 0),
                        description: `Phone field in cell 5 (using T.phoneRequestLink/T.phoneVisible)`,
                        textContent: phoneLinkCheck.textContent || phoneSpanCheck.textContent
                    });

                    // MAPPING CHECK: Index 7 (LinkedIn)
                    const linkedInCheck = await testSelector(cells[7], SELECTORS.table.linkedIn, 'LinkedIn link in cell 7');
                    tableResults.push({
                        exists: linkedInCheck.exists,
                        count: linkedInCheck.exists ? 1 : 0,
                        description: `LinkedIn link in cell 7 (using T.linkedIn)`,
                    });

                    // MAPPING CHECK: Index 9 (Location)
                    const locationCheck = await checkTextContentFromElement(cells[9], SELECTORS.table.location);
                    tableResults.push({
                        exists: locationCheck.exists,
                        count: locationCheck.exists ? 1 : 0,
                        description: `Location in cell 9 (using T.location)`,
                        textContent: locationCheck.textContent
                    });

                    // MAPPING CHECK: Index 10 (Employee count)
                    const empCheck = await checkTextContentFromElement(cells[10], SELECTORS.table.employeeCount);
                    tableResults.push({
                        exists: empCheck.exists,
                        count: empCheck.exists ? 1 : 0,
                        description: `Employee count in cell 10 (using T.employeeCount)`,
                        textContent: empCheck.textContent
                    });

                    // Niche tags (Can be multiple, test existence)
                    const nicheResult = await testSelector(cells[12], SELECTORS.table.nicheTags, 'Niche/industry tags (in cell 12)');
                    tableResults.push(nicheResult);
                } else {
                    tableResults.push({ exists: false, count: cells.length, description: 'Insufficient cells found in first row (Expected >= 10)' });
                }
            }

            results.push({ category: 'DATA TABLE', results: tableResults });

            // === NAVIGATION CHECK ===
            const navResults: SelectorTestResult[] = [];
            navResults.push(await testSelector(page, SELECTORS.navigation.nextButton, 'Next page button'));
            navResults.push(await testSelector(page, SELECTORS.navigation.pageInput, 'Page number input'));
            
            results.push({ category: 'NAVIGATION', results: navResults });

            log.info('✅ Selector monitoring complete!');
        },

        maxRequestRetries: 1,
    });

    try {
        log.info('🚀 Starting Apollo.io selector monitor...');
        await crawler.run([LOGIN_URL]);

        // Generate report
        const report = generateReport(results);

        await handleSelectorFailures(results, log);
        
        // Save to file
        fs.writeFileSync(REPORT_FILE, report);
        console.log(`✅ Report saved to ${REPORT_FILE}`);

        // Send email
        console.log('📧 Sending email report...');
        const emailSent = await sendEmailReport(report, REPORT_FILE);
        
        if (emailSent) {
            console.log('✅ Email report sent successfully!');
        } else {
            console.log('⚠️ Could not send email, but report is saved locally.');
        }

        // Also print summary to console
        console.log('\n' + report.split('===')[0]); // Print header and first category

    } catch (error) {
        console.error('❌ Error during monitoring:', error);
        
        // Generate error report
        const errorReport = `=== MONITORING ERROR ===\n${new Date().toISOString()}\n\nError: ${error}\n\nPartial results:\n${JSON.stringify(results, null, 2)}`;
        fs.writeFileSync('monitoring-error-fatal.txt', errorReport);
    }
}

// === MAIN EXECUTION ===
async function runMonitor() {
    try {
        await monitorSelectors();
    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
}

// Check for required environment variables
if (!process.env.EMAIL_USER || !process.env.APOLLO_PASS) {
    log.error('❌ Set EMAIL_USER and APOLLO_PASS in .env');
    process.exit(1);
}
if (!process.env.EMAIL_PASS) {
    console.warn('⚠️ SMTP password (EMAIL_PASS) not configured. Email notification disabled.');
}


runMonitor().catch(console.error);