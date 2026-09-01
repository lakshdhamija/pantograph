/**
 * Fixture data for CORETELLER 7.2 -- a stand-in for a legacy core-banking
 * back-office app. Everything here is synthetic. The "SSN" and "PII" fields
 * exist specifically so the redaction layer has realistic-looking regulated
 * data to prove itself against.
 */

export type SubAccount = {
  readonly number: string;
  readonly type: string;
  readonly balance: number;
  readonly opened: string;
};

export type Member = {
  readonly id: string;
  readonly name: string;
  /** Synthetic. Never leaves the fixture in un-redacted form. */
  readonly ssn: string;
  readonly status: 'ACTIVE' | 'DORMANT' | 'CLOSED';
  readonly branch: string;
  readonly phone: string;
  readonly email: string;
  readonly accounts: readonly SubAccount[];
  /**
   * Behavioural markers that make specific IDs deterministically exercise the
   * exceptional states a production replay has to survive. Keyed off data
   * rather than URL flags so the recorded artifact stays byte-identical.
   */
  readonly behaviour?: 'restricted' | 'slow';
};

export const MEMBERS: readonly Member[] = [
  {
    id: '100234',
    name: 'DELACROIX, RENE M',
    ssn: '999-01-0234',
    status: 'ACTIVE',
    branch: 'BR-014 RIVERSIDE',
    phone: '(555) 010-0234',
    email: 'rene.delacroix@example.invalid',
    accounts: [
      { number: '100234-01', type: 'SHARE DRAFT (CHECKING)', balance: 2841.19, opened: '2016-03-11' },
      { number: '100234-02', type: 'REGULAR SHARE (SAVINGS)', balance: 18234.55, opened: '2016-03-11' },
      { number: '100234-07', type: 'MONEY MARKET', balance: 40100.0, opened: '2021-08-02' },
    ],
  },
  {
    id: '100987',
    name: 'OKONKWO, ADAEZE',
    ssn: '999-04-0987',
    status: 'ACTIVE',
    branch: 'BR-002 DOWNTOWN',
    phone: '(555) 010-0987',
    email: 'a.okonkwo@example.invalid',
    accounts: [
      { number: '100987-02', type: 'REGULAR SHARE (SAVINGS)', balance: 611.07, opened: '2019-11-20' },
    ],
  },
  {
    id: '500005',
    name: 'VANTERPOOL, HORACE',
    ssn: '999-07-5005',
    status: 'DORMANT',
    branch: 'BR-014 RIVERSIDE',
    phone: '(555) 010-5005',
    email: 'h.vanterpool@example.invalid',
    behaviour: 'slow',
    accounts: [
      { number: '500005-02', type: 'REGULAR SHARE (SAVINGS)', balance: 74.31, opened: '2004-01-30' },
    ],
  },
  {
    id: '700007',
    name: 'BOARD MEMBER ACCOUNT (RESTRICTED)',
    ssn: '999-09-7007',
    status: 'ACTIVE',
    branch: 'BR-001 CORPORATE',
    phone: '(555) 010-7007',
    email: 'restricted@example.invalid',
    behaviour: 'restricted',
    accounts: [
      { number: '700007-02', type: 'REGULAR SHARE (SAVINGS)', balance: 921002.44, opened: '1998-06-15' },
    ],
  },
];

export function findMember(id: string): Member | undefined {
  return MEMBERS.find((m) => m.id === id.trim());
}

/** Sub-account product codes offered by the "open sub-account" screen. */
export const PRODUCT_CODES: ReadonlyArray<{ code: string; label: string }> = [
  { code: '', label: '-- select --' },
  { code: 'S02', label: 'S02 REGULAR SHARE (SAVINGS)' },
  { code: 'S06', label: 'S06 VACATION CLUB' },
  { code: 'S09', label: 'S09 HOLIDAY CLUB' },
  { code: 'C51', label: 'C51 CERTIFICATE 12MO' },
];

/**
 * Two tenants running the *same vendor product*, configured differently.
 * This is the multi-tenant reuse case in miniature: same flow, drifted labels.
 */
export type TenantConfig = {
  readonly id: string;
  readonly prefix: string;
  readonly institution: string;
  readonly productVersion: string;
  readonly labels: {
    readonly memberId: string;
    readonly searchSubmit: string;
    readonly savingsRow: string;
    readonly openSubAccount: string;
  };
  /** Tenant B adds a mandatory field tenant A does not have. */
  readonly requiresBranchCode: boolean;
  readonly theme: string;
};

export const TENANTS: readonly TenantConfig[] = [
  {
    id: 'first-riverside-cu',
    prefix: '',
    institution: 'FIRST RIVERSIDE CREDIT UNION',
    productVersion: '7.2.114',
    labels: {
      memberId: 'Member Number',
      searchSubmit: 'Go',
      savingsRow: 'REGULAR SHARE (SAVINGS)',
      openSubAccount: 'Open Sub-Account',
    },
    requiresBranchCode: false,
    theme: '#1a3a5c',
  },
  {
    id: 'granite-state-bank',
    prefix: '/t/granite',
    institution: 'GRANITE STATE SAVINGS BANK',
    productVersion: '7.2.098',
    labels: {
      // Same product, re-labelled by the institution -- the exact drift that
      // breaks name-based locators across tenants.
      memberId: 'Account Holder ID',
      searchSubmit: 'Search',
      savingsRow: 'REGULAR SHARE (SAVINGS)',
      openSubAccount: 'New Sub-Account',
    },
    requiresBranchCode: true,
    theme: '#4a3550',
  },
];

export function tenantFor(pathname: string): TenantConfig {
  const withPrefix = TENANTS.filter((t) => t.prefix !== '')
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((t) => pathname === t.prefix || pathname.startsWith(t.prefix + '/'));
  return withPrefix ?? TENANTS[0]!;
}

export const OPERATOR_CREDENTIALS = { user: 'teller01', pass: 'demo-only-not-a-secret' };
