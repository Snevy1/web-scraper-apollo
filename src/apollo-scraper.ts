import { PlaywrightCrawler, Dataset, KeyValueStore, log } from 'crawlee';
import ExcelJS from 'exceljs';
import nodemailer from 'nodemailer';
import { SELECTORS } from './selectors.js';
//import { Actor } from 'apify';

import dotenv from "dotenv";
dotenv.config();

log.setLevel(log.LEVELS.DEBUG);

log.debug('Setting up crawler.');

// === CONFIGURATION ===
const EMAIL: string = process.env.EMAIL_USER ?? "";
const PASSWORD: string = process.env.APOLLO_PASS ?? "";
const LOGIN_URL = 'https://app.apollo.io/#/login?locale=en'; 
const TARGET_PEOPLE_URL_BASE = "https://app.apollo.io/#/people?sortAscending=false&sortByField=recommendations_score&contactLabelIds[]=6931d8f3d25a7e000db60102&prospectedByCurrentTeam[]=yes&recommendationConfigId=score";
const REPORT_EMAIL = process.env.REPORT_EMAIL



const transporter = nodemailer.createTransport({
    service: "Gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// Persistence and Control
const MAX_PAGES_TO_SCRAPE = 5;
const PERSISTENCE_KEY = 'LAST_SCRAPED_PAGE';
const RESET_SCRAPE = process.env.RESET_SCRAPE === 'true';
const OUTPUT_EXCEL_FILE = 'apollo-data.xlsx';

let startPage = 1;

// Helper for random delays
const randomDelay = (minMs: number = 1000, maxMs: number = 3000): Promise<void> => {
    const delay = Math.random() * (maxMs - minMs) + minMs;
    return new Promise(resolve => setTimeout(resolve, delay));
};

// =============================
// CLOUDFLARE/MODAL HANDLER
// =============================
async function handlePreScrapeChecks(page: any, log: any) {
    try {
        await page.waitForSelector('#main-app', { timeout: 60000 }); 
        log.info('✅ Dashboard loaded (#main-app found).');
    } catch (e) {
        log.error('Login failed: Post-login element not found.');
        throw new Error('Login failed / App not loaded.');
    }
    
    const isChallengePresent = await page.evaluate(() => {
        return document.body.innerText.includes('Verifying your browser') 
            || document.body.innerHTML.includes('cf-norobot-container');
    }).catch(() => false);

    if (isChallengePresent) {
        log.warning('⚠️ Bot challenge detected! Waiting up to 60s...');
        log.warning('If a CAPTCHA appears, please solve it manually.');

        try {
            const checkbox = await page.locator('#cf-norobot-container input[type="checkbox"]').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => null);
            if (checkbox) {
                await checkbox.click();
                log.info('Attempted to click checkbox...');
            }

            await page.waitForSelector('#main-app', { timeout: 60000 }); 
            log.info('✅ Challenge passed.');
        } catch (e) {
            log.error('❌ Challenge not passed within 60s.');
            throw new Error('Bot Challenge Blocked'); 
        }
    }

    // Dismiss modals
    try {
        const modalSelectors = ['.zp-modal-mask', '.modal', '.popup', '[role="dialog"]'];
        log.info('Checking for modals...');
        for (const selector of modalSelectors) {
            try {
                const modal = await page.locator(selector).first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => null);
                if (modal) {
                    log.info(`Dismissing modal: ${selector}`);
                    const closeButton = await modal.locator('button:has-text("Close"), button[aria-label="Close"], .close, .modal-close, button:has-text("Dismiss")').first().waitFor({ state: 'visible', timeout: 2000 }).catch(() => null);
                    if (closeButton) {
                        await closeButton.click();
                        await randomDelay(1000, 2000); 
                    } else {
                        await page.keyboard.press('Escape');
                        await randomDelay(1000, 2000);
                    }
                }
            } catch (e) { /* continue */ }
        }
    } catch (e) { log.info('No modals found'); }

    await randomDelay(3000, 5000);
}

