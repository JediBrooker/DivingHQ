<script setup>
import { onMounted } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LocaleSwitcher from '@/components/LocaleSwitcher.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import LogoMark from '@/components/LogoMark.vue'
import { CircleHelp } from '@lucide/vue'

const router = useRouter()
const auth = useAuthStore()

onMounted(() => {
  if (auth.isLoggedIn) router.push('/dashboard')
})
</script>

<template>
  <div class="lp">
    <!-- Top nav -->
    <nav class="nav">
      <div class="nav-in">
        <RouterLink to="/" class="brand">
          <LogoMark :size="28" />
          <span class="wm">DIVING<span>HQ</span></span>
        </RouterLink>
        <div class="nav-right">
          <ThemeToggle compact />
          <RouterLink to="/guide" class="nav-help" aria-label="Help & user guide" v-tip:bottom="'Help & user guide'"><CircleHelp /></RouterLink>
          <LocaleSwitcher />
          <RouterLink to="/login" class="btn btn-ghost btn-sm">{{ $t('home.hero.btn_sign_in') }}</RouterLink>
          <RouterLink to="/register" class="btn btn-primary btn-sm">{{ $t('home.hero.btn_create_account') }}</RouterLink>
        </div>
      </div>
    </nav>

    <!-- Hero -->
    <header class="hero">
      <div class="eyebrow">{{ $t('home.hero.mark') }}</div>
      <h1 class="hero-logo">DIVING<span>HQ</span></h1>
      <p class="lede">{{ $t('home.hero.tagline') }}</p>
      <div class="hero-cta">
        <RouterLink to="/login" class="btn btn-primary btn-lg">{{ $t('home.hero.btn_sign_in') }}</RouterLink>
        <RouterLink to="/register" class="btn btn-ghost btn-lg">{{ $t('home.hero.btn_create_account') }}</RouterLink>
        <RouterLink to="/scoreboard" class="btn btn-ghost btn-lg">{{ $t('home.hero.btn_scoreboard') }}</RouterLink>
        <RouterLink to="/judges" class="btn btn-ghost btn-lg">{{ $t('home.hero.btn_judge_analysis') }}</RouterLink>
      </div>
      <RouterLink to="/guide" class="hero-guide-link">{{ $t('home.hero.guide_link') }}</RouterLink>

      <!-- Product-preview mock (decorative) -->
      <div class="preview" aria-hidden="true">
        <div class="pf-bar"><span class="pf-dot"></span><span class="pf-dot"></span><span class="pf-dot"></span></div>
        <div class="pf-body">
          <div class="pf-side">
            <div class="pf-item on">Dashboard</div>
            <div class="pf-item">Meets &amp; events</div>
            <div class="pf-item">Control Room</div>
            <div class="pf-item">User Manager</div>
            <div class="pf-item">Audit Log</div>
          </div>
          <div class="pf-main">
            <div class="pf-stats">
              <div class="pf-stat"><div class="l">Active meets</div><div class="v">3</div></div>
              <div class="pf-stat"><div class="l">Members</div><div class="v">248</div></div>
              <div class="pf-stat"><div class="l">Live now</div><div class="v">1</div></div>
            </div>
            <div class="pf-table">
              <div class="pf-tr head"><span>Meet</span><span>Status</span><span>Divers</span></div>
              <div class="pf-tr"><span>Women 3m Springboard — Final</span><span class="pf-badge live">Live</span><span class="mono">15</span></div>
              <div class="pf-tr"><span>2026 National Championships</span><span class="pf-badge warn">Upcoming</span><span class="mono">32</span></div>
              <div class="pf-tr"><span>2025 Winter Cup — 5m Platform</span><span class="pf-badge ok">Completed</span><span class="mono">18</span></div>
            </div>
          </div>
        </div>
      </div>
    </header>

    <!-- Live strip -->
    <div class="live-strip">
      <span class="live-pill">{{ $t('home.live_strip.pill') }}</span>
      <span class="live-text">{{ $t('home.live_strip.text') }}</span>
      <RouterLink to="/scoreboard" class="btn btn-ghost btn-sm">{{ $t('home.live_strip.watch') }}</RouterLink>
    </div>

    <!-- Features -->
    <section class="section">
      <div class="section-label">{{ $t('home.features.section_label') }}</div>
      <div class="feature-grid">

        <div class="feat">
          <div class="fic">
            <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
          </div>
          <div class="feat-title">{{ $t('home.features.diver_portal_title') }}</div>
          <div class="feat-desc">{{ $t('home.features.diver_portal_desc') }}</div>
          <div class="feat-tags">
            <span class="feat-tag" style="color:var(--role-diver-fg);background:var(--role-diver-bg)"><span class="d"></span>{{ $t('role.diver') }}</span>
          </div>
        </div>

        <div class="feat">
          <div class="fic">
            <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
          </div>
          <div class="feat-title">{{ $t('home.features.control_room_title') }}</div>
          <div class="feat-desc">{{ $t('home.features.control_room_desc') }}</div>
          <div class="feat-tags">
            <span class="feat-tag" style="color:var(--role-referee-fg);background:var(--role-referee-bg)"><span class="d"></span>{{ $t('role.referee') }}</span>
            <span class="feat-tag" style="color:var(--role-manager-fg);background:var(--role-manager-bg)"><span class="d"></span>{{ $t('role.manager') }}</span>
          </div>
        </div>

        <div class="feat">
          <div class="fic">
            <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z"/></svg>
          </div>
          <div class="feat-title">{{ $t('home.features.judge_terminal_title') }}</div>
          <div class="feat-desc">{{ $t('home.features.judge_terminal_desc') }}</div>
          <div class="feat-tags">
            <span class="feat-tag" style="color:var(--role-judge-fg);background:var(--role-judge-bg)"><span class="d"></span>{{ $t('role.judge') }}</span>
          </div>
        </div>

        <div class="feat">
          <div class="fic">
            <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
          </div>
          <div class="feat-title">{{ $t('home.features.scoreboard_title') }}</div>
          <div class="feat-desc">{{ $t('home.features.scoreboard_desc') }}</div>
          <div class="feat-tags">
            <span class="feat-tag" style="color:var(--role-spectator-fg);background:var(--role-spectator-bg)"><span class="d"></span>{{ $t('role.public') }}</span>
          </div>
        </div>

        <div class="feat">
          <div class="fic">
            <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
          </div>
          <div class="feat-title">{{ $t('home.features.meet_manager_title') }}</div>
          <div class="feat-desc">{{ $t('home.features.meet_manager_desc') }}</div>
          <div class="feat-tags">
            <span class="feat-tag" style="color:var(--role-manager-fg);background:var(--role-manager-bg)"><span class="d"></span>{{ $t('role.manager') }}</span>
            <span class="feat-tag" style="color:var(--role-admin-fg);background:var(--role-admin-bg)"><span class="d"></span>{{ $t('role.admin') }}</span>
          </div>
        </div>

        <div class="feat">
          <div class="fic">
            <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
          </div>
          <div class="feat-title">{{ $t('home.features.user_manager_title') }}</div>
          <div class="feat-desc">{{ $t('home.features.user_manager_desc') }}</div>
          <div class="feat-tags">
            <span class="feat-tag" style="color:var(--role-admin-fg);background:var(--role-admin-bg)"><span class="d"></span>{{ $t('role.admin') }}</span>
          </div>
        </div>

      </div>
    </section>

    <!-- How it works -->
    <section class="section how">
      <div class="section-label">{{ $t('home.how.section_label') }}</div>
      <div class="how-steps">
        <div class="how-step">
          <div class="step-num">01</div>
          <div class="step-title">{{ $t('home.how.step01_title') }}</div>
          <div class="step-desc">{{ $t('home.how.step01_desc') }}</div>
        </div>
        <div class="how-step">
          <div class="step-num">02</div>
          <div class="step-title">{{ $t('home.how.step02_title') }}</div>
          <div class="step-desc">{{ $t('home.how.step02_desc') }}</div>
        </div>
        <div class="how-step">
          <div class="step-num">03</div>
          <div class="step-title">{{ $t('home.how.step03_title') }}</div>
          <div class="step-desc">{{ $t('home.how.step03_desc') }}</div>
        </div>
        <div class="how-step">
          <div class="step-num">04</div>
          <div class="step-title">{{ $t('home.how.step04_title') }}</div>
          <div class="step-desc">{{ $t('home.how.step04_desc') }}</div>
        </div>
      </div>
    </section>

    <!-- Footer -->
    <footer class="site-footer">
      <div class="footer-in">
        <RouterLink to="/" class="brand">
          <LogoMark :size="24" />
          <span class="wm">DIVING<span>HQ</span></span>
        </RouterLink>
        <div class="footer-links">
          <RouterLink to="/login">{{ $t('home.footer.sign_in') }}</RouterLink>
          <RouterLink to="/register">{{ $t('home.footer.register') }}</RouterLink>
          <RouterLink to="/register-org">{{ $t('home.footer.register_federation') }}</RouterLink>
          <RouterLink to="/scoreboard">{{ $t('home.footer.scoreboard') }}</RouterLink>
          <RouterLink to="/guide">{{ $t('home.footer.user_guide') }}</RouterLink>
          <a href="https://github.com/JediBrooker/DivingHQ/issues/new?labels=bug&amp;title=Bug%3A%20"
             target="_blank" rel="noopener" class="footer-bug">{{ $t('home.footer.report_bug') }}</a>
        </div>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.lp { min-height: 100dvh; background: var(--bg); }

