
import { PlaywrightCrawler, log } from 'crawlee';
//import { chromium } from 'playwright-extra';
//import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import { Project, SyntaxKind, PropertyAssignment } from 'ts-morph';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === CONFIGURATION ===
const EMAIL = process.env.EMAIL_USER ?? '';
const PASSWORD = process.env.APOLLO_PASS ?? '';
const LOGIN_URL = 'https://app.apollo.io/#/login?locale=en';
const TARGET_PEOPLE_URL =
    'https://app.apollo.io/#/people?sortAscending=false&sortByField=recommendations_score&contactLabelIds[]=6931d8f3d25a7e000db60102&prospectedByCurrentTeam[]=yes&recommendationConfigId=score';
const SELECTORS_FILE_PATH = path.join(__dirname, 'selectors.ts');

import { SELECTORS } from './selectors.js';

interface MinedSelectors {
    rowClass?: string | null;
    name?: string | null; 
    jobTitle?: string | null;
    companyName?: string | null;
    email?: string | null;
    emailRequiresAccess?: string | null;
    phoneRequestLink?: string | null;
    phoneVisible?: string | null;
    linkedIn?: string | null;
    location?: string | null;
    employeeCount?: string | null;
    nicheTags?: string | null;
}


//chromium.use(StealthPlugin());

// ===  MINING FUNCTIONS ===
async function findBestSelector(_page: any, _context: any, elementHandle: any): Promise<string | null> {
    try {
        return await elementHandle.evaluate((el: HTMLElement) => {
            // Function to generate a unique selector for an element
            const generateSelector = (element: HTMLElement): string | null => {
                // Priority 1: data-testid (most reliable)
                if (element.dataset.testid) {
                    return `${element.tagName.toLowerCase()}[data-testid="${element.dataset.testid}"]`;
                }

                // Priority 2: Unique ID
                if (element.id && !element.id.includes(':')) {
                    return `#${element.id}`;
                }

                // Priority 3: Unique class combination
                const classes = Array.from(element.classList);
                const zpClasses = classes.filter(c => c.startsWith('zp_') && c.length > 6);
                
                if (zpClasses.length > 0) {
                    // Use the most specific zp_ class
                    const primaryClass = zpClasses.sort((a, b) => b.length - a.length)[0];
                    const tag = element.tagName.toLowerCase();
                    
                    // Check if class is unique within parent
                    const siblings = Array.from(element.parentElement?.children || []);
                    const sameClassCount = siblings.filter(sib => 
                        sib !== element && sib.classList.contains(primaryClass)
                    ).length;
                    
                    if (sameClassCount === 0) {
                        return `${tag}.${primaryClass}`;
                    }
                    
                    // Add additional class for specificity
                    const secondaryClass = classes.find(c => c.startsWith('zp_') && c !== primaryClass);
                    if (secondaryClass) {
                        return `${tag}.${primaryClass}.${secondaryClass}`;
                    }
                }

                // Priority 4: Role attributes
                if (element.getAttribute('role')) {
                    const role = element.getAttribute('role');
                    const tag = element.tagName.toLowerCase();
                    const classes = Array.from(element.classList).filter(c => c.startsWith('zp_')).join('.');
                    if (classes) {
                        return `${tag}[role="${role}"].${classes}`;
                    }
                }

                return null;
            };

            // Try to generate selector for the element
            let currentEl: HTMLElement | null = el;
            let selector: string | null = null;
            
            // Try current element and up to 3 parents
            for (let i = 0; i < 3 && currentEl; i++) {
                selector = generateSelector(currentEl);
                if (selector) break;
                currentEl = currentEl.parentElement;
            }

            return selector;
        });
    } catch (error) {
        return null;
    }
}

async function mineCellSelector(page: any, cell: any, context: any, log: any): Promise<string | null> {
    try {
        // Get all clickable/interactive elements in the cell
        const elements = await cell.$$('a, button, span.zp_CaeaN, [data-testid]');
        
        for (const element of elements) {
            const isVisible = await element.isVisible();
            if (!isVisible) continue;
            
            const selector = await findBestSelector(page, context, element);
            if (selector) {
                // Validate the selector works
                const testLocator = page.locator(selector);
                const count = await testLocator.count();
                if (count > 0) {
                    return selector;
                }
            }
        }
        
        return null;
    } catch (error) {
        log.debug(`Failed to mine cell selector: ${error}`);
        return null;
    }
}