// =============================
// SCRAPING LOGIC
// =============================
async function scrapeCurrentPage(page: any, log: any): Promise<void> {
    log.info('Scraping current page...');

    const T = SELECTORS.table;
    let rows: any[] = [];

    // Step 1: Find data rows using priority selectors
    for (const selector of T.rowSelectors) {
        try {
            const candidates = await page.$$(selector);
            if (candidates.length > 0) {
                const firstRowCells = await candidates[0].$$(T.cell);
                if (firstRowCells.length >= 10) {
                    rows = candidates;
                    log.info(`Found ${rows.length} rows using selector: ${selector}`);
                    break;
                }
            }
        } catch (e) {
            // Silent – try next selector
        }
    }

    if (rows.length === 0) {
        log.warning('No data rows found on this page');
        return;
    }

    const pageData: any[] = [];

    // Step 2: Loop through each row
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        await randomDelay(100, 400); // Be gentle

        try {
            const cells = await row.$$(T.cell);
            if (cells.length < 10) continue; // Skip malformed rows

            // Helper functions
            const getText = async (cell: any, selector: string): Promise<string | null> => {
                try {
                    const el = await cell.$(selector);
                    if (!el) return null;
                    const text = await el.textContent();
                    return text?.trim() || null;
                } catch {
                    return null;
                }
            };

            const getAttr = async (cell: any, selector: string, attr: string): Promise<string | null> => {
                try {
                    const el = await cell.$(selector);
                    return el ? await el.getAttribute(attr) : null;
                } catch {
                    return null;
                }
            };

            // Cell mapping
            const nameCell = cells[1];
            const titleCell = cells[2];
            const companyCell = cells[3];
            const emailCell = cells[4];
            const phoneCell = cells[5];
            const locationCell = cells[9];
            const empCountCell = cells[10];

            const nameAnchor = await nameCell.$('a[data-to*="/contacts/"]');
            const rawTextWithNoise = nameAnchor ? (await nameAnchor.innerText()) : '';
            const fullNameRaw = rawTextWithNoise
                .replace(/[-—]{2,}\s?/, '')
                .replace(/View more options to select rows/g, '')
                .replace(/View more options to select rows/g, '')
                .trim();

            const nameParts = fullNameRaw.split(' ').filter(Boolean);
            const firstName = nameParts[0] || 'N/A';
            const lastName = nameParts.slice(1).join(' ') || 'N/A';

            // Job Title
            const jobTitle = (await getText(titleCell, T.jobTitle)) || 'N/A';

            // Company Name
            const companyName = (await getText(companyCell, T.companyName)) || 'N/A';

            // Email
            let personalEmail = 'N/A';
            const emailText = await getText(emailCell, T.email);
            const accessBtn = await emailCell.$(T.emailRequiresAccess);
            if (accessBtn && (await accessBtn.isVisible?.())) {
                personalEmail = 'Requires Access';
            } else if (emailText && !emailText.toLowerCase().includes('no email')) {
                personalEmail = emailText;
            } else if (emailText?.toLowerCase().includes('no email')) {
                personalEmail = 'No email';
            }

            // Phone
            let phoneNumber = 'N/A';
            const requestLink = await phoneCell.$(T.phoneRequestLink);
            if (requestLink && (await requestLink.isVisible?.())) {
                phoneNumber = 'Requires Access';
            } else {
                const visiblePhone = await getText(phoneCell, T.phoneVisible);
                if (visiblePhone && visiblePhone !== 'Request phone number') {
                    phoneNumber = visiblePhone;
                }
            }

            // LinkedIn
            let linkedInUrl = 'N/A';
            const liLink = await cells[7].$(T.linkedIn);
            if (liLink) {
                linkedInUrl = (await getAttr(cells[7], T.linkedIn, 'href')) || 'N/A';
            }

            // Location
            const location = (await getText(locationCell, T.location)) || 'N/A';

            // Employee Count
            const employeeCount = (await getText(empCountCell, T.employeeCount)) || 'N/A';

            // Industries / Niche Tags
            const nicheElements = await cells[12].$$(T.nicheTags);
            const niches: string[] = [];
            for (const el of nicheElements) {
                const text = await el.textContent();
                const trimmed = text?.trim();
                if (trimmed && !trimmed.startsWith('+') && trimmed.length > 1) {
                    niches.push(trimmed);
                }
            }
            const niche = niches.length > 0 ? niches.join(', ') : 'N/A';

            // Build final record
            const record = {
                'First Name': firstName,
                'Last Name': lastName,
                'Full Name': fullNameRaw,
                'Job Title': jobTitle,
                'Company': companyName,
                'Personal Email': personalEmail,
                'Phone': phoneNumber,
                'LinkedIn Profile': linkedInUrl,
                'Location': location,
                'Employee Count': employeeCount,
                'Industry/Niche': niche,
            };

            pageData.push(record);
            log.info(`Row ${i + 1} – ${firstName} ${lastName} – ${jobTitle} @ ${companyName}`);

        } catch (err:any) {
            log.warning(`Failed to scrape row ${i + 1}: ${err.message || err}`);
        }
    }

    // Step 3: Save data
    if (pageData.length > 0) {
        await Dataset.pushData(pageData);
        log.info(`Successfully scraped and saved ${pageData.length} contacts from this page`);
    } else {
        log.warning('No contacts were scraped on this page');
    }
}

