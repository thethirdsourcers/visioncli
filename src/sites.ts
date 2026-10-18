// Site guides: how to get around big web apps quickly, given to the assistant the first time the browser tools touch
// one (in a read or an element listing), so it doesn't have to learn each app's quirks by trial and error.

export interface SiteGuide { name: string; host: RegExp; guide: string }

export const SITE_GUIDES: SiteGuide[] = [
  {
    name: "NetSuite",
    host: /(^|\.)netsuite\.com$/i,
    guide: `NetSuite guide (VisionCLI):
- Fastest navigation is by URL on the account's own host (https://<account>.app.netsuite.com), with browser_open:
  - Global search: /app/common/search/ubersearchresults.nl?quicksearch=T&searchtype=Uber&frame=be&Uber_NAMEtype=KEYWORDSTARTSWITH&Uber_NAME=<text>.
    Search by a record's number or name (e.g. "293843"; a "CT:" style label shown in Recent Records isn't part of the name).
    Each result row has Edit | View links: use View unless the user asked to change something.
  - Any transaction by internal id: /app/accounting/transactions/transaction.nl?id=<id> (NetSuite redirects to its type).
  - Custom record: /app/common/custom/custrecordentry.nl?rectype=<type id>&id=<id>; its list: /app/common/custom/custrecordentrylist.nl?rectype=<type id>.
  - Standard lists: customers /app/common/entity/custjoblist.nl, suppliers/vendors /app/common/entity/vendorlist.nl,
    employees /app/common/entity/employeelist.nl, items /app/common/item/itemlist.nl, saved searches /app/common/search/savedsearchlist.nl,
    scripts /app/common/scripting/scriptlist.nl, script deployments /app/common/scripting/scriptrecordlist.nl.
  - New records: sales order /app/accounting/transactions/salesord.nl, invoice /app/accounting/transactions/custinvc.nl,
    customer /app/common/entity/custjob.nl. Adding &e=T to a record URL opens it in edit mode.
- The top menu (Activities, Transactions, Lists, Reports, Customization, Setup…) opens on hover: browser_hover a tab, then
  browser_elements shows its entries (hover a submenu the same way). The global search box (top) works with browser_type
  + submit: results open on Enter.
- Record pages in View mode read as LABEL (capitals) then value lines. The action buttons at the top (Edit, Back and the
  account's own buttons, e.g. "Send ASN", "Book to …") run real business actions: never click one the user didn't ask for.
  Subtabs (the groups below the main fields) are clickable and show more fields and line-item lists.
- Edit mode: dropdowns take browser_select (it types to search long lists); multi-line items are edited line by line
  (pick the line, change fields, then the line's OK/Add) before Save. Save, Submit and Delete change live business
  data: only when the user asked, and say what will be saved first. Leaving an edited page asks "leave this page?":
  avoid opening edit mode just to look.
- NetSuite's server is slow (often 1-4 s a page): the browser tools wait for each page; don't click twice.`,
  },
];

const shown = new Set<string>();

/** The guide for this page's site, once per site in this session (null if it has none or it was already given). */
export function guideFor(url: string | undefined): string | null {
  if (!url) return null;
  let host = "";
  try { host = new URL(url).host; } catch { return null; }
  const g = SITE_GUIDES.find((s) => s.host.test(host));
  if (!g || shown.has(g.name)) return null;
  shown.add(g.name);
  return g.guide;
}

/** For tests: forget which guides were given. */
export function resetGuides() { shown.clear(); }
