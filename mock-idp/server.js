// Wiseway mock phone+PIN OIDC provider — SIMULATED LOGIN, NOT REAL SECURITY.
//
// A minimal OpenID Connect provider (node-oidc-provider v9) that authenticates
// the four demo staff accounts with a mobile number + PIN and issues an ID
// token carrying: sub, name, email, preferred_username (the mobile), role.
//
// LibreChat is the only client. The issuer is the SAME string the browser is
// redirected to AND the string LibreChat validates against:
//     http://host.docker.internal:9000
// (see README.md for the one-time /etc/hosts step that makes the macOS browser
// resolve host.docker.internal the same way the LibreChat container already
// does).

import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import express from 'express';
import { render } from 'ejs';
import * as oidc from 'oidc-provider';

import { authenticate, findBySub } from './staff.js';

const Provider = oidc.Provider;
const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// MUST be identical browser-side and container-side. Override only if you know
// what you are doing — both the redirect target and LibreChat's OPENID_ISSUER
// have to keep matching this value exactly.
const ISSUER = process.env.ISSUER || 'http://host.docker.internal:9000';
const PORT = parseInt(process.env.PORT || '9000', 10);

const CLIENT_ID = 'librechat';
const CLIENT_SECRET = 'wiseway-demo-secret';
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3080/oauth/openid/callback';

const loginTemplate = readFileSync(join(__dirname, 'views', 'login.html'), 'utf8');

// Static demo signing key (JWK). This is a throwaway demo RSA key committed on
// purpose so the issuer's JWKS is stable across restarts (LibreChat caches the
// JWKS). It is NOT a real secret and must never be reused anywhere real.
const DEMO_JWKS = {
  keys: [
    {
      kty: 'RSA',
      kid: 'wiseway-demo-2026',
      use: 'sig',
      alg: 'RS256',
      n: 'oySZakGqR38f92ArxvxtR5gVXg3FdRQ6ZLZhqJzVYN7Pr6iUJEjjKyyD_ZEkbXTEFSelqIBbRFKVp8bOpUUlBFxUz19Cyctg8FCMniSemUz7wrANM_wdqqUKfSBgSrYR0qJh7V_VwWNUCgPNnNOefQKnc2t8gsdNT-K1FaNLgi49HaqwqkH7UGWDLzB0QeVsPzyOJFCBGXQ7xM7R2XZOcJBiClI_cu5FJ06-msq8rsgU0kOTMYeS75vkRnRQNdz93SwwkBrkqj2bk8xrek_Y0iIXz1rpdmfwQtf2ahh0vse5wx5wuSTiyPAX7qj36aEsAWA8yvPP3_O_deOpX3Q-4w',
      e: 'AQAB',
      d: 'LlM6swbxZLru504qMCdGmqFPU_VCIBQ93pJBWeEq4AZ03_LVGhaOVxidZDe-KcyRz1YCPr4v7E8tCsazsA9Zywqy1G2-59E19hdRTqikVnCbPrXCEgRhoi6aM1ypqx1XI0IT35Uqe-8KEovw6zrWErZZuTcI1JPmWqxL8lh7nPuyei_ZBSR5rF6H3bHAaud0N6u4Vg0kKJyAPhyc3asMtuw6T7yi0b5YoSnLI_CeYY8lnaCsq6_-6yaJcMNJ5FKrV8UAfYEQvNBtEefANx4NZ88EDMTz3lb3nXS554poQA9jlheNxrgcxfjq83QBKx7VaTbDrMI3q-0rkSBvKmkeuQ',
      p: '5Ix_o1PGYmM5mY-w-I6UJTC4L_zbV4MFjrJB0TEMHt-CeSylAHlZif0ejCRZzsgtGELS13RRjYCbW4JH93-uvnPjNbf0B4XTuxu0U7kXrP2oHfF8nLIBA9AZelnJdx7SroTWdB6KZNjxHirXLqN_5lK3OkTCn1lL49Uk1guYk0s',
      q: 'trz6VnlT7uuBE0f_qffP_Hl-o12k_ZkXjUQd_RWPMTJ3TRo_OK7aloK9R1r-V0B5xrM-i7ztPc_v8Vhm_rApUFGZQjuxRUswz1g-XInk8dBwprED-g9ChJTa9Jf_Xxiq9q9A-sqLzpxePWgwSMRE9njgiEOEK1E1ExGtvi3hK8k',
      dp: 'Oam1HmkpmXM9eiAF34Bhokx7fCgI0ziMc2dIMdZ1H2j3C0mXS9pSG_2P8n3NZt2cew2JErEXTmNPTzQ8ohZF6WllvwztdeRu-jtQMPt3HL9W5k8iSIqktOiRNQxoRzSwpTWAwgVel3kgxKK8bdj0kRD3h60HiZrHCfGh_JsqYKc',
      dq: 'Tw3yPva-GN5JOM4tDJron5Dv-DzK4-sXBUYyswpgqCfs9K4mK595cSOePwBeh-Cczhk9NbbF67fJVd-orwYG2XhzlPO9_PxKYWkLkX0WToaeNX7e-Y8gd7rt_mLDV6CUVaP7uINneDqtimNIgDJoozgn6stKonK_Q0CiqWOvxgE',
      qi: 'SH53oZt_nPcCAxDDJktbr99wMllg0Ya946p8F0I8p-78k3VHXaq-SfqLysRppV3XhMkLpY4f7ORR8sdNZ4kuwOeIKFCLZTGrovzyYtpJkE8FEow22Y1sVkt-JEA3887FRoxVTw2Qyp0ypTG7BefauA12P9CxhqJxf5bER1_nH-s',
    },
  ],
};

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

