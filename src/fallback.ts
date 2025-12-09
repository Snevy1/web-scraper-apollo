 import { SELECTORS } from "./selectors.js";

// Helper to revert to fallback if needed
export function useFallbackSelectors() {
  console.warn('⚠️ Using fallback selectors - mining may be needed');
  SELECTORS.current = { ...SELECTORS.fallback ,

    login: {
      emailInput: 'input[name="email"]',
      passwordInput: 'input[name="password"]',
      submitButton: 'button[type="submit"]:has-text("Log In")',
      emailLoginButton: 'button:has-text("Continue with Email"), button:has-text("Sign in using Email")',
    },

     postLogin: {
          mainApp: '#main-app',
        },
        modals: ['.zp-modal-mask', '[role="dialog"]'],
        table: {
      // Priority order – first match wins
      rowSelectors: [
        'div[role="row"][aria-rowindex]:not([aria-rowindex="0"])',  // Most reliable (excludes header)
        'div.zp_Uiy0R',                                              // Auto-updated by miner
        'div[role="row"]:not(:has([role="columnheader"]))',         // Fallback
      ],

      cell: 'div[role="cell"]',

      // === DYNAMICALLY MINED SELECTORS ===
      name: 'a[data-testid="contact-name-cell"] span.zp_CaeaN',
      jobTitle: 'span.zp_FEm_X',
      companyName: 'a.zp_REh41 span.zp_CaeaN',
      email: 'span.zp_CaeaN.zp_JTaUA',
      emailRequiresAccess: 'button:has-text("Access")',
      phoneRequestLink: 'a.zp_BCsLt:has-text("Request")',
      phoneVisible: 'span.zp_CaeaN',
      linkedIn: 'a[href*="linkedin.com/in"]',
      location: 'span.zp_FEm_X',
      employeeCount: 'span.zp_Vnh4L',
      nicheTags: 'span.zp_z4aAi',
    },
        navigation: {
      nextButton: 'button[aria-label="Next page"], button:has-text("Next")',
      pageInput: 'input[aria-label="Page number"]', 
    },
  };
} 