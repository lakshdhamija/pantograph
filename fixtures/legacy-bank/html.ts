/**
 * Hand-rolled server-rendered markup for the CORETELLER fixture.
 *
 * Deliberate hostility, mirroring what real back-office banking apps look like:
 *   - a real <frameset> (nav frame + content frame)
 *   - table-based layout, no CSS grid/flex, no semantic landmarks
 *   - NO data-testid anywhere
 *   - form controls named f_1 / f_mbr / f_prod, and MOST of them have no
 *     <label for=...>, so they have no accessible name at all -- the only way
 *     to identify them is positionally, relative to a neighbouring text cell
 *   - a couple of controls DO have proper labels, because real apps are
 *     inconsistent and a good locator strategy should prefer the cheap path
 *     when it exists
 */

import { PRODUCT_CODES, type Member, type TenantConfig } from './data.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = (n: number): string => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function chrome(t: TenantConfig, title: string, body: string): string {
  return `<html><head><title>${esc(title)}</title>
<style>
body{font-family:Verdana,Geneva,sans-serif;font-size:11px;margin:0;background:#e8e8e8;color:#111}
table{border-collapse:collapse}
td{padding:3px 6px;font-size:11px;vertical-align:top}
.hdr{background:${t.theme};color:#fff;padding:6px 8px;font-weight:bold;font-size:12px}
.panel{background:#fff;border:1px solid #999;margin:8px}
.sect{background:#c9d4de;font-weight:bold;padding:3px 6px;border-bottom:1px solid #999}
.err{background:#ffe8e8;border:1px solid #b00;color:#900;padding:6px;margin:8px;font-weight:bold}
.note{background:#fffbe6;border:1px solid #c9a900;padding:6px;margin:8px}
input,select{font-family:Verdana;font-size:11px;border:1px solid #666}
input[type=submit]{background:#d4d0c8;padding:1px 10px;cursor:pointer}
a{color:#0033aa}
.r{text-align:right}
</style></head><body>
<div class="hdr">${esc(t.institution)} &nbsp;&middot;&nbsp; CORETELLER ${esc(t.productVersion)}</div>
${body}
</body></html>`;
}

export function loginPage(t: TenantConfig, message?: string): string {
  // The login form is the one screen with proper labels -- password managers
  // forced vendors to fix it. Everything downstream stayed legacy.
  return chrome(
    t,
    'CORETELLER Sign On',
    `${message ? `<div class="err">${esc(message)}</div>` : ''}
<div class="panel"><div class="sect">Operator Sign On</div>
<form method="POST" action="${t.prefix}/login">
<table>
<tr><td><label for="u">Operator ID</label></td><td><input id="u" name="f_user" size="18"></td></tr>
<tr><td><label for="p">Password</label></td><td><input id="p" name="f_pass" type="password" size="18"></td></tr>
<tr><td colspan="2"><input type="submit" value="Sign On"></td></tr>
</table>
</form>
<table><tr><td>Demo credentials are printed in fixtures/legacy-bank/data.ts.</td></tr></table>
</div>`,
  );
}

/** A real frameset. Legacy enterprise apps are full of them. */
export function desk(t: TenantConfig): string {
  return `<html><head><title>CORETELLER Desktop</title></head>
<frameset cols="172,*" border="1" frameborder="1">
  <frame src="${t.prefix}/nav" name="nav" scrolling="no">
  <frame src="${t.prefix}/content?screen=home" name="content">
</frameset></html>`;
}

export function navFrame(t: TenantConfig): string {
  const item = (screen: string, label: string) =>
    `<tr><td>&raquo; <a href="${t.prefix}/content?screen=${screen}" target="content">${esc(label)}</a></td></tr>`;
  return chrome(
    t,
    'Navigation',
    `<table width="100%">
<tr><td class="sect">Menu</td></tr>
${item('home', 'Home')}
${item('mbrsearch', 'Member Inquiry')}
${item('reports', 'Reports')}
<tr><td>&raquo; <a href="${t.prefix}/logout" target="_top">Sign Off</a></td></tr>
</table>`,
  );
}

export function homeScreen(t: TenantConfig): string {
  return chrome(
    t,
    'Home',
    `<div class="panel"><div class="sect">Teller Desktop</div>
<table><tr><td>Select a function from the menu.</td></tr>
<tr><td>Institution: ${esc(t.institution)}</td></tr></table></div>`,
  );
}

