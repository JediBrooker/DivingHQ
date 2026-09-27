---
name: Bug report
about: Something is broken or behaving incorrectly
title: "[bug] "
labels: bug
assignees: ''
---

<!--
Thanks for taking the time to file a bug. The more of the sections below
you fill in, the faster we can fix it.

PLEASE DO NOT paste passwords, JWT signatures, API tokens, or
anything else secret. If a JWT helps diagnosis, redact the signature
(the third dot-separated segment) — the header + payload are enough
for us to see the role and expiry.
-->

## Summary

<!-- One sentence — what went wrong? -->

## Steps to reproduce

1.
2.
3.

## Expected behaviour

<!-- What should have happened? -->

## Actual behaviour

<!-- What did happen? Include exact error text if any. -->

## Screenshots / screen recording

<!-- Drag-and-drop into this box. A 5-second clip of the broken flow is gold. -->

## Environment

- **Where**: [ ] production  [ ] staging  [ ] local dev
- **App URL** (if hosted): 
- **Browser + version**: <!-- e.g. Chrome 124, Safari 17.4, Firefox 125 -->
- **OS**: <!-- e.g. macOS 14.4, Windows 11, iOS 17.5, Android 14 -->
- **Device**: <!-- desktop / iPhone 15 / iPad / Pixel 8 -->
- **Your role**: <!-- diver / judge / coach / meet operator / org admin / system admin -->
- **Org / meet slug** (if relevant): 

## Server-side info (for self-hosters)

<!-- Skip this block if you're a regular user on a hosted instance. -->

- **Node version**: <!-- node -v -->
- **Postgres version**: <!-- psql --version -->
- **Schema version**: <!-- SELECT version FROM schema_meta WHERE id = 1; -->
- **Boot log** (last ~20 lines of `npm start` output, with secrets redacted):

```
paste here
```

- **Browser console** (F12 → Console tab; copy any red errors):

```
paste here
```

- **Network tab** (any failing requests, with method + URL + status code):

```
paste here
```

## Tried already

<!-- 
Quick triage list — tick what you've already tried:
-->

- [ ] Hard-refreshed (Cmd-Shift-R / Ctrl-Shift-R) — service worker is network-first now
- [ ] Signed out + back in (refreshes the JWT and any role flags)
- [ ] Checked the Connection-lost banner on the live view
- [ ] Confirmed `CF_ACCOUNT_ID` / `CF_EMAIL_TOKEN` are set (for email-related bugs)
- [ ] Ran the latest migrations (for schema-version errors)

## Anything else?

<!-- Frequency, regression info ("worked yesterday"), workarounds, etc. -->
