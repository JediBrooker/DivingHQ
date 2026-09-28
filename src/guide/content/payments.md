# Payments

DivingHQ handles all competition-related payments through Stripe. The platform is the merchant of record: every charge lands on the platform's Stripe account, and the platform keeps a 15% fee on each transaction. Federations and clubs receive the remainder via Stripe Connect payouts to their connected bank accounts.

This page covers setup, fee configuration, paying and receiving money, fines and appeals, and the payout cycle.

## Setting up payments (org admin)

Before your organisation can collect fees or receive payouts, an org admin needs to complete Stripe onboarding.

1. Go to `/payments`. The **Overview** tab shows a four-step "How it works" explainer summarising the flow: configure fees, collect payments, platform keeps 15%, you withdraw the rest.
2. Open the **Account details** tab and click **Set up payouts**. This redirects to Stripe's hosted onboarding where you enter bank account details and complete identity verification. Bank details are held only by Stripe — DivingHQ never stores them.
3. When onboarding completes, you're redirected back to DivingHQ. The status refreshes to "Payouts are set up".
4. Open the **Fees & pricing** tab to configure what you charge (see the next section).
5. Optionally, enable **automatic withdrawals** with a threshold on the **Withdrawals** tab — for example, "withdraw when balance reaches $100".

![The Payments dashboard Overview tab, with the tab bar across the top and a step-by-step "how this works" panel](/guide-screenshots/payments-admin-overview.png)

> **Tip:** You can return to the Account details tab at any time to check your onboarding status or update details via Stripe's dashboard link.

## Fee types and configuration

Under the **Fees & pricing** tab, admins configure the fees their organisation charges. Each fee type has its own card with inline editing.

