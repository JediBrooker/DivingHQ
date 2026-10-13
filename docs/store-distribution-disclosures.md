# Store distribution disclosures — working evidence

**Current status — 13 October 2026:** the owner has authorised **13-and-older direct use only**, superseding the earlier age-nine audience. The shared app’s registration and authentication changes are prepared; release still depends on a replacement native build, verification and remaining store disclosures. The owner explicitly declined notice emails on 13 October; no notice emails will be sent, and the earlier notice-approval hold is superseded. See [Owner audience decision — 13 October 2026](#owner-audience-decision--13-october-2026) for the current scope and limitations. This document is not evidence of deployment or store submission.

## Historical 12 October 2026 snapshot

The following body, through “Final local verification gate”, preserves the 12 October audience decision, blockers and build-4 verification evidence. Statements that the owner had not authorised a 13+ audience describe that historical snapshot and are superseded by the 13 October decision linked above.

Prepared 12 October 2026. This is a draft for the store operator, not a submitted declaration or a legal certification. Source inspection began at `38aa051a299d3114f80e92b0e1a2d57dcbfe17b5`; corrective release **1.2 (4)** has now been built locally and passed the final source-verification gate and awaits commit/upload. Its build evidence does not replace build 3 physical-device acceptance.

The owner confirmed all supported countries and direct use by children aged **9 and above**, as well as adults. Google target groups are therefore **9–12, 13–15, 16–17, 18+**. Do not select younger groups, adult-only access, or a 13+ target merely to avoid children's requirements. An Apple content rating is a separate calculation and may exceed the intended minimum age.

## Preparation completed and distribution holds

Prepared: public support/deletion page source and truthful native-record retention disclosure; store descriptions and uploaded authentic screenshots; audited data-type/purpose drafts and corrected Apple privacy manifest; all supported Google territories staged; review credentials saved; and completed Google IARC/health/content questionnaire work described below. These are preparation results, not public distribution or complete physical-device acceptance.

Still required before the intended **9+ worldwide release**:

- Implement and verify the missing parent/child-data authorisation process and appropriate child-facing content/safeguarding controls; existing payment guardian links do not satisfy this.
- Resolve calculated store ratings against the owner's age-9 audience. Google currently disables the required under-13 selection. The owner has not authorised changing the audience to 13+, and neither a misleading questionnaire answer nor a manual rating reduction resolves it. Mixed-age use does not itself require Apple's Kids category.
- Resolve Cloudflare edge query-retention uncertainty and certify privacy answers consistently with actual operation. Draft conservative Search History disclosure is not verified retention evidence.
- Finish deployment and anonymous live-page verification, native build-4 upload/acceptance. Signed build-4 packages and scoped reviewer access checks are complete. Prior build-3 owner testing and outstanding physical-device gaps remain separate evidence.
- Keep app-review submission on hold: Google managed publishing is OFF and could publish approved changes automatically; no release has been sent for review.

## Ready answers and outstanding decisions

| Field | Draft answer / evidence |
|---|---|
| Privacy policy | `https://divinghq.app/privacy` — rendered and read anonymously in Chromium on 12 October |
| Contact email | `support@divinghq.app` — public-config API returned it |
| Account creation | Username/password, with email verification; optional authenticator 2FA. No social login found |
| Access restrictions | **Some functionality is restricted**. Public results work without login; judge, coach, competitor and manager functions need assigned accounts/roles |
| Data collected | **Yes** on both stores; account, competition, notification and operational data leave the device |
| Tracking / advertising identifier | No tracking/AAID implementation found. No AD_ID permission in merged Android release manifest |
| Encryption in transit | Yes for configured app/API and provider collection; release HTTPS origin and no release cleartext permission. User-directed exports leave through the destination the user chooses |
| Account deletion | Yes, in Profile → Delete account, password reauthentication. Retention exceptions must be disclosed; see below |
| Independent security assessment badge | Do not claim MASA or equivalent certification; ordinary CI/security review is not that certification |
| Purchases / financial services | Payments and classes returned **false** from live `/api/features`; no active card collection or in-app purchases established |
| Families compliance | Required assessment for intended child audience; **not ready to certify**. Owner confirmed no formal parental-consent process |
| Ads | **No**, for owner-confirmed meet acknowledgements with no paid ad placements/ad inventory. Reassess if operation changes; Families commercial-content review still applies |
| Review credentials | Dedicated adult fixture accounts provisioned; HTTPS role and cross-organisation access boundaries verified. Never disclose owner/sysadmin credentials |

The source for Google form semantics is [Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469). The recommendations below map DivingHQ's own code to those categories; they are not a claim that Google has approved the mapping.

## Data inventory for both forms

Apple rows below are **linked to the user**, **not used for tracking**, and **App Functionality**, except where noted. Keep these answers consistent with the privacy policy and actual release. On Google every inventory row below is collected and **not ephemeral**: the database/logs retain it. Search queries are a separate unresolved retention case described below. Account-only collection is optional for a spectator who can use the app anonymously; required technical collection is identified separately. This does not mean a person can create an account without a name/email.

| Actual collection | Apple category | Google category; purposes; collection choice |
|---|---|---|
| Full name | Name | Personal info → Name; App functionality, Account management; optional when choosing an account |
| Email and service verification/reset correspondence | Email Address | Personal info → Email address; App functionality, Account management; optional when choosing an account |
| Username, account UUID, role and organisation association | User ID | Personal info → User IDs; App functionality, Account management, Fraud prevention/security/compliance; optional when choosing an account |
| Password hash/authenticator setup, birthday, gender, nationality, country/club/region, competition eligibility profile and saved display preferences | Other Data Types (App Functionality and Product Personalization) | Personal info → Other info; App functionality, Account management, Personalization; optional relative to anonymous viewing |
| Dive entries, scores, performance history and athlete results | Fitness (conservative classification of physical sporting performance) | Health and fitness → Fitness info; App functionality; optional for viewers. This is not medical data or HealthKit access |
| Coach/diver and guardian/dependent associations | Contacts (social graph, not address-book access) | Contacts (social graph); App functionality; optional. Keep unless store guidance confirms structured sporting relationships belong only under Other info |
| Role notes, claim objections, correction/withdrawal reasons, meet descriptions | Other User Content | App activity → Other user-generated content; App functionality; optional |
| Sponsor logo image uploads | Photos or Videos | Photos and videos → Photos; App functionality; optional manager action. Do not infer Videos collection from Apple's combined label |
| CSV roster imports sent to server | Other User Content | Files and docs; App functionality; optional. Imported fields also fall under their respective categories above |
| Server-side privileged-action audit trail, recorded notification acknowledgement, activity timestamps | Product Interaction / Other Usage Data as applicable | App activity → App interactions / Other actions as applicable; App functionality, Fraud prevention/security/compliance; required for the actions performed |
| Push installation ID, APNs/FCM token, account/device association, expiry and revocation state | Device ID | Device or other IDs; App functionality, Fraud prevention/security/compliance; optional notification opt-in |
| IP/user-agent security logs, provider failure reasons and technical diagnostics | Other Diagnostic Data; Device ID only where used as an identifier | App info and performance → Diagnostics; Analytics (technical health), Fraud prevention/security/compliance, App functionality; required security/operational collection. No behavioural advertising analytics |

Evidence: `routes/auth.js` signup and session responses; `routes/users.js` profile/deletion/guardian links; `routes/control-room.js` roster import; `routes/meets.js` sponsor uploads; `lib/audit.js`; `lib/metrics.js`; `lib/native-push.js`; `routes/push.js`; `docs/privacy-policy.md`.

Apple's [privacy definitions](https://developer.apple.com/app-store/app-privacy-details/) include physical activity, social graphs, free-form content and retained technical data. Do not equate “no analytics SDK” with “no collection”. Aggregate Prometheus route/status latency counters contain no user/device labels; do not label them user-linked merely because other diagnostic records are linked. There is no evidence of a dedicated client crash-reporting SDK, microphone, location, health sensors, address-book access, private message chat, or camera capture. No collected category should be added just because an arbitrary free-text field could contain it.

Review before final submission:

- **In-app search history:** Google collection includes ephemeral transmission. Add Collected, optional, App functionality for the actual diver/judge/guardian/archive search queries sent in `?q=`. The backend uses terms transiently; its errors log `req.path` without query strings and Prometheus records route templates. Do not certify ephemeral handling or Apple noncollection until provider retention is confirmed: Cloudflare's [firewall log schema](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/firewall_events/) includes `ClientRequestQuery`. Production configuration was checked after renewed Tailscale authentication: no nginx/caddy in the app container, deployed logger uses path only, and the tunnel has no debug logging flags/config/environment (default info). This does not establish Cloudflare edge WAF/Logpush retention. No user logs were inspected. Ephemeral handling remains a form decision, not proven retention or proven non-retention.
- Profile widget/layout/language settings are persisted user preferences. Add Product Personalization to Apple Other Data Types and Personalization to Google Other personal info collection consistently. This does not require labelling User ID personalization merely because preferences have an account association; ordinary role permissions are App Functionality.
- There is no customer-support form in the app; the contact action opens email. Support correspondence is covered in the policy; do not invent an in-app email reader or messaging system.
- `ios/App/App/PrivacyInfo.xcprivacy` has been corrected locally from an empty collected-data array to the 11 evidenced Apple types plus conservative Search History. All are linked, not tracking, and App Functionality; Other Data Types also declares Product Personalization. The manifest diff and version-4 export configuration were independently reviewed. The native build must carry this manifest and the final policy copy, and store privacy labels must match; this does not resolve the Cloudflare retention uncertainty.

### Google sharing answers

Do not select global “no data shared” without documenting the sport-organisation paths. APNs/FCM and Cloudflare process service data; Google permits the service-provider exception where the actual provider arrangement meets it. A deliberate OS share/export can use the user-initiated exception. The organisation hierarchy is different: other clubs/federations are not automatically DivingHQ's service providers, and a newly approved federation can gain access later.

Conservative draft: mark **shared** for Name, Email address, User IDs, Other personal info, Fitness info, Contacts/social graph, and Other user-generated content where organisation officials receive them; purposes **App functionality** and, for account/role administration, **Account management**. Sharing is not ephemeral. Public results additionally publish participant names, representations and sporting performance. No advertising purpose or sale is evidenced. Narrow a row only after tracing its actual recipients and confirming a specific exception; policy acceptance alone is not proof of a prominent consent exception.

Sponsor images and CSV imports are user-initiated organisational uploads; document that exception if selecting not shared. Device identifiers and diagnostics should not be marked shared solely because a contracted service provider processes them, but inspect external sponsor image hosts before finalising: legacy logo URLs can load arbitrary HTTPS resources, exposing request metadata to that host (`SponsorRotation.vue`, native CSP allows HTTPS images).

### Saved Google draft state

On 12 October the operator saved, without final submission, a 14-type Data safety draft. Audience prerequisites and child-readiness gaps remain outstanding. Evidence: `play-data-safety-draft.png` in the external release evidence directory.

- Name, Email, User IDs and Other personal info: optional, collected and shared, App functionality and Account management; User IDs additionally collected for Fraud prevention/security/compliance.
- Fitness, Contacts and Other user-generated content: optional, collected and shared for App functionality.
- Photos and Files/docs: optional, collected for App functionality.
- App interactions and Other actions: required, collected for App functionality and Fraud prevention/security/compliance.
- Diagnostics: required, collected for App functionality, Analytics and Fraud prevention/security/compliance.
- Device IDs: optional, collected for App functionality and Fraud prevention/security/compliance.
- In-app search history: optional, collected for App functionality; **non-ephemeral is a conservative draft choice pending Cloudflare edge retention evidence**, not a verified statement that the app stores a search-history table.

All saved rows use non-ephemeral handling. The operator subsequently added the Personalization collection purpose for persisted Other personal info preferences only; no sharing-personalization or extra User ID purpose was added. Sharing purposes remain the operational functions described earlier.

### Native SDK facts

Android manifest disables Firebase Messaging automatic initialisation and Firebase Analytics collection. Merged release permissions include network state and notifications; no AD_ID or location permission was found. No Analytics/Crashlytics SDK is declared in package dependencies. FCM nevertheless uses Firebase Installations, whose identifier must be included once enabled. [Firebase's disclosure guide](https://firebase.google.com/docs/android/play-data-disclosure) explains FCM/Installations data. Opt-in is not parental consent. There is no evidence yet proving all provider terms/configuration appropriate for direct 9–12 use; do not call FCM prohibited merely because it uses an installation identifier.

## Content and age ratings

Use [Apple's current definitions](https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/), not the old 4+/9+/12+/17+ checklist.

| Apple field | Current implementation answer |
|---|---|
| Parental controls / age assurance | No implemented child-access/consent control identified. Payment guardian links do not qualify |
| User-generated content | Yes: meet details, names, sponsor uploads and other user-entered sporting content |
| Social media | No feed/likes/comments/follower amplification identified; structured results discovery is the app's sports function. Explain this if queried |
| Messaging/chat | No general chat/direct messaging found. Transactional notices and administrative requests are present; inspect the precise form wording before submitting |
| Unrestricted web access | No general-purpose browsing interface; external sponsor links exist. Their child safety still needs handling |
| Advertising | No paid promotion per owner confirmation; acknowledgement graphics remain user content requiring appropriate handling |
| Contests | **Recommended Frequent**: administering repeated sports competitions/rankings is core. Apple explicitly includes sports/fitness contests; do not answer None merely because diving happens offline |
| Gambling / simulated gambling / loot boxes | None found |
| Violence, sexual content, drugs, horror, profanity, medical treatment | None in authored content; unrestricted organiser uploads are a moderation gap, not evidence that mature content is intended |

Apple's current Frequent Contests mapping can result in **13+**, conflicting with the desired minimum 9. Submit truthful functionality answers and inspect the calculated rating; seek Apple clarification about event-administration classification if needed. Do not down-rate the answer to obtain 9+. General Sports positioning is supported; direct child use does not require pretending this mixed-role app is a Kids-category app.

Google: App category **Sports**, target groups **9–12, 13–15, 16–17, 18+**, app access **some functionality restricted**, advertising ID **No** based on inspected release. Complete IARC sporting competition and user-content questions honestly; do not classify sporting scores as gambling. Health/fitness data classification is not itself a claim the product gives medical advice. For the separate Health Apps form, recommend **Activity and Fitness** only: the app records physical sporting activity and performance. Google's [form guidance](https://support.google.com/googleplay/android-developer/answer/14738291) includes recording physical activities in that category. No diagnosis, medical treatment, research or Health Connect access is provided. Explain competition scoring in the review notes rather than selecting medical categories.

### Sponsorship classification confirmed by the owner

`routes/meets.js:846+` and `SponsorRotation.vue:145+` support rotating uploaded logos and outbound promotional links. `MeetView.vue` shows “Powered by”. No ad-network SDK or targeting was found. Google specifically distinguishes its Contains ads label from other commercial content, including product placement ([review preparation guidance](https://support.google.com/googleplay/android-developer/answer/9859455)). Pure event-sponsor attribution may fit that distinction; clickable rotating promotional inventory may instead be display advertising. The owner confirmed these are meet acknowledgements, not paid advertising placements. On that operational fact, **No** is the proposed ads answer. Record that limitation: adding promotional inventory or paid placements requires reassessment. Child-audience content safeguards remain necessary, including for commercial content outside the badge definition. The policy should explain the acknowledgements without implying user targeting or an ad network.

## Concrete 9+ readiness gaps and smallest remediation

The [Google Families policy](https://support.google.com/googleplay/android-developer/answer/9893335) applies to a mixed audience including children and covers SDK use, child data, social features and commercial content. [Apple review rules](https://developer.apple.com/app-store/review/guidelines/) require appropriate child-data handling, review access and user-content safeguards. These are preparation gaps established by code, not a claim that every listed technical mechanism is mandated in every jurisdiction.

1. **Account consent (confirmed missing by owner):** signup posts name, email, password, country and role without age/guardian consent state. Implement age-appropriate signup and an auditable parent-authorisation process before child personal data is published or optional provider collection starts. Preserve adult access. Existing guardian approval is for payments and cannot silently become this consent record. Specify jurisdiction/age rules for the requested worldwide audience; a checkbox asserting parental involvement alone does not establish verification.
2. **Public child results:** full names, sporting history and profiles become public, with permanent named records after deletion. Provide explicit parent/organiser authorisation, limited child-profile visibility and a practical safeguarding/removal path. Revisit retention for child accounts and accounts without historical entries; the current redaction keeps full name/org/club even for a noncompetitor.
3. **Content/sponsors:** smallest bounded initial mobile policy is to suppress external promotional sponsor images/links for child and unknown-age users until content review and appropriate adult controls exist. If sponsor acknowledgements remain, constrain them to reviewed first-party assets and approved child-appropriate destinations. Role gating and image MIME checks do not review image content. Add accessible reporting and operator removal/suspension workflow; assess child-facing free-text sharing rather than assuming no social risk because there is no chat.
4. **Providers:** verify APNs/FCM, Cloudflare and any external asset terms/data flows for the intended audience. Avoid loading unapproved services for children/unknown-age users; establish any required neutral age/adult controls. Existing notification opt-in and generic lock-screen payloads are useful but insufficient evidence of the full child-data process.
5. **Public support/deletion:** add real public pages as below, then verify them from a fresh browser without login. Update policy text to describe the implemented child process and sponsor operation only after they exist.

This audit does not implement a child-consent process. Public support/deletion pages were subsequently added as preparation. No child accounts were created; the operator subsequently authorised the isolated adult review fixture described below.

## Public URLs and account deletion

Read-only live checks on 12 October 2026:

- `/api/public-config`: 200, support email above.
- `/api/features`: payments=false, classes=false, signups=true, maintenance=false.
- `/privacy`: correctly rendered policy, last updated 8 October 2026.
- `/support` and `/delete-account`: generic SPA 200 then redirect to `/`; **not valid task-specific pages**.
- Policy has heading IDs `7-deleting-your-account` and `13-contact`. A fresh `/privacy#7-deleting-your-account` load stayed at scrollY=0 with the relevant heading about 7,954px below the viewport. Do not use that anchor as a reliably prominent deletion entry point yet.

Google permits a prominent policy section with a working email request path instead of a bespoke deletion form ([account deletion guidance](https://support.google.com/googleplay/android-developer/answer/13327111)). The current policy's contact section accepts deletion requests, but cold-load anchor behaviour and scattered instructions make a dedicated page the simpler reliable fix.

Implemented locally, pending deployment: `/support`: public DivingHQ heading, `mailto:support@divinghq.app`, help guide, notification-settings guidance, privacy and account-deletion links. `/delete-account`: public app/developer identity, direct **Request account deletion** email link with subject, browser self-service link, necessary identity check, expected response time, what is removed/retained and why, backup expiry (about five weeks), 30-day security/audit retention, and last-federation-admin support path. Email may initiate the request; never demand the password in an email. Follow existing legal-page layout/router title/sitemap conventions; translate UI chrome if adding keys.

Deletion implementation is `POST /api/users/me/delete` in `routes/users.js:674+`: password check, role handover safeguard, redacted login/contact/settings, revoked authority/relationships and disabled native delivery, token-version invalidation. Native device rows are not removed by this handler; account/session checks stop delivery. The privacy policy has been corrected locally to disclose these retained records and the absence of an automatic purge schedule. Sporting name/history remains. Do not describe this as “all data immediately erased”. Confirm a retained named sporting record is justified for each applicable situation before wider distribution, especially children; policy disclosure alone does not establish a legal retention entitlement.

## Reviewer access and verification

The owner authorised a retained production review fixture. The Apple preparation agent created and extended a fixture of 14 fictional adult accounts in an isolated TST organisation, including scoped organisation-administrator and referee roles, two Upcoming events and one Completed rehearsal event with 60 scores. The fixture is excluded from public listing. Production HTTPS checks verified logins and own-resource reads with 200 and global/foreign-organisation gates with 403. No account has system-administrator authority. A separate local role trial passed 49 adversarial boundary checks; its exact 14 users and claim were removed and foreign data remained unchanged. Evidence is in `review-fixture/production-role-verification.json`, `production-role-extension.json`, `role-trial-boundaries.json` and `role-trial-cleanup-verified.json` under the external release directory.

The dedicated manager may activate the fixture's two Upcoming events for judge review. No events were preseeded Live. Keep completed results available for review and avoid leaving live fixture competitions active outside the review scenario. Reviewer instructions must explain which account manages setup and which accounts judge or view results; assign no owner/sysadmin credentials or real sporting data. A separate disposable fixture account is appropriate for destructive account-deletion review.

Credentials belong only in approved private storage and store reviewer-access fields, never this document or Git. The fixture should remain available throughout review, with a scoped cleanup plan covering all its tables after review. These role checks establish their tested access boundaries; they do not substitute for physical-device judging, background delivery or complete store-review acceptance.

Store forms remain drafts while consent, content, rating and complete workflow-access gaps are resolved; this document itself is not submission approval.

## Verification finding corrected during preparation

The full local browser suite exposed a notification race: after emitting a socket alert, dispatch completion could overwrite a fast acknowledgement with `sent`. The same unconditional update could restore an expired sign-off notice or overwrite a native test notification acknowledgement. All five delivery rollups now preserve `acknowledged` and `expired` atomically. Provider outcome accounting and ordinary pending/sent/failed transitions remain unchanged. A deterministic PostgreSQL regression interleaves acknowledgement/retirement before completion across socket-only, no-subscription, provider success/failure and native test delivery paths; delivery providers are mocked and fixtures roll back. Independent review found no outstanding issues. Full final CI evidence belongs in the external release verification manifest; do not infer a green gate from this description alone.


## Saved distribution console state

The Google production draft targets all 177 countries/regions plus Rest of world. The console enables creating a production release and shows no 12-tester/14-day access gate in this session; that observation is not a guarantee of eligibility or review approval. Sports category, Activity and Fitness health declaration, privacy, no-ads answer and listing are staged. Listing evidence includes the existing icon, four authentic phone and four authentic tablet screenshots (in both tablet-size slots) and a feature graphic. The operator labelled only the agent-authored feature graphic for the console's AI-asset declaration; screenshots and original icon were not relabelled.

**Managed publishing remains OFF.** Attempting to enable it produced “You can't turn on managed publishing at the moment” without an explanation. No release or changes have been sent for review. Treat review submission as a potential automatic-publication step after approval until this setting can be enabled and verified; keep the release on hold for the unresolved 9+ consent/content/rating requirements. Evidence is in the external release verification directory: `play-publishing-staged.png`, `play-managed-publishing-unavailable.png`, `play-listing-saved.png`, `play-health-saved.png` and `play-data-safety-draft-final.png`.


The completed Google IARC questionnaire (12 October 2026) calculated regional ratings above the intended minimum 9: Brazil 12+ (language), ESRB Teen (diverse-content discretion), PEGI Parental Guidance, Germany 16+ (increased communication risks), and generic/Russia/Korea 12+. Those are console outputs for the truthful content answers, not proof of authored mature content. No app release was sent for review. Do not lower factual UGC answers to obtain a younger rating; resolve the product safeguards/classification and minimum-age conflict before distribution.

Further deterministic verification found a separate inbox-startup gap: an alert sent after the initial HTTP inbox read but before the socket connects was never recovered. Initial connection and reconnection now refresh the usual latest-20 inbox before rechecking sign-off requests. This does not promise replay of an unlimited backlog. Active reads exclude locally removed notices so stale HTTP responses cannot undo an acknowledgement; account changes cancel old reads, and the next fresh read can recover an acknowledgement that failed. Explicit reopening of a still-pending acknowledged sign-off remains available. The browser regression controls the handshake ordering and reproduced the original failure without sleeps or longer assertions. Independent review approved the bounded change; final full CI subsequently passed as recorded below.


The Google target-audience form now explicitly blocks the required 9–12 group: “You can’t select age groups below 13 because your app ESRB rating is teenager or higher.” The 9–12 option is disabled. No older-only audience was substituted. This prevents completing the intended audience declaration and the dependent final Data safety submission. Five reviewer credential/instruction sets were saved; optional trusted-partner device testing was switched off. Evidence: `play-target-age-blocked.png` and `play-review-access-saved.png`. Completing the IARC questionnaire is separate from sending an app release for review.


Apple's actual console age summary is 13+ in 172 countries, with local 12+ ratings in Vietnam, Korea and Brazil and legacy global 12+. This also conflicts with intended direct age-9 use. iPhone/iPad distribution remains the target; Mac and Vision availability were saved OFF. Existing free/paid agreements and DSA compliance were shown active (including the identified trader for 27 countries); no agreement or trader declaration was changed in this preparation. Apple privacy's 12 data-type details are saved as an unpublished draft. At this point its version validator reports only the not-yet-live support URL and missing build 4; validation success would still not remove child-audience readiness or publication holds.


Google's XR form factor remains active on the mobile track; its Advanced settings page exposed no off toggle. Device-catalogue inspection required separate terms, so the optional inspection was cancelled without acceptance or exclusions. Compatible mobile apps may be discoverable on XR under Google's [distribution guidance](https://developer.android.com/develop/xr/package-and-distribute). Do not describe Google availability as phone/tablet-exclusive or claim XR testing. This optional form-factor check did not change the release or the child's audience declaration.


A Google production release draft named **1.2 (4)** was created and its release notes saved despite the audience prerequisite block. Its bundle has not yet been uploaded; no Next/review/send action was taken. Attaching a verified AAB to this draft is separate from submitting it for review or publishing it. The production draft does not resolve the disabled 9–12 audience choice.


A separate browser-test synchronisation defect was reproduced by holding the actual background-release WebSocket frame. The Control Room correctly fences local progression immediately, before the server finishes releasing ownership; a competing same-account claim may consequently return `control_conflict`. Forwarding the held release allowed the next claim in 113 ms. The lifecycle test now waits at most five seconds for that specific same-user conflict to clear, never requests takeover, fails every other error immediately, and asserts the granted event, token and lease. The normal 30-second lease cannot expire within this wait. This is a test-only correction with no change to control-room runtime behaviour. Independent review and ten repeated phone/tablet cases passed; the final full browser gate is recorded separately.


Both native build-4 packages are signed and locally verified. Final source CI passed; upload awaits the verified commit. Package and source-hash evidence: `/Volumes/Storage/DivingHQ-releases/1.2-4/package-verification.json` and `prebuild-source-manifest.json`; artifacts are `ios/App.ipa` and `DivingHQ-1.2-4.aab`. No runtime change was needed for the final control-test synchronisation correction, so those package source hashes remain applicable.


## Final local verification gate

Lint and production web build passed. All **1,629 Node tests** passed with zero failures or skips, including real PostgreSQL integration tests. The final complete browser run passed **458/458 tests** across configured projects with zero failures, skips or retries. Successful lint/build/Node evidence was retained across the final test-only control-release correction; the complete browser suite was then rerun against that corrected test. Every runtime/package source file remains byte-identical to the signed native build-4 manifest.

The external `verification/verification-summary.json` records exact file SHA-256 values, tracked diff hash, test counts, independent reviews and earlier failed-run/reproduction evidence. `ci-recovered.json` holds the successful lint/build/Node stages; `e2e-final-gate.json` and `.log` hold the final all-green browser result. Tests used only the guarded local `divinghq_distribution_test` database, with mail/push provider credentials blank. This verification does not remove the child-audience/store-rating holds, establish physical-device acceptance or publish either store release.


## Owner audience decision — 13 October 2026

The owner changed the intended direct-use audience to **13 and older only**. This supersedes the earlier minimum-age-nine launch decision above; the historical store evidence is retained. Select Google age groups 13–15, 16–17 and 18+, without under-13 groups. Regional content ratings remain the stores’ classifications and may be higher than 13; do not lower truthful content answers to force a rating.

The shared website/native signup forms require an unchecked 13+ declaration and both public registration APIs require literal boolean `age_13_or_older: true`. Missing declarations (including build 4’s old signup form) fail closed with instructions to update the app or register on the website. No new date-of-birth field is collected for signup. Known under-13 dates of birth prevent session issuance and invalidate authenticated HTTP/socket access through the existing auth-state gate. Date-of-birth changes revoke existing sessions. Unknown dates of birth are not treated as verified ages. Adult-managed junior competition records and public results are retained.

**Release dependency:** staged native build 1.2 (4) predates this change and must be replaced with a newly built and tested bundle before public submission. This source change does not prove deployment or store submission. Physical-device acceptance must cover the replacement build.

**Owner notice decision — 13 October 2026:** the owner explicitly instructed, “no, don’t send any notice”. No notice emails will be sent. This supersedes the earlier notice-approval activation hold: activate the 13+ changes after the required verification passes, following the owner’s direction. The existing published privacy policy promises advance email notice for material changes; the owner’s instruction does not establish that users were notified or remove that policy discrepancy. The prepared notice draft and policy attachments remain historical, unsent evidence. Actual policy text and attachments are unchanged by this audit update.

The age decision removes the planned under-13 direct-use audience. It does not verify users’ ages, establish parental consent for teenagers or junior competition records, resolve worldwide legal requirements, or resolve the separate provider-retention/privacy disclosure questions. Google Data Safety and Apple privacy drafts must still match the final implementation before submission.

## Junior profiles — 13 October 2026 (after build 6)

The server now has **junior profiles** (migration 107, `lib/juniors.js`): a parent, coach or club admin can add a diver under 13, who never signs in. Direct use stays 13+, so the store audience decision above stands, but both store forms need a second look before submission because the service now holds data **about** under-13s, entered by adults:

- Data types: name, date of birth, gender, club and competition results for the child, plus who added the profile and who confirmed a parent agreed. No contact details, credentials, photos or device identifiers for the child.
- Where it shows: results are public like any diver's; the child's profile page and diver search are limited to linked parents, coaches and the club, region and federation admins.
- Notifications for the child are delivered to the linked parents' devices, not the child's (the child has none).
- At 13 the profile is handed over by an emailed one-time link and becomes an ordinary account.

Check Google's Data Safety answers and the Families policy, and Apple's privacy label, against this before submitting. Nothing here was changed in either store console. The bundled privacy policy (§9) and terms describe junior profiles from this change on.

## Current prepared release — 13 October 2026

This section supersedes the historical draft/upload statuses above. Native **1.2 (5)** replaces build 4 for the 13+ direct-use change: the signed packages have been uploaded and attached in both store drafts. Google targets **13–15, 16–17 and 18+**; Apple uses the corresponding 13+ direct-use audience while retaining regional content ratings. Neither store app has been submitted for review or public release.

Google's **14-type Data Safety declaration is saved**, with all **11 changes staged** in Publishing overview. Managed publishing remains off. Apple's **12-type privacy disclosure has been published and its receipt verified**; publishing the privacy label does not submit the app. Production inventory included private meets and found no nonempty legacy sponsor-image URLs or automatic off-origin logo hosts. These observations support the prepared disclosures without proving future sponsor configurations or all third-party retention behaviour.

Final local verification passed lint and production web build, **1,636/1,636 Node tests** and **458/458 browser tests**, with no test failures, skips or flaky retries in the final runs. Earlier fixture/assertion and cleanup failures remain recorded in the external evidence. The narrowly scoped queue teardown correction passed independent review, five deterministic error-handling checks and 20 repeated browser cases. All runtime, native and bundled policy inputs match signed build 5; only this nonbundled audit document and the reviewed test corrections differ from the original build snapshot.

The owner's **no-email instruction remains in force**. No notice email was sent; the prepared campaign is permanently cancelled and its sender blocks execution. This does not claim that existing account holders received advance notice. No production activation is claimed by this preparation record: the exact committed source, normal deployment result and anonymous live checks are recorded separately in `/Volumes/Storage/DivingHQ-releases/age13-2026-10-13/`. Physical-device acceptance of build 5 remains outstanding and is not established by previous build testing or store draft acceptance.