const configuration = {
  clients: [
    {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      // LibreChat (openid-client) authenticates at the token endpoint with the
      // client secret in the body; accept both post and basic.
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'openid profile email',
    },
  ],

  // Throwaway demo signing key (see DEMO_JWKS note above).
  jwks: DEMO_JWKS,

  // Map scopes -> claim names. `role` and `preferred_username` are first-class
  // here so they are emitted (not just `sub`). They ride on the `profile`
  // scope, which LibreChat requests.
  claims: {
    openid: ['sub'],
    email: ['email', 'email_verified'],
    profile: ['name', 'preferred_username', 'role'],
  },

  // Put the requested-scope claims directly into the ID token. LibreChat reads
  // name / email / preferred_username / role from the ID token, so we must not
  // defer them to a UserInfo round-trip.
  conformIdTokenClaims: false,

  // Drive the browser to our own Wiseway-branded phone+PIN page.
  interactions: {
    url(ctx, interaction) {
      return `/interaction/${interaction.uid}`;
    },
  },

  features: {
    // We provide a fully custom login + auto-consent for the trusted
    // first-party client, so the built-in dev interactions are off.
    devInteractions: { enabled: false },
    // Keep UserInfo available (harmless) so role/email are also reachable there.
    userinfo: { enabled: true },
    // No client-initiated logout UI needed for the demo.
    rpInitiatedLogout: { enabled: false },
  },

  // Do not force PKCE — LibreChat's openid-client may or may not send it.
  // (PKCE is still accepted if presented; this only relaxes the requirement.)
  pkce: {
    required: () => false,
  },

  // Demo lifetimes — short, this is a throwaway session.
  ttl: {
    Session: 3600,
    Interaction: 3600,
    Grant: 3600,
    AccessToken: 3600,
    IdToken: 3600,
    AuthorizationCode: 600,
  },

  // Cookie keys for the interaction/session cookies. Demo placeholder only.
  // secure:false because the issuer is served over plain HTTP for the demo.
  cookies: {
    keys: ['wiseway-demo-cookie-key-not-a-secret'],
    long: { signed: true, httpOnly: true, sameSite: 'lax', secure: false },
    short: { signed: true, httpOnly: true, sameSite: 'lax', secure: false },
  },

  // ----- Account resolution -----
  // `id` here is the accountId we set at login time (the staff `sub`). Return
  // the full claim set; oidc-provider masks by scope automatically.
  async findAccount(ctx, id) {
    const staff = findBySub(id);
    if (!staff) return undefined;
    return {
      accountId: id,
      async claims(/* use, scope */) {
        return {
          sub: id,
          name: staff.name,
          email: staff.email,
          email_verified: true,
          preferred_username: staff.mobile,
          role: staff.role,
        };
      },
    };
  },
};

const provider = new Provider(ISSUER, configuration);

// The issuer is served over plain HTTP (http://host.docker.internal:9000) for
// the demo. Trust the proxy/host so oidc-provider does not insist on a TLS
// context and refuse to set cookies / issue tokens over http.
provider.proxy = true;

// ---------------------------------------------------------------------------
// Express app + custom interaction (login) routes
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false }));