/* ── Top nav ── */
.nav {
  position: sticky; top: 0; z-index: 50;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.nav-in {
  max-width: 1200px; margin: 0 auto;
  height: 60px; display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; padding: 0 1.5rem;
}
.brand { display: flex; align-items: center; gap: 10px; text-decoration: none; }
.brand img { display: block; }
.brand .wm { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; color: var(--fg); }
.brand .wm span { color: var(--accent); }
.nav-right { display: flex; align-items: center; gap: 0.6rem; }
.nav-help {
  width: 34px; height: 34px; display: inline-grid; place-items: center;
  border-radius: var(--radius); border: 1px solid var(--border);
  background: var(--surface); color: var(--fg-2);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.nav-help:hover { background: var(--surface-hover); color: var(--fg); }
.nav-help :deep(svg) { width: 18px; height: 18px; }
@media (max-width: 640px) {
  /* Nav CTAs are redundant with the hero CTAs on small screens, so
     drop them here so the brand + theme + locale never overflow. */
  .nav-right .btn { display: none; }
}

/* ── Hero ── */
.hero {
  max-width: 1000px; margin: 0 auto;
  padding: 4.5rem 1.5rem 3rem;
  text-align: center;
}
.eyebrow {
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--accent); margin-bottom: 1rem;
}
.hero-logo {
  font-family: var(--font-sans);
  font-size: clamp(44px, 9vw, 84px);
  font-weight: 700; font-style: normal;
  letter-spacing: -0.03em; line-height: 1;
  color: var(--fg); margin: 0 0 1.25rem;
}
.hero-logo span { color: var(--accent); }
.lede {
  font-size: clamp(15px, 2vw, 18px); line-height: 1.6;
  color: var(--fg-2); max-width: 620px; margin: 0 auto 2rem;
}
.hero-cta { display: flex; gap: 0.7rem; flex-wrap: wrap; justify-content: center; }
.btn-lg { padding: 0.7rem 1.4rem; font-size: 14px; }
.hero-guide-link {
  display: inline-block; margin-top: 1.25rem;
  font-size: 13px; color: var(--fg-2); text-decoration: none;
  border-bottom: 1px dashed transparent; transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.hero-guide-link:hover { color: var(--accent); border-bottom-color: var(--accent); }

/* ── Product-preview mock ── */
.preview {
  max-width: 880px; margin: 2.75rem auto 0;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-xl); box-shadow: var(--shadow-lg);
  overflow: hidden; text-align: left;
}
.pf-bar { height: 38px; display: flex; align-items: center; gap: 7px; padding: 0 14px;
  background: var(--surface-2); border-bottom: 1px solid var(--border); }
.pf-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--border-2); }
.pf-body { display: grid; grid-template-columns: 176px 1fr; min-height: 250px; }
.pf-side { border-right: 1px solid var(--border); padding: 12px; display: flex; flex-direction: column; gap: 3px; }
.pf-item { font-size: 12.5px; color: var(--fg-2); padding: 8px 10px; border-radius: var(--radius); }
.pf-item.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.pf-main { padding: 16px; }
.pf-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
.pf-stat { border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 11px 13px; }
.pf-stat .l { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; color: var(--fg-3); }
.pf-stat .v { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 22px; color: var(--fg); margin-top: 5px; }
.pf-table { border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
.pf-tr { display: grid; grid-template-columns: 1fr 96px 60px; align-items: center; gap: 8px;
  padding: 10px 13px; border-bottom: 1px solid var(--border); font-size: 12.5px; color: var(--fg); }
.pf-tr:last-child { border-bottom: none; }
.pf-tr.head { background: var(--surface-2); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; color: var(--fg-3); }
.pf-tr .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fg-2); }
.pf-badge { justify-self: start; font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: var(--radius-pill); }
.pf-badge.live { background: var(--danger-bg); color: var(--danger-fg); }
.pf-badge.warn { background: var(--warn-bg); color: var(--warn-fg); }
.pf-badge.ok { background: var(--ok-bg); color: var(--ok-fg); }
@media (max-width: 560px) {
  .pf-side { display: none; }
  .pf-body { grid-template-columns: 1fr; }
}