export function searchScreen(t: TenantConfig, opts: { error?: string } = {}): string {
  // Note: f_mbr has NO label association. Its accessible name is "".
  // The only stable way to target it is "textbox in the row whose first cell
  // reads <memberId label>". This is the hostile case the resolver must cover.
  return chrome(
    t,
    'Member Inquiry',
    `${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ''}
<div class="panel"><div class="sect">Member Inquiry</div>
<form method="POST" action="${t.prefix}/content?screen=mbrsearch">
<table>
<tr><td width="120">${esc(t.labels.memberId)}</td><td><input name="f_mbr" size="12" maxlength="9"></td></tr>
<tr><td>Surname</td><td><input name="f_surname" size="20"></td></tr>
<tr><td colspan="2"><input type="submit" value="${esc(t.labels.searchSubmit)}">&nbsp;<input type="reset" value="Clear"></td></tr>
</table>
</form></div>`,
  );
}

export function searchResults(t: TenantConfig, m: Member): string {
  return chrome(
    t,
    'Inquiry Results',
    `<div class="panel"><div class="sect">Inquiry Results &mdash; 1 record</div>
<table border="1" width="100%">
<tr><td class="sect">Member</td><td class="sect">Name</td><td class="sect">Status</td><td class="sect">Branch</td></tr>
<tr><td><a href="${t.prefix}/content?screen=mbrdetail&amp;id=${esc(m.id)}">${esc(m.id)}</a></td>
<td>${esc(m.name)}</td><td>${esc(m.status)}</td><td>${esc(m.branch)}</td></tr>
</table></div>`,
  );
}

export function noRecords(t: TenantConfig, queried: string): string {
  return chrome(
    t,
    'Inquiry Results',
    `<div class="panel"><div class="sect">Inquiry Results</div>
<table><tr><td><b>NO MATCHING RECORDS FOUND</b></td></tr>
<tr><td>No member exists for ${esc(t.labels.memberId)} ${esc(queried)}.</td></tr>
<tr><td><a href="${t.prefix}/content?screen=mbrsearch">Return to inquiry</a></td></tr></table></div>`,
  );
}

export function permissionDenied(t: TenantConfig): string {
  return chrome(
    t,
    'Not Authorized',
    `<div class="panel"><div class="sect">Security</div>
<div class="err">SEC-4031: You are not authorized to view this member record.</div>
<table><tr><td>This record is restricted. Contact your security administrator.</td></tr>
<tr><td><a href="${t.prefix}/content?screen=mbrsearch">Return to inquiry</a></td></tr></table></div>`,
  );
}

export function memberDetail(t: TenantConfig, m: Member): string {
  // Balances live in an unlabelled table. Extracting "the savings balance"
  // means: find the row containing the product name, take the cell to its right.
  const rows = m.accounts
    .map(
      (a) =>
        `<tr><td>${esc(a.number)}</td><td>${esc(a.type)}</td><td class="r">${money(a.balance)}</td><td>${esc(a.opened)}</td></tr>`,
    )
    .join('\n');
  return chrome(
    t,
    'Member Detail',
    `<div class="panel"><div class="sect">Member Detail &mdash; ${esc(m.id)}</div>
<table>
<tr><td width="110">Name</td><td><b>${esc(m.name)}</b></td><td width="90">Status</td><td><b>${esc(m.status)}</b></td></tr>
<tr><td>Tax ID</td><td>${esc(m.ssn)}</td><td>Branch</td><td>${esc(m.branch)}</td></tr>
<tr><td>Telephone</td><td>${esc(m.phone)}</td><td>E-Mail</td><td>${esc(m.email)}</td></tr>
</table>
<div class="sect">Share / Deposit Accounts</div>
<table border="1" width="100%">
<tr><td class="sect">Account</td><td class="sect">Product</td><td class="sect r">Current Balance</td><td class="sect">Opened</td></tr>
${rows}
</table>
<table><tr><td>
<a href="${t.prefix}/content?screen=subacct&amp;id=${esc(m.id)}">${esc(t.labels.openSubAccount)}</a>
&nbsp;|&nbsp;<a href="${t.prefix}/content?screen=mbrsearch">New Inquiry</a>
</td></tr></table>
</div>`,
  );
}

