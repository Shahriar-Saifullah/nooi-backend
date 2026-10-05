/**
 * Seed vendor applications — scripts/seed-vendor-applications.ts
 * ============================================================================
 * DEV ONLY. Creates vendor accounts so the admin approval queue has something
 * to review.
 *
 * Why a script rather than SQL: vendor_profiles.id references profiles(id),
 * which references auth.users(id). Supabase manages auth.users, and inserting
 * into it directly is fragile — password hashing, identity rows, confirmation
 * state. The Admin API does it properly.
 *
 * The data is built to exercise the states the approval screen actually has,
 * not to look plausible:
 *
 *   Ageing          submitted today through eleven days ago, so the "waiting"
 *                   column and the oldest-first sort have a spread to show.
 *   CR collision    two vendors share CR 1010203040. The screen should warn
 *                   rather than block — a second outlet legitimately shares a
 *                   registration, which is exactly why it's a human decision.
 *   Missing docs    one application with no documents at all, one with a
 *                   partial set. "Not provided" is a state the approver needs
 *                   to see, not an edge case.
 *   Already decided one approved and one rejected, so the Done tab and the
 *                   decision-audit fields aren't empty.
 *
 * Usage:
 *   npx ts-node scripts/seed-vendor-applications.ts
 *   npx ts-node scripts/seed-vendor-applications.ts --upload-docs
 *   npx ts-node scripts/seed-vendor-applications.ts --clean
 *
 * --upload-docs puts a placeholder PDF at every recorded document path, so the
 * admin screen's View button has something to open. Without it the records
 * exist and the files do not, which is a real state (a vendor row created
 * before uploads were wired up) but not a useful one to develop against.
 *
 * Every account uses the .test TLD, which is reserved and undeliverable by
 * design — these can never accidentally email a real person, and --clean finds
 * them by that suffix.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const EMAIL_SUFFIX = '@seed.nooi.test';
const SEED_PASSWORD = 'seed-only-not-a-real-account';

interface SeedVendor {
  slug: string;
  contact: string;
  business_name: string;
  store_name: string;
  category: string;
  city: string;
  country: string;
  phone: string;
  cr_number: string | null;
  vat_number: string | null;
  fulfillment_type: string;
  description: string;
  /** Days ago the application was submitted. Drives the waiting column. */
  daysAgo: number;
  status: 'pending' | 'approved' | 'rejected';
  rejection_reason?: string;
  documents: { kind: string; label: string }[];
}

const DOCS_FULL = [
  { kind: 'trade_licence', label: 'Trade licence' },
  { kind: 'vat_certificate', label: 'VAT certificate' },
  { kind: 'bank_letter', label: 'Bank letter' },
];

