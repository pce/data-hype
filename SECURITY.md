# SECURITY.md

This document describes security expectations, recommendations, and responsible-disclosure guidance for
the Hype project. It is written for maintainers and consumers (applications embedding Hype) so the
library remains safe-by-default and avoids common pitfalls (notably XSS and unsafe HTML injection).

## Summary / Goals

- Hype is designed for progressive enhancement: HTML should remain valid and functional without JS.
- The library aims to be safe-by-default: dangerous DOM operations (injecting arbitrary HTML) are disabled
  unless explicitly permitted by the server or the integrator.
- Consumers are responsible for ensuring server-provided HTML is trusted or sanitized before allowing
  it to be injected into the page.

## What to do if you discover a vulnerability

1. Do not make the issue public immediately.
2. Send a private report to the project maintainers (see contact info below) with:
   - A concise summary of the issue and impact.
   - Reproduction steps (minimal HTML + HTTP response + configuration to reproduce).
   - A suggested severity (informal) and potential mitigations if known.
3. Give maintainers a reasonable time to triage and act (typically 7–14 days for a fix or a public reply).
4. If you are unable to reach maintainers, you may disclose publicly after giving maintainers reasonable time,
   but try to follow established responsible disclosure norms.

Contact (replace with the project's preferred private contact):
- Security contact: security@example.com
- If you prefer PGP: provide the project's PGP public key in the repo (or on the maintainer profile).

## Supported versions

Please indicate the Hype version(s) you are reporting against. Only actively maintained
branches will receive fixes; otherwise maintainers will advise on backport expectations.

## Threat model / common risks

- Cross-Site Scripting (XSS) is the primary risk when a library inserts HTML from network responses
  into the DOM (e.g., with `innerHTML`). Hype's default behavior avoids unsafe injection.
- DOM-based XSS or event handler hijacking when unsanitized markup includes `<script>` or inline event attributes.
- Malicious server responses attempting to bypass client-side protections.
- Supply-chain risk: compromised npm packages or transitive dependencies.

## Hype-specific security controls

- Safer default swap strategy: Hype defaults `defaultSwap` to `none`. This prevents automatic insertion of server-specified
  HTML unless explicitly permitted.
- Safe opt-in for `innerHTML`: Hype will only perform an `innerHTML` swap when one of these is present:
  - The server sets the header `X-Hype-Allow-InnerHTML: true` on the HTTP response, or
  - A JSON response includes the boolean field `allowInnerHTML: true`.
  This makes the opt-in explicit and auditable from the server side.
- Behavior wiring and pubsub are JS-only and do not change the HTML served to non-JS clients. (therfore as default attached plugin)


## Recommendations for integrators

Always treat server-provided HTML as untrusted unless you control and sanitize the content.

1. Prefer structured JSON responses
   - Return JSON directives and only include sanitized/templated HTML if necessary.
   - Prefer swap strategies that don't inject arbitrary HTML (`none`, `delete`, `beforeend`, `afterend`, etc.)
     when possible.

2. Sanitize HTML before allowing `innerHTML`
   - On the server, sanitize any HTML fragments that may include user content.
   - Recommended server-side libraries:
     - Node.js: `sanitize-html`, `xss`, custom template escaping
     - Python: `bleach`
     - Ruby: `Loofah`
   - If client-side sanitization is used, ensure it's robust and applied to every fragment before insertion.

3. Use Content Security Policy (CSP)
   - Set a restrictive CSP. Minimal suggestions:
     - `Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-<...>'; object-src 'none'; base-uri 'self';`
     - Consider `require-trusted-types-for 'script'` and using Trusted Types if your app is web-compatible.
   - Use `report-to` / `report-uri` for violations when rolling out changes (CSP Report-Only).

4. Avoid inline scripts/styles and event handlers in server HTML
   - Inline `on*` attributes and `<script>` tags are common XSS vectors. Avoid them in server-rendered fragments.

5. Use SRI (Subresource Integrity) and served-from-trusted CDNs
   - When including Hype or other libs from CDNs, use SRI and host scripts over HTTPS.

6. Secure transport and headers
   - Serve all assets over HTTPS.
   - Recommended headers:
     - `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
     - `X-Content-Type-Options: nosniff`
     - `X-Frame-Options: DENY` or per-app framing policy
     - `Referrer-Policy: no-referrer-when-downgrade` (or tighter)
     - `Permissions-Policy: ...` (limit features)

7. Dependency hygiene
   - Lock dependencies (`package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`).
   - Use automated scans: `npm audit`, Dependabot, Snyk, or other SCA tooling.
   - Review transitive dependencies for native code or eval usage.

8. CI security checks
   - Run automated linting for CSP, SAST checks, and dependency scans in CI.
   - Add tests that exercise swapping behavior and verify unsafe HTML is blocked when opt-in is absent.

## What Hype maintainers should do

- Keep `defaultSwap` conservative (current: `none`) and clearly document how to opt-in.
- Validate opt-in signals:
  - `X-Hype-Allow-InnerHTML: true` header is canonical and case-insensitive.
  - `allowInnerHTML` boolean in JSON responses is allowed only when `Content-Type` is `application/json`.
- Maintainers should:
  - Monitor dependency advisories and update transitive packages promptly.
  - Provide clear upgrade paths and changelogs for security-relevant changes.
  - Publish security fixes with CVE/semver-major guidance when appropriate.

## Examples (behavioral guidance, not literal code blocks)

- Server must add header `X-Hype-Allow-InnerHTML: true` to allow `innerHTML` swaps.
- Alternatively, JSON responses can include `allowInnerHTML: true` alongside `html: "<trusted markup>"`.
- If neither is present, Hype will block `innerHTML` swaps and log a message to the console.

## Repro steps / report template

When reporting a suspected security issue, provide:

- Steps to reproduce, including minimal HTML and HTTP response payload.
- Hype version and environment (browser, Node, server).
- Expected behavior vs. observed behavior.
- Any relevant logs, headers, or screenshots.
- A short suggested mitigation if you have one.

Example template (fill in fields):

- Hype version: vX.Y.Z
- Browser / OS:
- Minimal reproduction: (HTML + HTTP response)
- Observed behavior:
- Impact (e.g., XSS, data exposure):
- Suggested fix:

## Contact / responsible disclosure

- Email: security@example.com (replace with actual security contact)
- Please encrypt sensitive reports if possible; provide a PGP key or fallback to a private GitHub issue or direct email.
- We will acknowledge receipt and provide an estimated timeline for remediation.

## Final notes

Security is a shared responsibility. Hype is intentionally small and designed for progressive enhancement, but developers must still follow best practices:
- Sanitize untrusted content,
- Use CSP and secure headers,
- Keep dependencies up-to-date,
- Prefer structured JSON responses and safe swap strategies.

If you have questions about secure integration patterns for your specific app, open an issue or contact the maintainers directly.