async function mineSelectors(page: any, log: any): Promise<MinedSelectors> {
    log.info('🔍 Mining selectors from current table...');
    
    const mined: MinedSelectors = {};
    
    // Wait for table to load
    await page.waitForSelector('div[role="row"][aria-rowindex="1"]', { timeout: 60000 });
    
    // Find data rows using the same logic as the scraper
    let rowLocator = null;
    for (const rowSelector of SELECTORS.table.rowSelectors) {
        const rows = page.locator(rowSelector);
        const count = await rows.count();
        if (count > 0) {
            rowLocator = rows.first();
            log.info(`✓ Using row selector: ${rowSelector} (${count} rows found)`);
            break;
        }
    }
    
    if (!rowLocator) {
        log.error('❌ No data rows found');
        return mined;
    }
    
    // Wait for row to be stable
    await rowLocator.waitFor({ state: 'visible', timeout: 10000 });
    
    // Mine row class from the actual row element
    try {
        const rowClass = await rowLocator.evaluate((el: HTMLElement) => {
            const classes = Array.from(el.classList);
            return classes.find(c => c.startsWith('zp_') && c.length > 10) || null;
        });
        
        if (rowClass) {
            mined.rowClass = `div.${rowClass}`;
            log.info(`✓ Mined row class: ${mined.rowClass}`);
        }
    } catch (error) {
        log.warning('Could not mine row class');
    }
    
    // Get cells from the row
    const cells = await rowLocator.locator('[role="cell"]').all();
    log.info(`Found ${cells.length} cells in row`);
    
    if (cells.length < 10) {
        log.warning(`Insufficient cells (${cells.length}), expected at least 10`);
        return mined;
    }
    
    // Map cells to data types based on typical Apollo.io layout
    const cellMapping = [
        { index: 1, type: 'name' },
        { index: 2, type: 'jobTitle' },
        { index: 3, type: 'companyName' },
        { index: 4, type: 'email' },
        { index: 5, type: 'phoneRequestLink' },
        { index: 7, type: 'linkedIn' },
        { index: 9, type: 'location' },
        { index: 10, type: 'employeeCount' },
        { index: 12, type: 'nicheTags' },
    ];
    
    // Mine each cell
    for (const mapping of cellMapping) {
        const cellIndex = mapping.index;
        const cellType = mapping.type;
        
        if (cellIndex < cells.length) {
            try {
                const cell = cells[cellIndex];
                
                // Special handling for specific cell types
                let selector: string | null = null;
                
                switch (cellType) {
                    case 'name':
                        // Look for name anchor
                        const nameAnchor = await cell.$('a[href*="/contacts/"]');
                        if (nameAnchor) {
                            selector = await findBestSelector(page, 'name', nameAnchor);
                            if (selector) {
                                // Find the span inside for text
                                const innerSpan = await nameAnchor.$('span');
                                if (innerSpan) {
                                    const spanSelector = await findBestSelector(page, 'name-span', innerSpan);
                                    if (spanSelector) {
                                        selector = `${selector} ${spanSelector}`;
                                    }
                                }
                            }
                        }
                        break;
                        
                    case 'linkedIn':
                        // Direct selector for LinkedIn links
                        const linkedInLink = await cell.$('a[href*="linkedin.com/in"]');
                        if (linkedInLink) {
                            selector = 'a[href*="linkedin.com/in"]';
                        }
                        break;
                        
                    case 'email':
                        // Check for email span
                        const emailSpan = await cell.$('span.zp_CaeaN.zp_JTaUA');
                        if (emailSpan) {
                            selector = await findBestSelector(page, 'email', emailSpan);
                        }
                        // Also check for access button
                        const accessBtn = await cell.$('button:has-text("Access")');
                        if (accessBtn) {
                            mined.emailRequiresAccess = 'button:has-text("Access")';
                        }
                        break;
                        
                    case 'phoneRequestLink':
                        // Check for request link
                        const requestLink = await cell.$('a:has-text("Request")');
                        if (requestLink) {
                            selector = await findBestSelector(page, 'phone-request', requestLink);
                        } else {
                            // Check for visible phone
                            const phoneSpan = await cell.$('span.zp_CaeaN');
                            if (phoneSpan) {
                                const text = await phoneSpan.textContent();
                                if (text && text.match(/\+\d+/)) {
                                    selector = await findBestSelector(page, 'phone', phoneSpan);
                                    mined.phoneVisible = selector;
                                }
                            }
                        }
                        break;
                        
                    default:
                        // Generic mining for other cells
                        selector = await mineCellSelector(page, cell, cellType, log);
                        break;
                }
                
                if (selector) {
                    mined[cellType as keyof MinedSelectors] = selector;
                    log.info(`✓ Mined ${cellType}: ${selector}`);
                }
                
            } catch (error) {
                log.debug(`Failed to mine ${cellType}: ${error}`);
            }
        }
    }
    
    return mined;
}