export function subAccountForm(
  t: TenantConfig,
  m: Member,
  opts: { errors?: readonly string[]; values?: Record<string, string> } = {},
): string {
  const v = (k: string) => esc(opts.values?.[k] ?? '');
  const products = PRODUCT_CODES.map(
    (p) => `<option value="${esc(p.code)}"${opts.values?.['f_prod'] === p.code ? ' selected' : ''}>${esc(p.label)}</option>`,
  ).join('');
  const branchRow = t.requiresBranchCode
    ? `<tr><td>Branch Code</td><td><input name="f_branch" size="8" value="${v('f_branch')}"> (required)</td></tr>`
    : '';
  return chrome(
    t,
    t.labels.openSubAccount,
    `${
      opts.errors?.length
        ? `<div class="err">The request could not be completed:<ul>${opts.errors
            .map((e) => `<li>${esc(e)}</li>`)
            .join('')}</ul></div>`
        : ''
    }
<div class="panel"><div class="sect">${esc(t.labels.openSubAccount)} &mdash; Member ${esc(m.id)}</div>
<form method="POST" action="${t.prefix}/content?screen=subacct&amp;id=${esc(m.id)}"
      onsubmit="return confirm('This will create a new sub-account for member ${esc(m.id)}. Continue?');">
<table>
<tr><td width="130">Member</td><td>${esc(m.id)} &mdash; ${esc(m.name)}</td></tr>
<tr><td>Tax ID</td><td>${esc(m.ssn)}</td></tr>
<tr><td><label for="prod">Product Code</label></td><td><select id="prod" name="f_prod">${products}</select></td></tr>
<tr><td>Nickname</td><td><input name="f_nick" size="24" maxlength="20" value="${v('f_nick')}"></td></tr>
<tr><td>Opening Deposit</td><td><input name="f_amt" size="12" value="${v('f_amt')}"> USD</td></tr>
${branchRow}
<tr><td colspan="2"><input type="submit" value="Submit Request">&nbsp;
<a href="${t.prefix}/content?screen=mbrdetail&amp;id=${esc(m.id)}">Cancel</a></td></tr>
</table>
</form></div>`,
  );
}

export function subAccountConfirmed(
  t: TenantConfig,
  m: Member,
  ref: string,
  acct: string,
  product: string,
): string {
  return chrome(
    t,
    'Request Confirmed',
    `<div class="panel"><div class="sect">Request Confirmed</div>
<table>
<tr><td width="150">Confirmation Reference</td><td><b>${esc(ref)}</b></td></tr>
<tr><td>New Account Number</td><td><b>${esc(acct)}</b></td></tr>
<tr><td>Product</td><td>${esc(product)}</td></tr>
<tr><td>Member</td><td>${esc(m.id)} &mdash; ${esc(m.name)}</td></tr>
<tr><td>Posted</td><td>PENDING NIGHTLY BATCH</td></tr>
</table>
<table><tr><td><a href="${t.prefix}/content?screen=mbrdetail&amp;id=${esc(m.id)}">Back to member</a></td></tr></table>
</div>`,
  );
}

/** Recoverable interstitial: dismiss it and carry on. */
export function maintenanceNotice(t: TenantConfig, nextUrl: string): string {
  return chrome(
    t,
    'System Notice',
    `<div class="panel"><div class="sect">System Notice</div>
<div class="note">Scheduled maintenance is planned for Sunday 02:00-04:00 ET.
Batch posting may be delayed.</div>
<form method="GET" action="${t.prefix}/content">
${nextUrlHidden(nextUrl)}
<table><tr><td><input type="submit" value="Continue"></td></tr></table>
</form></div>`,
  );
}

function nextUrlHidden(nextUrl: string): string {
  const q = new URL(nextUrl, 'http://x').searchParams;
  return [...q.entries()].map(([k, val]) => `<input type="hidden" name="${esc(k)}" value="${esc(val)}">`).join('');
}

/** Hard failure: the app itself broke. */
export function appError(t: TenantConfig, ref: string): string {
  return chrome(
    t,
    'System Error',
    `<div class="panel"><div class="sect">Unexpected System Error</div>
<div class="err">CT-500: An unexpected error occurred while processing your request.</div>
<table>
<tr><td>Reference</td><td>${esc(ref)}</td></tr>
<tr><td>Detail</td><td>ORA-01722: invalid number</td></tr>
<tr><td>Action</td><td>Contact the service desk. Do not retry this transaction.</td></tr>
</table></div>`,
  );
}

export { esc, money };