/* ── Live strip ── */
.live-strip {
  background: var(--surface-2);
  border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
  padding: 0.9rem 1.5rem;
  display: flex; align-items: center; justify-content: center; gap: 1rem; flex-wrap: wrap;
}
.live-pill {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11.5px; font-weight: 600;
  padding: 0.2rem 0.6rem; border-radius: var(--radius-pill);
  background: var(--danger-bg); color: var(--danger-fg);
}
.live-pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--danger-solid); animation: pulse-red 2s infinite; }
@keyframes pulse-red { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
.live-text { font-size: 14px; font-weight: 500; color: var(--fg-2); }

/* ── Sections ── */
.section { max-width: 1200px; margin: 0 auto; padding: 4.5rem 1.5rem; }
.section-label {
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--accent); text-align: center; margin-bottom: 2.5rem;
}
.feature-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
.feat {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); box-shadow: var(--shadow-sm);
  padding: 1.5rem;
  transition: transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.feat:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); }
.fic {
  width: 40px; height: 40px; border-radius: var(--radius);
  background: var(--accent-soft); color: var(--accent);
  display: grid; place-items: center; margin-bottom: 1.1rem;
}
.feat-title { font-size: 16px; font-weight: 600; color: var(--fg); margin-bottom: 0.4rem; }
.feat-desc { font-size: 13px; color: var(--fg-2); line-height: 1.6; margin-bottom: 1.1rem; }
.feat-tags { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.feat-tag {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; font-weight: 600;
  padding: 0.15rem 0.55rem; border-radius: var(--radius-pill);
}
.feat-tag .d { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

/* ── How it works ── */
.how { max-width: 1000px; }
.how-steps { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 1.5rem; }
.how-step { display: flex; flex-direction: column; }
.step-num {
  width: 38px; height: 38px; border-radius: var(--radius);
  background: var(--accent-soft); color: var(--accent);
  font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 15px; font-weight: 500;
  display: grid; place-items: center; margin-bottom: 0.9rem;
}
.step-title { font-size: 15px; font-weight: 600; color: var(--fg); margin-bottom: 0.4rem; }
.step-desc { font-size: 13px; color: var(--fg-2); line-height: 1.6; }

/* ── Footer ── */
.site-footer { border-top: 1px solid var(--border); padding: 2rem 1.5rem; background: var(--surface); }
.footer-in {
  max-width: 1200px; margin: 0 auto;
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem;
}
.footer-links { display: flex; gap: 1.25rem; flex-wrap: wrap; }
.footer-links a {
  font-size: 13px; font-weight: 500; color: var(--fg-2); text-decoration: none;
  transition: color var(--dur) var(--ease);
}
.footer-links a:hover { color: var(--accent); }

@media (max-width: 720px) {
  .nav-in { padding: 0 1rem; }
  .hero { padding: 3rem 1rem 2rem; }
  .section { padding: 3rem 1rem; }
  .feature-grid { grid-template-columns: 1fr; }
}
</style>
