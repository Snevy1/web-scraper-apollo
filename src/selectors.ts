// selectors.ts - With versioning and fallback support

// A selector can be a single string or an array of strings
export type Selector = string | string[];

export interface TableSelectors {
  rowSelectors: string[];
  cell: Selector;
  name: Selector;
  jobTitle: Selector;
  companyName: Selector;
  email: Selector;
  emailRequiresAccess: Selector;
  phoneRequestLink: Selector;
  phoneVisible: Selector;
  linkedIn: Selector;
  location: Selector;
  employeeCount: Selector;
  nicheTags: Selector;
}

export interface FallbackTableSelectors {
  rowSelectors: string[];
  cell: Selector;
  name: Selector;
  email: Selector;
  phone: Selector;
  location: Selector;
  company: Selector;
}

export const SELECTORS = {
  current: {
    login: {
      emailInput: ['input[name="email"]'] as Selector,
      passwordInput: ['input[name="password"]'] as Selector,
      submitButton: [
        'button[type="submit"]:has-text("Log In")',
        'button:has-text("Continue with Email")',
        'button:has-text("Sign in using Email")',
      ] as Selector,
    },

    postLogin: {
      mainApp: ['#main-app'] as Selector,
    },

    modals: ['.zp-modal-mask', '[role="dialog"]'] as Selector,

    table: {
      rowSelectors: [
        'div[role="row"][aria-rowindex]:not([aria-rowindex="0"])',
        'div.zp_Uiy0R',
        'div[role="row"]:not(:has([role="columnheader"]))',
      ],
      cell: ['div[role="cell"]'],

      name: [
        'div[data-testid="contact-name-cell"] a',
        'a[href*="/people/"]',
        'a[href*="/contacts/"]',
      ],
      jobTitle: ['span.zp_FEm_X', 'span:has-text("Manager")'],
      companyName: [
        'a[href*="/organizations/"] span',
        'div[data-testid="company-name-cell"] span',
      ],
      email: [
        'span:has-text("@")',
        'div[role="gridcell"][aria-colindex="4"] button:has-text("Access email")',
      ],
      emailRequiresAccess: [
        'button[data-tour-id="email-cell-verified"]',
        'button:has-text("Access email")',
      ],
      phoneRequestLink: [
        'div[role="gridcell"][aria-colindex="5"] button:has-text("Access Mobile")',
        'a:has-text("Request")',
      ],
      phoneVisible: [
        'div[role="gridcell"][aria-colindex="5"] i.apollo-icon-phone-download',
        'span:has-text("+")',
      ],
      linkedIn: ['a[href*="linkedin.com/in"]'],
      location: [
        'div.zp_lvURj div.zp_BsIHj',
        'div[role="gridcell"][aria-colindex="9"]',
      ],
      employeeCount: ['span.zp_Vnh4L'],
      nicheTags: ['span.zp_z4aAi'],
    } as TableSelectors,

    navigation: {
      nextButton: [
        'button[aria-label="Next page"]',
        'button:has-text("Next")',
      ] as Selector,
      pageInput: ['input[aria-label="Page number"]'] as Selector,
    },
  },

  fallback: {
    login: {
      emailInput: ['input[name="email"]'] as Selector,
      passwordInput: ['input[name="password"]'] as Selector,
      submitButton: ['button[type="submit"]'] as Selector,
    },

    table: {
      rowSelectors: ['div[role="row"]'],
      cell: ['[role="cell"]'],
      name: ['a[href*="/contacts/"]'],
      email: ['span:has-text("@")'],
      phone: ['a:has-text("Request")', 'span:has-text("+")'],
      location: ['div:has-text("Location")'],
      company: ['span:has-text("Inc")'],
    } as FallbackTableSelectors,
  },

  // For compatibility with existing code
  get login() {
    return this.current.login;
  },
  get postLogin() {
    return this.current.postLogin;
  },
  get modals() {
    return this.current.modals;
  },
  get table() {
    return this.current.table;
  },
  get navigation() {
    return this.current.navigation;
  },
};