// =============================
// PERSISTENCE SETUP
// =============================
async function setupPersistence(log: any) {
    const store = await KeyValueStore.open();

    if (RESET_SCRAPE) {
        await store.setValue(PERSISTENCE_KEY, null);
        log.info('🔄 RESET: Persistence cleared. Starting from page 1.');
        return 1;
    }

    const lastPage = await store.getValue<number>(PERSISTENCE_KEY);
    const start = lastPage ? lastPage + 1 : 1;
    startPage = start;

    log.info(`💾 Starting from page ${startPage}`);
    return startPage;
}

// =============================
// EMAIL FUNCTIONALITY
// =============================
async function sendEmailReport(fileBuffer: Buffer, itemsCount: number, error?: string) {
    if (!REPORT_EMAIL) {
        log.warning('No email recipient configured. Skipping email.');
        return;
    }

    try {
        // Create transporter
        

        // Email subject based on success/error
        const subject = error 
            ? `❌ Apollo Scraper Failed - ${error}`
            : `✅ Apollo Scraper Report - ${itemsCount} Contacts`;

        const text = error
            ? `The Apollo scraper encountered an error:\n\n${error}\n\nCheck the Apify platform for details.`
            : `The Apollo scraper has completed successfully!\n\nTotal contacts scraped: ${itemsCount}\n\nYou can download the Excel file from:\n1. Apify Storage Dashboard\n2. Actor Run Details\n\nThank you for using Apollo Scraper!`;

        const html = error
            ? `
            <h2>❌ Apollo Scraper Failed</h2>
            <p>The Apollo scraper encountered an error:</p>
            <pre style="background: #f5f5f5; padding: 10px; border-radius: 5px;">${error}</pre>
            <p>Check the Apify platform for details.</p>
            `
            : `
            <h2>✅ Apollo Scraper Report</h2>
            <p>The Apollo scraper has completed successfully!</p>
            <div style="background: #e8f5e9; padding: 15px; border-radius: 5px; margin: 15px 0;">
                <h3 style="margin: 0; color: #2e7d32;">📊 Summary</h3>
                <p style="font-size: 18px; margin: 10px 0;">Total contacts scraped: <strong>${itemsCount}</strong></p>
            </div>
            <h3>📥 How to Access Your Data:</h3>
            <ol>
                <li>Login to Apify platform</li>
                <li>Go to your Actor's dashboard</li>
                <li>Find the latest run</li>
                <li>Click on "Storage" tab</li>
                <li>Download the Excel file from "Key-value store"</li>
            </ol>
            <p>Thank you for using Apollo Scraper!</p>
            `;

        // Email options
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: REPORT_EMAIL,
            subject: subject,
            text: text,
            html: html,
            attachments: !error ? [
                {
                    filename: OUTPUT_EXCEL_FILE,
                    content: fileBuffer,
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }
            ] : [],
        };

        // Send email
        const info = await transporter.sendMail(mailOptions);
        log.info(`📧 Email sent: ${info.messageId}`);
        
        // Verify connection
       
        
    } catch (error: any) {
        log.error('❌ Failed to send email:', error.message);
        // Don't throw - email failure shouldn't stop the whole process
    }
}

