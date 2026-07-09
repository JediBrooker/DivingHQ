#!/usr/bin/env node
//
// Generate a VAPID key pair for the Web Push backend.
//
//   node scripts/generate-vapid-keys.js
//
// Prints a .env-ready snippet:
//
//   VAPID_PUBLIC_KEY=...
//   VAPID_PRIVATE_KEY=...
//   VAPID_SUBJECT=mailto:ops@example.com
//
// Run this once per deployment environment and paste the output into
// the host's .env. The same keys need to persist for the lifetime of
// the deployment: rotating them invalidates every existing browser
// subscription, so every user would have to grant push permission
// again. Worth double-checking you're not overwriting a live key pair.
//
// VAPID_SUBJECT is just the contact the push service uses to reach you
// if your sender misbehaves. mailto: or https: scheme works; the email
// address doesn't actually have to be valid for delivery.

const webpush = require("web-push");

const keys = webpush.generateVAPIDKeys();
const subject = process.env.VAPID_SUBJECT || "mailto:ops@example.com";

console.log("# VAPID keys for the Web Push backend.");
console.log("# Persist these for the deployment's lifetime — rotating");
console.log("# invalidates every existing browser subscription.");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`VAPID_SUBJECT=${subject}`);
