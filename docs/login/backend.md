# Login — what the backend must configure

**For the root backend developer.** Everything here is configuration, not code:
three settings and a path. All of it is needed before anyone can sign in, and
two of them are expensive to change later.

The endpoint contract itself is in `root-enrollment.md`. This is only the part
that depends on *where the console is running*.

---

## 1. The three settings

They look related and are not the same shape — one is a full URL, the other a
bare domain. That is the easy mistake.

| Setting | Local dev | What it does |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:3002` | builds the access link. **Takes the port.** |
| `rp.id` | `localhost` | WebAuthn relying party. **Domain only — no scheme, no port.** |
| `rp.name` | `Ramaaz Root` | free text, shown in the passkey prompt |

---

## 2. The link path changed

Mint links as:

```
{PUBLIC_URL}/enter/{token}
```

**Not** `/dashboard/{token}`. The console serves the token route at `/enter`;
`/dashboard` is the real dashboard and answers 404 for a token.

The route handler posts the token to `/v1/auth/link` in the **body**, renders
nothing, and redirects — so the token appears in the address bar for one request
and never reaches a document, a referrer header or an RSC payload.

---

## 3. `rp.id` must not carry a port

`localhost:3002` is rejected by the browser, not by us:

```
SecurityError: The relying party ID is not a registrable domain
suffix of, nor equal to the current domain.
```

Use `localhost`. The port is ignored when the browser matches `rp.id` against
the page origin, and plain HTTP is fine there because browsers treat localhost
as a secure context — WebAuthn works without TLS.

In production `rp.id` must equal the console's domain, or `create()` throws the
same error.

---

## 4. ⚠️ Pick the production domain before the first real enrolment

A passkey is bound to the `rp.id` it was created under. One enrolled against
`localhost` works **only** on localhost — it will not carry to staging or
production.

Harmless for test accounts. Expensive for real ones: a passkey that no longer
matches cannot be recovered, and the only path back is another root
administrator issuing a fresh link. Do that to every administrator at once and
the console locks itself.

So: **enrol nobody real until the production domain is decided**, and once it is,
do not change it.

Four things then have to agree on that one value:

| Where | What |
| --- | --- |
| `rp.id` | must equal the browser's origin domain |
| `PUBLIC_URL` | mints the link the administrator opens |
| KYC Worker `TENANTS.root.origins` | CORS |
| Cookie domain | only if sharing across subdomains is ever wanted |

---

## 5. What we cannot test until this is set

The passkey ceremony needs a real authenticator **and** a matching `rp.id`. Until
both exist, `/login/device` renders and calls `/v1/auth/device/options`, but the
browser refuses the ceremony — so neither a first-login enrolment nor a
returning sign-in can be walked end to end.

Everything before it — link, private code, face capture — is testable now.