const VENDORS: SeedVendor[] = [
  {
    slug: 'atlas-woodworks',
    contact: 'Rania Haddad',
    business_name: 'Atlas Woodworks LLC',
    store_name: 'Atlas Woodworks',
    category: 'Furniture',
    city: 'Dubai',
    country: 'United Arab Emirates',
    phone: '+971 4 555 0101',
    cr_number: '1010203040',
    vat_number: '100123456700003',
    fulfillment_type: 'factory',
    description: 'Solid oak and walnut furniture, made to order in Al Quoz.',
    daysAgo: 11,
    status: 'pending',
    documents: DOCS_FULL,
  },
  {
    // Shares a CR with Atlas. The screen should warn, not block — this is the
    // case where an approver has to pick up the phone.
    slug: 'atlas-outlet-jeddah',
    contact: 'Rania Haddad',
    business_name: 'Atlas Outlet Jeddah',
    store_name: 'Atlas Jeddah',
    category: 'Furniture',
    city: 'Jeddah',
    country: 'Saudi Arabia',
    phone: '+966 12 555 0199',
    cr_number: '1010203040',
    vat_number: '310987654300003',
    fulfillment_type: 'warehouse',
    description: 'Second outlet of Atlas Woodworks serving the Saudi market.',
    daysAgo: 4,
    status: 'pending',
    documents: [{ kind: 'trade_licence', label: 'Trade licence' }],
  },
  {
    // No documents at all. "Not provided" is a state an approver meets often.
    slug: 'levant-lighting',
    contact: 'Omar Nasser',
    business_name: 'Levant Lighting Co.',
    store_name: 'Levant Lighting',
    category: 'Lighting',
    city: 'Beirut',
    country: 'Lebanon',
    phone: '+961 1 555 0144',
    cr_number: '2030405060',
    vat_number: null,
    fulfillment_type: 'dropship',
    description: 'Hand-blown glass pendants and brass floor lamps.',
    daysAgo: 6,
    status: 'pending',
    documents: [],
  },
  {
    slug: 'nadia-ceramics',
    contact: 'Nadia Farouk',
    business_name: 'Nadia Ceramics Studio',
    store_name: 'Nadia Ceramics',
    category: 'Decor',
    city: 'Cairo',
    country: 'Egypt',
    phone: '+20 2 555 0177',
    cr_number: '3040506070',
    vat_number: '200456789100003',
    fulfillment_type: 'studio',
    description: 'Small-batch stoneware vases and tableware.',
    daysAgo: 1,
    status: 'pending',
    documents: DOCS_FULL,
  },
  {
    slug: 'gulf-upholstery',
    contact: 'Yusuf Rahman',
    business_name: 'Gulf Upholstery Works',
    store_name: 'Gulf Upholstery',
    category: 'Furniture',
    city: 'Doha',
    country: 'Qatar',
    phone: '+974 4 555 0122',
    cr_number: '4050607080',
    vat_number: '300112233400003',
    fulfillment_type: 'factory',
    description: 'Bespoke sofas and headboards, fifteen-day turnaround.',
    daysAgo: 0,
    status: 'pending',
    documents: [
      { kind: 'trade_licence', label: 'Trade licence' },
      { kind: 'bank_letter', label: 'Bank letter' },
    ],
  },
  {
    // Decided, so the Done tab and the audit fields aren't empty.
    slug: 'meridian-textiles',
    contact: 'Sara Al-Amin',
    business_name: 'Meridian Textiles',
    store_name: 'Meridian',
    category: 'Textiles',
    city: 'Muscat',
    country: 'Oman',
    phone: '+968 24 555 0166',
    cr_number: '5060708090',
    vat_number: '400223344500003',
    fulfillment_type: 'warehouse',
    description: 'Hand-loomed rugs and cushion covers.',
    daysAgo: 20,
    status: 'approved',
    documents: DOCS_FULL,
  },
  {
    slug: 'quickship-imports',
    contact: 'Tareq Bilal',
    business_name: 'QuickShip Imports',
    store_name: 'QuickShip',
    category: 'Furniture',
    city: 'Sharjah',
    country: 'United Arab Emirates',
    phone: '+971 6 555 0188',
    cr_number: null,
    vat_number: null,
    fulfillment_type: 'dropship',
    description: 'Imported flat-pack furniture.',
    daysAgo: 16,
    status: 'rejected',
    rejection_reason:
      'No commercial registration provided and the business address could not be verified.',
    documents: [],
  },
];

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  // Mid-morning rather than midnight, so "waiting" reads naturally.
  d.setHours(9, 30, 0, 0);
  return d.toISOString();
}

async function findSeedUsers(): Promise<{ id: string; email: string }[]> {
  // listUsers pages; the seed set is small but paging keeps this honest if the
  // project has many users.
  const found: { id: string; email: string }[] = [];
  let page = 1;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    for (const u of data.users) {
      if (u.email?.endsWith(EMAIL_SUFFIX)) found.push({ id: u.id, email: u.email });
    }
    if (data.users.length < 200) break;
    page += 1;
  }
  return found;
}

async function clean() {
  const users = await findSeedUsers();
  if (users.length === 0) {
    console.log('No seed vendors found.');
    return;
  }
  console.log(`Removing ${users.length} seed vendor account(s)...`);
  for (const u of users) {
    // profiles and vendor_profiles cascade from auth.users.
    const { error } = await supabase.auth.admin.deleteUser(u.id);
    if (error) console.error(`  failed ${u.email}: ${error.message}`);
    else console.log(`  removed ${u.email}`);
  }
}