// =============================
// Simple Crawler - Just Login
// =============================
const crawler = new PlaywrightCrawler({
    // Use Apify's default launcher
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

    requestHandlerTimeoutSecs: 600,
    maxRequestsPerCrawl: 10, // For safety

    preNavigationHooks: [
        async ({ page }) => {
            // Anti-detection script - Fixed TypeScript issues
            await page.addInitScript(() => {
                // Override webdriver property
                Object.defineProperty(navigator, 'webdriver', { 
                    get: () => undefined 
                });
                
                // Type-safe Chrome property handling
                const w = window as any;
                if (w.chrome && typeof w.chrome === 'object') {
                    try {
                        // Remove runtime if it exists
                        if (w.chrome.runtime) {
                            delete w.chrome.runtime;
                        }
                    } catch (e) {
                        // Silently continue
                    }
                }
                
                // Override permissions - Fixed TypeScript issue
                const originalQuery = (window.navigator as any).permissions?.query;
                if (originalQuery) {
                    (window.navigator as any).permissions.query = (parameters: any) => {
                        if (parameters.name === 'notifications') {
                            return Promise.resolve({ 
                                state: Notification.permission,
                                // Add missing properties to satisfy type checker
                                name: parameters.name,
                                onchange: null,
                                addEventListener: () => {},
                                removeEventListener: () => {},
                                dispatchEvent: () => true
                            } as any);
                        }
                        return originalQuery(parameters);
                    };
                }

                // Override plugins
                Object.defineProperty(navigator, 'plugins', {
                    get: () => {
                        return {
                            length: 5,
                            item: () => ({}),
                            namedItem: () => ({}),
                            refresh: () => {},
                            [Symbol.iterator]: function* () {
                                for (let i = 0; i < 5; i++) {
                                    yield {};
                                }
                            }
                        } as any;
                    },
                });

                // Override languages
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en'],
                });
            });

            await page.setViewportSize({ width: 1920, height: 1080 });
            
            // Set User Agent using the correct method
            
await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
        get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
});
            
            // Set extra HTTP headers
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Referer': 'https://www.google.com/',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
            });
        },
    ],

    async requestHandler({ page, log }) {
        log.info('🔐 Logging in...');

        // Navigate to login page
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 60000 });
        await randomDelay(2000, 3000);

        // Handle SSO
        try {
            const emailBtn = await page.waitForSelector('button:has-text("Continue with Email"), button:has-text("Sign in using Email")', { timeout: 5000 }).catch(() => null);
            if (emailBtn) {
                await emailBtn.click();
                await randomDelay(1500, 2500);
            }
        } catch (e) { /* continue */ }
        
        // Fill form
        await page.waitForSelector('input[name="email"]', { timeout: 60000 });
        await page.fill('input[name="email"]', EMAIL);
        await randomDelay(200, 500);
        await page.fill('input[name="password"]', PASSWORD);
        await randomDelay(200, 500);
        
        const loginBtn = page.locator('button[type="submit"]:has-text("Log In")');
        await loginBtn.waitFor({ state: 'visible' });
        await loginBtn.click();
        await randomDelay(5000, 8000);

        // Handle challenges/modals
        await handlePreScrapeChecks(page, log); 
        log.info('✅ Login complete! Now ready to scrape.');

        // SCRAPE PAGES
        log.info(`📊 Starting to scrape ${MAX_PAGES_TO_SCRAPE} pages from page ${startPage}...`);
        
        const finalPage = startPage + MAX_PAGES_TO_SCRAPE;
        for (let pageNum = startPage; pageNum < finalPage; pageNum++) {
            try {
                log.info(`\n📄 === PAGE ${pageNum} ===`);
                
                const pageUrl = `${TARGET_PEOPLE_URL_BASE}&page=${pageNum}`;
                
                // Navigate to the specific target page
                await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                log.info(`Navigated to: ${pageUrl}`);
                
                // Wait for data table
                try {
                    await page.waitForSelector('div[role="row"][aria-rowindex="1"]', { timeout: 15000 });
                    log.info(`Data element found on page ${pageNum}.`);
                    await randomDelay(2000, 3000);
                } catch (e) {
                    log.warning(`⚠️ Timeout: Data rows failed to appear on page ${pageNum} after navigation (15s).`);
                }
                
                // Scrape the page
                await scrapeCurrentPage(page, log);
                
                // Save progress
                await KeyValueStore.setValue(PERSISTENCE_KEY, pageNum);
                log.info(`💾 Progress saved: page ${pageNum}`);
                
                // Random delay between pages
                await randomDelay(3000, 5000);
                
            } catch (error:any) {
                log.error(`❌ Fatal error on page ${pageNum}. Breaking loop.`, error);
                break;
            }
        }
        
        log.info('\n✅ Scraping sequence finished.');
    },

    maxRequestRetries: 2,
});

