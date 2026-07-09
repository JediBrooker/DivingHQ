# Classes

## Overview

Classes are for regular training sessions — the things your club runs week in, week out — not competitions. Each class belongs to a single club and lives under `/classes`. The page adapts to your role: club admins get the full management surface, coaches see a read-only roster view, and divers see their own enrolments plus a browser for joining new classes.

Payments for classes go to the club (not the federation). Clubs onboard with Stripe Connect the same way federations do for meet payments — see [Setting up payouts](#setting-up-payouts) below.

## For club administrators

Club admins see two sub-tabs under the **Manage** tab: **Classes** for creating and managing classes, and **Payouts** for Stripe Connect onboarding and withdrawal settings.

![Classes management](/guide-screenshots/classes-manage.png)

### Creating a class

Open **Manage > Classes** and click **+ New Class**. Fill in the following fields:

| Field | Required | Description |
|---|---|---|
| **Name** | Yes | A short label for the class — "Junior Squad", "Learn to Dive", "Platform Training". |
| **Description** | No | A longer note visible to divers when they browse available classes. Use it for prerequisites, what to bring, or who the class is aimed at. |
| **Level** | No | Free-text tag — "Beginner", "Squad", "Elite", whatever fits your programme. Shows as a chip on the class card so divers can filter at a glance. |
| **Schedule** | No | Free text describing when the class runs — "Mon & Wed 6–7 pm", "Sat mornings". Not a calendar integration; it's a label for the diver to read. |
| **Capacity** | No | Maximum number of active enrolments. Leave blank for unlimited. When a class is full, new divers see a "Class full" badge and self-enrolment is blocked. |
| **Active** | Yes | Toggle the class on or off. Inactive classes are hidden from the diver's browse panel but stay in your list so you can reactivate them later. |

Click **Save** to create the class. You can edit or deactivate it at any time from the class list.

### Setting up pricing

A class can have zero or more **price options**. Open a class and click **+ Add Price Option**. Each option has:

- **Label** — what the diver sees: "Per term", "Monthly", "Annual".
- **Amount** — the price in your currency. Set to 0 (or leave no price options at all) for a free class.
- **Active** — toggle an option off without deleting it (useful when a term ends and you don't want new sign-ups at that price).
- **Sort order** — controls the display order when a diver is choosing.

You can offer multiple price options on the same class. For example, a squad class might have "Monthly — $60" and "Per term — $150" side by side, and the diver picks when they enrol.

### Managing the roster

The roster shows every diver enrolled in a class, grouped by status (active, pending, inactive, cancelled). From here you can:

- **Add a diver manually.** Click **+ Add Diver**, search for the diver, then optionally select a price option and enter a discount amount. A **Request payment** toggle controls whether the diver receives a payment prompt. If you leave it off (or the discount fully covers the price), the enrolment activates immediately with no Stripe checkout.
- **View enrolments.** Each row shows the diver's name, chosen price option, amount paid, discount applied, and current status.
- **Remove an enrolment.** Click the row action to cancel or refund. Refunds are processed through Stripe if the diver paid online. A diver can only have one non-cancelled enrolment per class — cancelling frees the slot for them to re-enrol later.

### Setting up payouts

Before your club can receive class payments, you need to connect a Stripe account. Open **Manage > Payouts** to start the onboarding flow. This is the same Stripe Connect process that federations use for meet payments — the platform handles the checkout, takes a 15% platform fee, and deposits the rest into your connected account.

The Payouts tab shows your current balance, withdrawal settings, and withdrawal history. For a full walkthrough of the Stripe Connect flow, see [Payments](/guide/payments).

## For coaches

Coaches see the **My club's classes** tab — a read-only list of every class the club runs, with the roster for each. You can see each diver's name and their enrolment status (pending or active), but you cannot edit classes, change prices, or manage enrolments. Use this view to check who's enrolled before a session.

![Coach class view](/guide-screenshots/classes-coach.png)

## For divers

Divers see the **My classes** tab, which has two panels:

- **Your enrolments.** Every class you're currently enrolled in, with the status, schedule, and price you selected.
- **Browse available classes.** All active classes at your club. Click a class to see its description, schedule, level, and available price options, then click **Enrol** to join.

![My classes](/guide-screenshots/classes-my-classes.png)

When you enrol in a paid class, you select a price option and complete payment through Stripe Checkout. If a discount fully covers the price, the enrolment activates immediately with no checkout step.

**Guardians** can enrol and pay on behalf of a dependent (minor). The guardian's account handles the Stripe checkout; the enrolment is linked to the dependent's diver profile.

## FAQ

**Can a class have multiple price options?**
Yes. Add as many as you need — "Monthly", "Per term", "Drop-in" — and the diver picks one when they enrol.

**Can I set a capacity limit?**
Yes, but it's optional. Set the capacity field when creating or editing a class. Once the limit is reached, self-enrolment is blocked until a spot opens up. Leave it blank for unlimited.

**Who gets the money?**
The club. Stripe processes the checkout and deposits the payment into the club's connected account, minus a 15% platform fee.

**Can guardians enrol dependents?**
Yes. A guardian can browse classes, enrol a dependent, and complete the Stripe checkout on their behalf.

**What happens if I deactivate a class?**
The class disappears from the diver browse panel, but existing enrolments are unaffected. Reactivate it any time from the Manage tab.

**Can a diver be enrolled in the same class twice?**
No. There's a one-active-enrolment-per-class constraint. A diver must cancel (or be removed from) their existing enrolment before they can re-enrol.

## See also

- [Payments](/guide/payments) — Stripe Connect onboarding, platform fees, and payout details
- [Roles & Permissions](/guide/roles-and-permissions) — who can manage classes vs. view them
- [Admin Tasks](/guide/admin-tasks) — club and user management