- **Membership fees** — set per tier (Standard, Junior, Senior, Masters). For each tier you choose: audience (everyone, members only, or non-members only), start and end dates, currency, refund policy, and who absorbs the 15% platform fee (the federation or the payer).
- **Club affiliation / accreditation fees** — annual fees that clubs pay to the federation for affiliation or accreditation status.
- **Official accreditation fees** — per-role fees for Judges, Referees, Coaches, and Meet Managers.
- **Event entry fees** — configured per-event from the event manager, not from the payments dashboard. Includes late-entry surcharges and scratch/no-show penalties (see [Competition entry fees](#competition-entry-fees) below).
- **Donations** — suggested donation amounts plus a custom-amount option.
- **Meet registration / bundles** — a single fee that covers all events in a meet.

![The Fees & pricing tab, showing the membership fee editor with its tier tabs, currency, fee-model and refund controls](/guide-screenshots/payments-fee-editor.png)

> **Tip:** When you set the platform fee to be absorbed by the payer, the checkout page shows the total including the fee so there are no surprises at payment time.

## Paying a fee (member view)

The payment flow is the same regardless of fee type. Here is how it works from the payer's perspective:

1. Visit the relevant page — `/membership`, `/accreditation`, `/charges`, `/donate`, or the event entry page.
2. A **FeePreviewCard** shows the resolved price. If the platform fee is passed to the payer, the total including the fee is displayed. The refund policy is shown beneath the price.
3. Click **Pay**. DivingHQ creates a Stripe Checkout Session and redirects you to Stripe's hosted payment page.
4. Complete payment on Stripe (card, Apple Pay, Google Pay — whatever Stripe supports in your region).
5. Stripe redirects you back to `/payments/return` with a confirmation message.
6. A webhook from Stripe fulfils the purchase on the backend — granting membership, activating accreditation, confirming entry, and so on.
7. Renewals are allowed within a 30-day window before your current membership or accreditation expires.

![The Membership page, one card per tier, each showing its resolved price and a Pay button](/guide-screenshots/payments-membership.png)

Donations work the same way, except the payer picks the amount. The chips come from the suggested amounts the admin configured; the box beside them takes anything else.

![The Donate page showing suggested donation amount chips alongside a custom-amount field](/guide-screenshots/payments-donate.png)

> **Note:** If you close the browser during Stripe checkout, the payment may still complete. Check your `/payment-history` page or wait for the confirmation email.

## Competition entry fees

Event managers set entry fees per-event from the event editor. Four charge types apply to competition entries:

- **Entry fee** — the standard fee to enter the event, charged at registration time.
- **Late entry surcharge** — an additional charge if the diver enters after the published deadline.
- **Scratch penalty** — charged when a diver withdraws after the roster has closed.
- **No-show penalty** — charged when a diver fails to appear for the event.

Scratch and no-show charges are issued by the event manager during or after the meet and appear on the competitor's `/charges` page. Payment uses the same Stripe Checkout flow described above.

## Guardian and dependent payments

Guardians can pay fees on behalf of minors they are linked to.

1. Visit `/guardians` ("My Dependents").
2. Search for a minor by name and send a link request.
3. An administrator approves the request.
4. Once linked, a **Paying for** dropdown appears at the top of the Membership page: *Yourself* or *[Dependent Name (age)]*.
5. Select the dependent — the price resolves for them (for example, junior-tier membership pricing).
6. At checkout, the session carries a `subject_user_id` so the server validates the guardian relationship before processing.
7. You can revoke the guardian link at any time from `/guardians`.

![The Membership page with a "Paying for" dropdown at the top, set to the linked dependent rather than to yourself](/guide-screenshots/payments-guardian-selector.png)

> **Tip:** The dependent's age determines which tier applies. If a dependent turns 18 before the membership period ends, the tier that was active at purchase time stays in effect for the remainder of that period.

## Charges, fines, and appeals

Penalties, fines, and any appeal you have lodged all land on the same page, `/charges`:

![The Charges page listing an unpaid scratch penalty, an outstanding fine with a Pay button, and a second fine marked as under appeal](/guide-screenshots/payments-charges.png)

### Penalties

Event managers issue scratch and no-show charges during or after a meet. These appear on the competitor's `/charges` page and are paid through Stripe Checkout like any other fee.

### Fines

Referees or org admins issue disciplinary fines from `/fines`:

1. Select the person to fine.
2. Enter the amount and a reason (for example, "unsportsmanlike conduct").
3. The fine appears on the fined person's `/charges` page as an outstanding balance.

The fined person pays via Stripe Checkout in the normal way.

### Appeals

If you receive a fine you believe is unjust, you can appeal it:

1. Open your `/charges` page and click **Appeal** next to the fine.
2. Enter your reason and submit. The fine's status changes to "Under appeal".
3. An org admin sees the appeal on `/fines` and can either **Uphold** the appeal (which waives the fine) or **Dismiss** it (the fine returns to owed status).
4. If you pay the fine while the appeal is pending, the payment takes effect and the appeal is closed.
5. Resolved fines — whether paid, waived, or dismissed — appear in the history section.

## Payouts

DivingHQ is the merchant of record. All charges land on the platform's Stripe account, and the platform retains a 15% fee. The remainder is owed to the federation or club that configured the fee.

- The **Withdrawals** tab shows your current balance, broken down by currency if you collect in more than one.
- Click **Withdraw now** to trigger an immediate manual withdrawal.
- Toggle **Automatic withdrawal** and set a threshold (for example, "$100") to have payouts sent automatically when your balance reaches that amount.
- Withdrawals execute as Stripe Connect transfers to your organisation's connected bank account.
- If a transfer fails (for example, due to a bank issue), the balance is restored and you can retry.
- The **Withdrawal history** table shows every payout: date, amount, status, and any notes.

> **Note:** Payout timing depends on Stripe's processing schedule for your country. Transfers typically arrive within 2-7 business days after withdrawal.

## Payment history

Every user has a personal payment ledger at `/payment-history`. It shows all payments you have made: membership fees, event entries, fines, donations, and anything else.

![The personal payment history ledger, one row per payment, with a refunded event entry among the paid rows](/guide-screenshots/payments-history.png)

- Filter by payment type or date range.
- Export the full ledger or a filtered subset to CSV or PDF.

Org admins see a separate organisation-wide ledger on the payments dashboard covering all incoming payments across every fee type.

## Payment types reference

| Type | Where to pay | Who pays |
|---|---|---|
| Membership | `/membership` | Diver (or guardian) |
| Official accreditation | `/accreditation` | Judge, Referee, Coach, Meet Manager |
| Event entry | Event page | Diver (or guardian) |
| Late entry surcharge | `/charges` | Diver |
| Meet bundle | Event page | Diver (or guardian) |
| Meet registration | Event page | Diver |
| Club affiliation | `/payments` | Club admin |
| Club accreditation | `/payments` | Club admin |
| Spectator ticket | Event page | Spectator |
| Livestream access | Event page | Spectator |
| Programme | Event page | Anyone |
| Donation | `/donate` | Anyone |
| Scratch penalty | `/charges` | Diver |
| No-show penalty | `/charges` | Diver |
| Disciplinary fine | `/charges` | Fined person |

## Next steps

- [Running a Meet](/guide/running-a-meet) — the Control Room operator guide
- [Setting Up a Meet](/guide/setting-up-a-meet) — configuring events before the day
- [Roles and Permissions](/guide/roles-and-permissions) — who can do what across the platform
- [Quick Start](/guide/quick-start) — get your first event up and running
