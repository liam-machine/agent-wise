// Wiseway demo staff directory — SIMULATED LOGINS, NOT REAL SECURITY.
//
// This is the single source of truth for the mock IdP. The exact same set of
// users (mobile / pin / role / display name / email) is mirrored in:
//   - the orchestration README staff table
//   - mcp-doc-search role gating (via the role string)
//   - the Mongo seed-roles script (email -> role)
//
// Keyed by mobile number (the value the user types on the sign-in page and the
// value emitted as the `preferred_username` claim).
//
// `sub` is the stable subject identifier baked into the ID token. It must be a
// stable, opaque-ish string per user; we use a `wiseway|<mobile>` form so it is
// human-readable in the demo while still being unique per account.

export const STAFF = {
  '0412345678': {
    pin: '1234',
    role: 'warehouse',
    name: 'Sam Tran (Warehouse)',
    email: 'sam.tran@wiseway.demo',
    sub: 'wiseway|0412345678',
  },
  '0423456789': {
    pin: '2345',
    role: 'driver',
    name: 'Dee Okafor (Driver)',
    email: 'dee.okafor@wiseway.demo',
    sub: 'wiseway|0423456789',
  },
  '0434567890': {
    pin: '3456',
    role: 'office',
    name: 'Olivia Park (Office)',
    email: 'olivia.park@wiseway.demo',
    sub: 'wiseway|0434567890',
  },
  '0445678901': {
    pin: '4567',
    role: 'hr-admin',
    name: 'Hannah Reed (HR Admin)',
    email: 'hannah.reed@wiseway.demo',
    sub: 'wiseway|0445678901',
  },
};

// Reverse lookup: sub -> { mobile, ...staff }. Used by findAccount, which
// receives the `accountId` (== sub) that was set at login time.
const BY_SUB = Object.fromEntries(
  Object.entries(STAFF).map(([mobile, s]) => [s.sub, { mobile, ...s }]),
);

/**
 * Normalise a typed mobile number: strip spaces, dashes, parentheses and a
 * leading +61 country code so "+61 412 345 678" and "0412345678" both match.
 */
export function normaliseMobile(input) {
  if (!input) return '';
  let m = String(input).replace(/[\s()-]/g, '');
  if (m.startsWith('+61')) m = '0' + m.slice(3);
  else if (m.startsWith('61') && m.length === 11) m = '0' + m.slice(2);
  return m;
}

/**
 * Validate a mobile + PIN pair. Returns the staff record (with `mobile`) on
 * success, or null on any mismatch. Constant-ish: we always look up then
 * compare so a missing user and a wrong PIN behave the same to the caller.
 */
export function authenticate(mobileInput, pin) {
  const mobile = normaliseMobile(mobileInput);
  const staff = STAFF[mobile];
  if (!staff) return null;
  if (String(pin) !== String(staff.pin)) return null;
  return { mobile, ...staff };
}

/** Look up a staff record by the subject identifier stored at login. */
export function findBySub(sub) {
  return BY_SUB[sub] || null;
}