// === VALIDATE MINED SELECTORS ===
async function validateSelectors(page: any, mined: MinedSelectors, log: any): Promise<boolean> {
    log.info('🔬 Validating mined selectors...');
    
    let validCount = 0;
    const totalCount = Object.keys(mined).length;
    
    for (const [key, selector] of Object.entries(mined)) {
        if (!selector || key === 'rowClass') continue;
        
        try {
            const locator = page.locator(selector);
            const count = await locator.count();
            const isVisible = count > 0 ? await locator.first().isVisible() : false;
            
            if (count > 0 && isVisible) {
                log.info(`✓ ${key}: Valid (found ${count} elements)`);
                validCount++;
            } else {
                log.warning(`⚠️ ${key}: Invalid (not found or not visible)`);
            }
        } catch (error) {
            log.warning(`⚠️ ${key}: Error validating: ${error}`);
        }
    }
    
    const validityRate = validCount / (totalCount - 1); // Exclude rowClass from count
    log.info(`Validation: ${validCount}/${totalCount - 1} selectors valid (${Math.round(validityRate * 100)}%)`);
    
    return validityRate >= 0.7; // Require at least 70% valid selectors
}

// === UPDATE SELECTORS.TS WITH BACKUP ===
async function updateSelectors(mined: MinedSelectors, log: any, page:any) {
    log.info('📝 Updating selectors.ts with backup...');
    
    // Create backup first
    const backupPath = SELECTORS_FILE_PATH + '.backup';
    if (fs.existsSync(SELECTORS_FILE_PATH)) {
        fs.copyFileSync(SELECTORS_FILE_PATH, backupPath);
        log.info(`Created backup at ${backupPath}`);
    }
    
    const project = new Project();
    const file = project.addSourceFileAtPath(SELECTORS_FILE_PATH);

    const decl = file.getVariableDeclarationOrThrow('SELECTORS');
    const obj = decl.getInitializerIfKindOrThrow(SyntaxKind.ObjectLiteralExpression);
    const tableProp = obj.getPropertyOrThrow('table') as PropertyAssignment;
    const tableObj = tableProp.getInitializerIfKindOrThrow(SyntaxKind.ObjectLiteralExpression);

    let changed = 0;
    const changes: string[] = [];

    // Update rowSelectors if we have a new row class
    if (mined.rowClass) {
        const rowSelProp = tableObj.getProperty('rowSelectors') as PropertyAssignment;
        if (rowSelProp) {
            const arr = rowSelProp.getInitializerIfKindOrThrow(SyntaxKind.ArrayLiteralExpression);
            const elements = arr.getElements();
            
            if (elements.length > 1) {
                const secondElement = elements[1];
                const oldValue = secondElement.getText().replace(/['"]/g, '');
                
                if (oldValue !== mined.rowClass) {
                    // Keep old value as fallback
                    const fallbackSelector = `div.zp_Uiy0R`; // Original fallback
                    if (elements.length < 3) {
                        arr.addElement(`'${fallbackSelector}'`);
                    }
                    secondElement.replaceWithText(`'${mined.rowClass}'`);
                    changes.push(`rowSelectors[1]: "${oldValue}" → "${mined.rowClass}"`);
                    changed++;
                }
            }
        }
    }

    // Update other selectors
    for (const [key, value] of Object.entries(mined)) {
        if (key === 'rowClass' || !value) continue;
        
        const prop = tableObj.getProperty(key) as PropertyAssignment | undefined;
        if (prop) {
            const oldValue = prop.getInitializer()?.getText().replace(/['"]/g, '') || '';
            if (oldValue !== value) {
                prop.setInitializer(`'${value}'`);
                changes.push(`table.${key}: "${oldValue}" → "${value}"`);
                changed++;
            }
        } else {
            // Add as new property with comment
            tableObj.addPropertyAssignment({ 
                name: key, 
                initializer: `'${value}'` 
            });
            changes.push(`Added table.${key}: "${value}"`);
            changed++;
        }
    }

    if (changed > 0) {
        // Add timestamp comment
        const timestamp = new Date().toISOString();
        file.insertText(0, `// Last auto-updated: ${timestamp}\n// ${changes.join('\n// ')}\n\n`);
        
        await file.save();
        log.info(`\n✅ Updated ${changed} selector(s):`);
        changes.forEach(change => log.info(`  ${change}`));
        
        // Test the updated selectors
        log.info('\n🧪 Testing updated selectors...');
        await testUpdatedSelectors(page, log);
    } else {
        log.info('\n✅ No changes needed - all selectors are current');
    }
}

async function testUpdatedSelectors(page: any, log: any) {
    // Import the updated selectors
    delete require.cache[require.resolve(SELECTORS_FILE_PATH)];
    const { SELECTORS: updatedSelectors } = await import(SELECTORS_FILE_PATH + '?t=' + Date.now());
    
    // Test each selector
    const T = updatedSelectors.table;
    const rowResult = await page.locator(T.rowSelectors[0]).count();
    log.info(`Rows found with updated selector: ${rowResult}`);
    
    if (rowResult > 0) {
        const firstRow = page.locator(T.rowSelectors[0]).first();
        const cells = await firstRow.locator(T.cell).count();
        log.info(`Cells in first row: ${cells}`);
    }
}

// ===  LOGIN HANDLER ===
async function handleLogin(page: any, log: any) {
    log.info('🔐 Logging in...');
    
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 120000 });
    
    // Handle any challenges
    await page.waitForSelector('input[name="email"], input[type="email"]', { 
        state: 'visible', 
        timeout: 60000 
    });
    
    await page.fill('input[name="email"]', EMAIL);
    await page.waitForTimeout(1000);
    await page.fill('input[name="password"]', PASSWORD);
    await page.waitForTimeout(1000);
    
    await page.click('button[type="submit"]:has-text("Log In")');
    
    // Wait for login to complete
    await page.waitForSelector(SELECTORS.postLogin.mainApp, { timeout: 60000 });
    log.info('✅ Login successful');
}

// === MAIN ===
async function main() {
    log.info('🚀 Starting Apollo.io Selector Miner...\n');
    
    if (!EMAIL || !PASSWORD) {
        log.error('❌ Set EMAIL_USER and APOLLO_PASS in .env');
        process.exit(1);
    }
    
    const crawler = new PlaywrightCrawler({
       /*  launchContext: {
            launcher: chromium,
            launchOptions: {
                headless: false, // Can be false for debugging
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
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
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 300,
        
        async requestHandler({ page, log }) {
            try {
                // Login
                await handleLogin(page, log);
                
                // Navigate to target page
                log.info('📍 Navigating to people page...');
                await page.goto(TARGET_PEOPLE_URL, { 
                    waitUntil: 'domcontentloaded', 
                    timeout: 60000 
                });
                
                // Wait for data
                await page.waitForSelector(SELECTORS.postLogin.mainApp, { timeout: 30000 });
                await page.waitForTimeout(5000);
                
                // Mine selectors
                const mined = await mineSelectors(page, log);
                
                if (Object.keys(mined).length > 3) { // Need at least a few selectors
                    // Validate before updating
                    const isValid = await validateSelectors(page, mined, log);
                    
                    if (isValid) {
                        await updateSelectors(mined, log,page);
                        log.info('\n🎉 Selector mining and update complete!');
                    } else {
                        log.warning('\n⚠️ Mined selectors failed validation, not updating');
                    }
                } else {
                    log.warning('⚠️ Not enough selectors mined, skipping update');
                }
                
            } catch (error:any) {
                log.error('❌ Mining failed:', error);
                throw error;
            }
        },
    });
    
    await crawler.run([LOGIN_URL]);
}

// === RUN ===
main().catch(err => {
    log.error('💥 Fatal error:', err);
    process.exit(1);
});