function renderLogin(res, { uid, error = null, mobile = '' }) {
  const html = render(loginTemplate, {
    submitUrl: `/interaction/${uid}/login`,
    error,
    mobile,
  });
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

// GET the login page (or auto-consent) for a pending interaction.
app.get('/interaction/:uid', async (req, res, next) => {
  try {
    const details = await provider.interactionDetails(req, res);
    const { uid, prompt } = details;

    if (prompt.name === 'login') {
      return renderLogin(res, { uid });
    }

    // Any other prompt (consent) — auto-grant for the trusted client.
    return res.redirect(`/interaction/${uid}/confirm`);
  } catch (err) {
    return next(err);
  }
});

// POST the mobile + PIN.
app.post('/interaction/:uid/login', async (req, res, next) => {
  try {
    const details = await provider.interactionDetails(req, res);
    const { uid, prompt } = details;
    if (prompt.name !== 'login') {
      return res.redirect(`/interaction/${uid}/confirm`);
    }

    const { mobile, pin } = req.body;
    const staff = authenticate(mobile, pin);

    if (!staff) {
      return renderLogin(res, {
        uid,
        error: 'Incorrect mobile number or PIN. Please try again.',
        mobile: mobile || '',
      });
    }

    const result = {
      login: {
        accountId: staff.sub,
        amr: ['pin'], // phone+PIN demo auth method
        remember: false,
      },
    };

    return provider.interactionFinished(req, res, result, {
      mergeWithLastSubmission: false,
    });
  } catch (err) {
    return next(err);
  }
});

// Auto-consent for the trusted first-party client. LibreChat is a known,
// internal client, so we grant the requested OIDC scopes without a separate
// "do you allow this app?" screen.
app.get('/interaction/:uid/confirm', async (req, res, next) => {
  try {
    const interactionDetails = await provider.interactionDetails(req, res);
    const {
      uid,
      prompt: { details },
      params,
      session,
    } = interactionDetails;

    const accountId = session?.accountId;
    if (!accountId) {
      // No session yet — send the user back to login.
      return res.redirect(`/interaction/${uid}`);
    }

    let { grantId } = interactionDetails;
    let grant;
    if (grantId) {
      grant = await provider.Grant.find(grantId);
    } else {
      grant = new provider.Grant({
        accountId,
        clientId: params.client_id,
      });
    }

    if (details.missingOIDCScope) {
      grant.addOIDCScope(details.missingOIDCScope.join(' '));
    }
    if (details.missingOIDCClaims) {
      grant.addOIDCClaims(details.missingOIDCClaims);
    }
    if (details.missingResourceScopes) {
      for (const [indicator, scopes] of Object.entries(details.missingResourceScopes)) {
        grant.addResourceScope(indicator, scopes.join(' '));
      }
    }

    grantId = await grant.save();

    const consent = {};
    if (!interactionDetails.grantId) {
      consent.grantId = grantId;
    }

    const result = { consent };
    return provider.interactionFinished(req, res, result, {
      mergeWithLastSubmission: true,
    });
  } catch (err) {
    return next(err);
  }
});

// Mount the OIDC provider itself for everything else (well-known discovery,
// authorization, token, jwks, userinfo, …).
app.use(provider.callback());

// Basic error surface for the interaction routes.
app.use((err, req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error('[wiseway-idp] interaction error:', err);
  res.status(500).set('Content-Type', 'text/html; charset=utf-8');
  res.send('<h1>Wiseway IdP error</h1><p>Something went wrong during sign in. Check the server logs.</p>');
});

const onListen = () => {
  // eslint-disable-next-line no-console
  console.log(`[wiseway-idp] mock OIDC provider listening on :${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[wiseway-idp] issuer = ${ISSUER}`);
  // eslint-disable-next-line no-console
  console.log(`[wiseway-idp] discovery = ${ISSUER}/.well-known/openid-configuration`);
};

// LibreChat's OIDC strategy only accepts an HTTPS issuer, so serve TLS when a
// cert/key are provided (mounted via docker-compose). Falls back to HTTP.
const TLS_CERT_FILE = process.env.TLS_CERT_FILE;
const TLS_KEY_FILE = process.env.TLS_KEY_FILE;
if (TLS_CERT_FILE && TLS_KEY_FILE) {
  createHttpsServer(
    { cert: readFileSync(TLS_CERT_FILE), key: readFileSync(TLS_KEY_FILE) },
    app,
  ).listen(PORT, onListen);
} else {
  app.listen(PORT, onListen);
}