// === Main execution ===
async function runCrawler() {
    let fileBuffer: Buffer | null = null;
    let itemsCount = 0;
    let errorMessage = '';

    try {
        log.debug('🚀 Starting Apollo.io scraper...');
        
        await setupPersistence(console); 
        log.debug(`📊 Will scrape ${MAX_PAGES_TO_SCRAPE} pages starting from page ${startPage}`);

        await crawler.run([LOGIN_URL]);

        log.debug('\n✨ Crawl finished! Exporting to Excel...');
        const dataset = await Dataset.open();
        const data = await dataset.getData();
        const items = data.items;
        itemsCount = items.length;

        if (items.length > 0) {
            const workbook = new ExcelJS.Workbook(); 
            const worksheet = workbook.addWorksheet('Apollo Leads');

            const headers = Object.keys(items[0]);
            worksheet.columns = headers.map(header => ({
                header,
                key: header,
                width: 20
            }));

            items.forEach((item: any) => {
                worksheet.addRow(item);
            });

            worksheet.getRow(1).font = { bold: true };

            // Generate Excel buffer
            fileBuffer = fileBuffer = Buffer.from(await workbook.xlsx.writeBuffer());;
            
            // Save to Apify Key-value store
            await KeyValueStore.setValue(OUTPUT_EXCEL_FILE, fileBuffer);
            log.debug(`✅ Successfully exported ${items.length} leads to ${OUTPUT_EXCEL_FILE}`);

            // Save backup as JSON
            await KeyValueStore.setValue('apollo-data-backup.json', JSON.stringify(items, null, 2));
            log.debug(`📁 Backup saved as apollo-data-backup.json`);
            
            // Save summary to dataset
            await Dataset.pushData({ 
                message: 'Export complete', 
                itemsCount: items.length,
                excelFile: OUTPUT_EXCEL_FILE,
                backupFile: 'apollo-data-backup.json'
            });
        } else {
            log.debug('❌ No data scraped in this session.');
        }

    } catch (error:any) {
        errorMessage = error.message || 'Unknown error';
        log.error('❌ Fatal error during scraping:', error);
        
        // Save error info to storage
        await KeyValueStore.setValue('scraper-error', {
            error: errorMessage,
            timestamp: new Date().toISOString()
        });
    }

    // Send email report
    if (fileBuffer && itemsCount > 0) {
        await sendEmailReport(fileBuffer, itemsCount);
    } else if (errorMessage) {
        await sendEmailReport(Buffer.from(''), 0, errorMessage);
    } else {
        await sendEmailReport(Buffer.from(''), 0, 'No data scraped');
    }

    // If there was an error, exit with failure
    if (errorMessage) {
        process.exit(1);
    }
}

// Validate environment variables
if (!process.env.EMAIL_USER || !process.env.APOLLO_PASS) {
    throw new Error("Missing environment variables: EMAIL_USER or APOLLO_PASS");
}

// Optional: Validate email config if email is required
if (process.env.EMAIL_REQUIRED === 'true') {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        throw new Error("Email configuration required: SMTP_USER, SMTP_PASS, and EMAIL_TO must be set");
    }
}

runCrawler().catch(log.error);