async function seed() {
  console.log(`Seeding ${VENDORS.length} vendor applications...\n`);

  for (const v of VENDORS) {
    const email = `${v.slug}${EMAIL_SUFFIX}`;
    const submittedAt = daysAgoIso(v.daysAgo);

    // 1. Auth user. email_confirm so nothing sits waiting on a mailbox that
    //    does not exist.
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password: SEED_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: v.contact, role: 'vendor' },
    });

    let userId = created?.user?.id;

    if (createErr) {
      // Already seeded — find and reuse rather than failing the whole run.
      const existing = (await findSeedUsers()).find(u => u.email === email);
      if (!existing) {
        console.error(`  ${v.business_name}: ${createErr.message}`);
        continue;
      }
      userId = existing.id;
    }

    if (!userId) {
      console.error(`  ${v.business_name}: no user id returned`);
      continue;
    }

    // 2. profiles row with the vendor role. This is what RBAC reads — without
    //    it the account authenticates but fails every role check.
    const { error: profileErr } = await supabase
      .from('profiles')
      .upsert({ id: userId, full_name: v.contact, role: 'vendor' }, { onConflict: 'id' });

    if (profileErr) {
      console.error(`  ${v.business_name}: profile — ${profileErr.message}`);
      continue;
    }

    // 3. The application itself.
    const documents = v.documents.map(d => ({
      kind: d.kind,
      label: d.label,
      // A storage key, not a URL — the bucket is private and the backend signs
      // these on demand. Nothing is actually uploaded by this seed, so the
      // admin screen will show them as present but a signed-URL request will
      // 404. That is the honest shape; real uploads come from the vendor form.
      path: `vendor-documents/${userId}/${d.kind}.pdf`,
      uploaded_at: submittedAt,
    }));

    const row: Record<string, any> = {
      id: userId,
      business_name: v.business_name,
      business_email: email,
      store_name: v.store_name,
      phone: v.phone,
      category: v.category,
      city: v.city,
      country: v.country,
      description: v.description,
      cr_number: v.cr_number,
      vat_number: v.vat_number,
      fulfillment_type: v.fulfillment_type,
      legal_documents: documents,
      status: v.status,
      submitted_at: submittedAt,
      created_at: submittedAt,
      updated_at: submittedAt,
    };

    if (v.status === 'approved') {
      row.verified_at = daysAgoIso(Math.max(0, v.daysAgo - 2));
      row.decided_at = daysAgoIso(Math.max(0, v.daysAgo - 2));
    }
    if (v.status === 'rejected') {
      row.rejection_reason = v.rejection_reason;
      row.decided_at = daysAgoIso(Math.max(0, v.daysAgo - 3));
    }

    const { error: vendorErr } = await supabase
      .from('vendor_profiles')
      .upsert(row, { onConflict: 'id' });

    if (vendorErr) {
      console.error(`  ${v.business_name}: vendor_profiles — ${vendorErr.message}`);
      continue;
    }

    const age = v.daysAgo === 0 ? 'today' : `${v.daysAgo}d ago`;
    console.log(`  ${v.status.padEnd(8)} ${v.business_name} (${age})`);
  }

  console.log('\nDone. Two of these share CR 1010203040 — the approval screen');
  console.log('should warn about the duplicate rather than block it.');
}

/**
 * A minimal valid PDF. Hand-written rather than pulled from a fixture file so
 * the script stays self-contained — it only has to open in a viewer, not look
 * like anything.
 */
function placeholderPdf(title: string): Buffer {
  const text = `BT /F1 16 Tf 60 720 Td (${title.replace(/[()\\]/g, '')}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

async function uploadDocs() {
  const { data: vendors, error } = await supabase
    .from('vendor_profiles')
    .select('id, business_name, legal_documents');

  if (error) throw error;

  let uploaded = 0;
  for (const v of vendors || []) {
    const docs: any[] = Array.isArray(v.legal_documents) ? v.legal_documents : [];
    for (const d of docs) {
      if (!d?.path) continue;
      const objectPath = String(d.path).replace(/^vendor-documents\//, '');
      const { error: upErr } = await supabase.storage
        .from('vendor-documents')
        .upload(objectPath, placeholderPdf(`${d.label} — ${v.business_name}`), {
          contentType: 'application/pdf',
          upsert: true,
        });
      if (upErr) {
        console.error(`  ${v.business_name} / ${d.kind}: ${upErr.message}`);
      } else {
        uploaded += 1;
      }
    }
  }
  console.log(`Uploaded ${uploaded} placeholder document(s).`);
  if (uploaded === 0) {
    console.log('If every upload failed, check the vendor-documents bucket exists and is private.');
  }
}

(async () => {
  const mode = process.argv.includes('--clean')
    ? 'clean'
    : process.argv.includes('--upload-docs')
      ? 'upload'
      : 'seed';
  try {
    if (mode === 'clean') await clean();
    else if (mode === 'upload') await uploadDocs();
    else await seed();
  } catch (err: any) {
    console.error('\nFailed:', err.message ?? err);
    process.exit(1);
  }
})();