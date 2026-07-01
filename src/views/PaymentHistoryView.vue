<script setup>
// A member's own payment history. Read-only list of every payment they've
// made, with CSV + PDF download. All strings are i18n ($t); the description
// and status are composed client-side from the raw fields returned by
// GET /api/me/payments so they localise (and stay reactive to locale switch).
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'
import { Download, FileText } from '@lucide/vue'

const auth = useAuthStore()
const { t, locale } = useI18n()

const loading = ref(true)
const loadError = ref(false)
const paymentsEnabled = ref(true)
const raw = ref([])

// Types we give a first-class translated label; anything else (rare/edge,
// e.g. club_affiliation, levy) degrades to a humanised subject_type.
const KNOWN_TYPES = new Set([
  'event_entry', 'late_entry', 'membership', 'meet_bundle', 'official_accreditation',
  'spectator_ticket', 'livestream', 'programme', 'donation', 'fine', 'scratch', 'no_show',
])

function humanize(s) {
  if (!s) return ''
  return String(s).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function typeLabel(subjectType) {
  return KNOWN_TYPES.has(subjectType) ? t(`payments.type_${subjectType}`) : humanize(subjectType)
}

function statusLabel(status) {
  const key = `payments.status_${status}`
  const val = t(key)
  return val === key ? humanize(status) : val
}

// Human detail per row. Free-text/user data (event, meet, fine reason) is
// shown as-is; enum fields (membership tier, official role) are humanised
// so 'meet_manager' -> 'Meet manager' rather than a raw slug.
function detailFor(p) {
  switch (p.subject_type) {
    case 'event_entry':
    case 'late_entry':
    case 'scratch':
    case 'no_show':
      return p.event_name || ''
    case 'meet_bundle':
    case 'spectator_ticket':
    case 'livestream':
    case 'programme':
      return p.meet_name || ''
    case 'membership':
      return humanize(p.membership_tier)
    case 'official_accreditation':
      return humanize(p.payer_role_type)
    case 'fine':
      return p.fine_reason || ''
    default:
      return ''
  }
}

function describe(p) {
  const label = typeLabel(p.subject_type)
  const detail = detailFor(p)
  return detail ? `${label} — ${detail}` : label
}

function money(cents, currency) {
  if (cents == null) return ''
  try {
    return new Intl.NumberFormat(locale.value, { style: 'currency', currency: currency || 'GBP' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency || ''}`.trim()
  }
}

function fmtDate(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleDateString(locale.value, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return String(ts).slice(0, 10)
  }
}

const rows = computed(() => raw.value.map((p) => ({
  id: p.id,
  status: p.status,
  dateStr: fmtDate(p.created_at),
  description: describe(p),
  amountStr: money(p.amount_cents, p.currency),
  statusText: statusLabel(p.status),
})))

const isEmpty = computed(() => !loading.value && !loadError.value && rows.value.length === 0)

async function load() {
  loading.value = true
  loadError.value = false
  try {
    const data = await auth.apiFetch('/api/me/payments')
    raw.value = Array.isArray(data?.payments) ? data.payments : []
    paymentsEnabled.value = data?.payments_enabled !== false
  } catch (e) {
    loadError.value = true
    showError(e.message || t('payments.error'))
  } finally {
    loading.value = false
  }
}

// ---- Exports ----------------------------------------------------
// Spreadsheet-formula-injection guard + RFC 4180 quoting (mirrors the
// server-side csvCell in routes/pdf.js).
function csvCell(v) {
  let s = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

function stamp() {
  return new Date().toISOString().slice(0, 10)
}

function downloadCsv() {
  const header = [t('payments.col_date'), t('payments.col_description'), t('payments.col_amount'), t('payments.col_status')]
  const lines = [header, ...rows.value.map((r) => [r.dateStr, r.description, r.amountStr, r.statusText])]
  const csv = lines.map((l) => l.map(csvCell).join(',')).join('\r\n')
  // Leading BOM so Excel reads the UTF-8 (accents / non-Latin scripts) right.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `payment-history-${stamp()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

// PDF via the browser's print pipeline: open a self-contained, already-
// translated document and trigger print (the user saves it as PDF). No extra
// dependency, and it inherits whatever language the page is in.
function downloadPdf() {
  const w = window.open('', '_blank')
  if (!w) {
    showError(t('payments.popup_blocked'))
    return
  }
  const title = t('payments.history')
  const genOn = t('payments.generated_on', { date: new Date().toLocaleString(locale.value) })
  const th = [t('payments.col_date'), t('payments.col_description'), t('payments.col_amount'), t('payments.col_status')]
  const bodyRows = rows.value
    .map((r) => `<tr><td>${esc(r.dateStr)}</td><td>${esc(r.description)}</td><td class="num">${esc(r.amountStr)}</td><td>${esc(r.statusText)}</td></tr>`)
    .join('')
  const doc = `<!doctype html><html lang="${esc(locale.value)}"><head><meta charset="utf-8">`
    + `<title>${esc(title)}</title><style>`
    + `body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;padding:28px;}`
    + `h1{font-size:20px;margin:0 0 2px;}.sub{color:#666;font-size:12px;margin:0 0 18px;}`
    + `table{width:100%;border-collapse:collapse;font-size:12.5px;}`
    + `th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top;}`
    + `thead th{background:#f3f3f3;border-bottom:1.5px solid #bbb;}td.num{text-align:right;white-space:nowrap;}`
    + `@media print{@page{margin:16mm;}}`
    + `</style></head><body><h1>${esc(title)}</h1><p class="sub">${esc(genOn)}</p>`
    + `<table><thead><tr>${th.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${bodyRows}</tbody></table>`
    + `<scr` + `ipt>window.onload=function(){setTimeout(function(){window.print();},60);};</scr` + `ipt>`
    + `</body></html>`
  w.document.open()
  w.document.write(doc)
  w.document.close()
}

onMounted(load)
</script>

<template>
  <section class="ph">
    <header class="ph-head">
      <h1>{{ t('payments.history') }}</h1>
      <p class="muted">{{ t('payments.history_subtitle') }}</p>
    </header>

    <div class="bar">
      <button class="btn ghost" :disabled="!rows.length" @click="downloadCsv">
        <Download class="ic" /> {{ t('payments.download_csv') }}
      </button>
      <button class="btn ghost" :disabled="!rows.length" @click="downloadPdf">
        <FileText class="ic" /> {{ t('payments.download_pdf') }}
      </button>
    </div>

    <p v-if="loading" class="muted pad">{{ t('common.loading') }}</p>
    <p v-else-if="loadError" class="err pad">{{ t('payments.error') }}</p>

    <template v-else-if="isEmpty">
      <p class="muted pad">{{ t('payments.empty') }}</p>
      <p v-if="!paymentsEnabled" class="muted pad small">{{ t('payments.dormant_note') }}</p>
    </template>

    <div v-else class="table-wrap">
      <table class="ptable">
        <thead>
          <tr>
            <th>{{ t('payments.col_date') }}</th>
            <th>{{ t('payments.col_description') }}</th>
            <th class="num">{{ t('payments.col_amount') }}</th>
            <th>{{ t('payments.col_status') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td class="nowrap">{{ r.dateStr }}</td>
            <td>{{ r.description }}</td>
            <td class="num nowrap">{{ r.amountStr }}</td>
            <td><span class="pill" :class="r.status">{{ r.statusText }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.ph { display: flex; flex-direction: column; gap: 1rem; max-width: 60rem; margin: 0 auto; padding: 1rem; }
.ph-head h1 { margin: 0 0 .25rem; }
.ph-head .muted { margin: 0; }
.bar { display: flex; gap: .5rem; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; gap: .4rem; padding: .45rem .8rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); color: var(--fg); cursor: pointer; font: inherit; font-size: .88rem; }
.btn:hover { background: var(--surface-hover); }
.btn:disabled { opacity: .5; cursor: default; }
.btn .ic { width: 15px; height: 15px; }
.muted { color: var(--muted); }
.err { color: var(--danger); }
.pad { padding: .5rem .25rem; }
.small { font-size: .85rem; }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-lg); }
.ptable { width: 100%; border-collapse: collapse; font-size: .9rem; }
.ptable th, .ptable td { text-align: left; padding: .55rem .7rem; border-bottom: 1px solid var(--border); }
.ptable thead th { color: var(--muted); font-weight: 600; font-size: .76rem; text-transform: uppercase; letter-spacing: .03em; background: var(--bg-2); }
.ptable tbody tr:last-child td { border-bottom: 0; }
.ptable .num { text-align: right; }
.ptable .nowrap { white-space: nowrap; }
.pill { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .75rem; text-transform: capitalize; background: var(--bg-2); color: var(--fg-2); }
.pill.paid { background: var(--accent-soft); color: var(--green); }
.pill.pending { background: var(--bg-2); color: var(--amber); }
.pill.failed { background: var(--bg-2); color: var(--danger); }
.pill.refunded, .pill.partially_refunded { background: var(--bg-2); color: var(--fg-2); }
</style>
