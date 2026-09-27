// src/lib/plural.js: pick the right plural key per language. DB-less,
// runs in test:safe. Also checks every counts.* base in every locale has
// all six category keys, since a missing one would silently fall back to
// "_other" and read wrong in exactly the languages nobody here speaks.
const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

let pluralCategory, translatePlural, PLURAL_CATEGORIES

before(async () => {
  ;({ pluralCategory, translatePlural, PLURAL_CATEGORIES } = await import('../src/lib/plural.js'))
})

// A tiny stand-in for vue-i18n's t / te over one flat message table.
function fakeI18n(messages) {
  const t = (key, params = {}) =>
    (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, p) => String(params[p]))
  const te = (key) => key in messages
  return { t, te }
}

test('English: one vs other', () => {
  const { t, te } = fakeI18n({ 'c.m_one': '{n} member', 'c.m_other': '{n} members' })
  assert.equal(translatePlural(t, te, 'en', 'c.m', 1), '1 member')
  assert.equal(translatePlural(t, te, 'en', 'c.m', 0), '0 members')
  assert.equal(translatePlural(t, te, 'en', 'c.m', 2), '2 members')
})

test('Russian gets its three forms', () => {
  const { t, te } = fakeI18n({
    'c.m_one': '{n} участник', 'c.m_few': '{n} участника',
    'c.m_many': '{n} участников', 'c.m_other': '{n} участника',
  })
  assert.equal(translatePlural(t, te, 'ru', 'c.m', 1), '1 участник')
  assert.equal(translatePlural(t, te, 'ru', 'c.m', 3), '3 участника')
  assert.equal(translatePlural(t, te, 'ru', 'c.m', 5), '5 участников')
  assert.equal(translatePlural(t, te, 'ru', 'c.m', 21), '21 участник')
})

test('Arabic uses zero and two', () => {
  assert.equal(pluralCategory('ar', 0), 'zero')
  assert.equal(pluralCategory('ar', 2), 'two')
  assert.equal(pluralCategory('ar', 5), 'few')
})

test('Portuguese follows Portugal, where zero is plural', () => {
  // Bare 'pt' is Brazil's rules (0 is "one"); our pt.json is European.
  assert.equal(pluralCategory('pt', 0), 'other')
  assert.equal(pluralCategory('pt', 1), 'one')
  const { t, te } = fakeI18n({ 'c.m_one': '{n} membro', 'c.m_other': '{n} membros' })
  assert.equal(translatePlural(t, te, 'pt', 'c.m', 0), '0 membros')
})

test('a missing category key falls back to _other, never a raw key', () => {
  const { t, te } = fakeI18n({ 'c.m_other': '{n} membres' })
  assert.equal(translatePlural(t, te, 'fr', 'c.m', 1), '1 membres')
})

test('extra params ride along with n', () => {
  const { t, te } = fakeI18n({ 'c.x_one': '{n} in {club}', 'c.x_other': '{n} in {club}' })
  assert.equal(translatePlural(t, te, 'en', 'c.x', 4, { club: 'Apia' }), '4 in Apia')
})

test('a bogus locale tag still answers', () => {
  assert.equal(pluralCategory('not a locale!!', 1), 'one')
  assert.equal(pluralCategory('not a locale!!', 3), 'other')
})

test('every counted string has all six category keys in every locale', () => {
  const dir = path.join(__dirname, '..', 'src', 'locales')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('server-'))
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'))
  const bases = new Set(Object.keys(en.counts || {}).map(k => k.replace(/_(zero|one|two|few|many|other)$/, '')))
  assert.ok(bases.size > 0, 'expected counts.* plural keys in en.json')
  for (const f of files) {
    const counts = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).counts || {}
    for (const base of bases) {
      for (const cat of PLURAL_CATEGORIES) {
        assert.ok(`${base}_${cat}` in counts, `${f}: counts.${base}_${cat} missing`)
      }
    }
  }
})
