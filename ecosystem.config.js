// PM2 ecosystem file. Committed so the deploy box doesn't have to
// remember the right `pm2 start` incantation, anyone with the
// repo can `pm2 start ecosystem.config.js` and get the canonical
// setup. deploy.sh restarts the process by name, so the value of
// `name` here MUST match deploy.sh's PM2_PROCESS_NAME.
//
// Bring it up the first time on a fresh box:
//
//     pm2 start ecosystem.config.js
//     pm2 save                            # persist the process list
//     pm2 startup                         # generate the boot-time hook
//     # …run the command pm2 prints…     # registers it with systemd
//
//     # One-time log rotation. PM2 keeps appending to the log
//     # file forever by default; this keeps the last 7 rotations
//     # of 10MB each (~70MB max) so the disk doesnt slowly fill.
//     pm2 install pm2-logrotate
//     pm2 set pm2-logrotate:max_size 10M
//     pm2 set pm2-logrotate:retain 7
//
// Subsequent deploys go through deploy.sh, which calls
// `pm2 restart dive-recorder`.
//
// IMPORTANT: no clustering.
//
// PM2 supports `instances: max` to fork one process per CPU. We
// run a single instance for two reasons that BOTH need fixing
// before clustering would work:
//
//   1. Socket.IO. `io.emit` only reaches sockets connected to
//      the same node process. Clustering would scatter judges,
//      controllers and spectators across workers and the
//      scoreboard would silently desync. The fix is the Redis
//      or `@socket.io/cluster-adapter` adapter, and neither is
//      currently wired up.
//
//   2. In-memory state. `activeDivers` and `meetHolds` in
//      server.js are plain Maps. Clustering would split-brain
//      these, half the judges seeing one active diver, the
//      other half seeing the previous one. Either move them to
//      Redis or accept that this app is a single-instance
//      design.
//
// 95% of meets fit comfortably on one Node process anyway, so
// "fix this when you actually need to" is the right answer
// (note to self: revisit if we ever run multi-venue on one box).
module.exports = {
  apps: [
    {
      name: "dive-recorder",
      script: "server.js",

      // Single fork process, see top-of-file comment for why.
      exec_mode: "fork",
      instances: 1,

      // Restart on crash. The 1500ms delay throttles a tight
      // crash loop from eating CPU.
      autorestart: true,
      restart_delay: 1500,

      // Memory ceiling. If the process drifts past this (likely
      // a leak somewhere), PM2 restarts it before it OOMs the
      // box. Adjust if you legitimately need more headroom.
      max_memory_restart: "512M",

      // Where to write the per-process logs. PM2's default
      // ~/.pm2/logs/<name>-out.log is fine for a single-app box;
      // set explicit paths if you want them somewhere else.
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-err.log",
      // Combine stdout + stderr into one stream and tag each
      // line with a timestamp so log files are useful when
      // grepped without context.
      merge_logs: true,
      time: true,

      // node-args / env. NODE_ENV stays separate from the .env
      // file because Express + several libraries condition
      // behaviour on it (caching, error formatting). Everything
      // else (DB creds, JWT secret, SMTP) lives in .env and is
      // loaded by dotenv at the top of server.js.
      env: {
        NODE_ENV: "production",
      },

      // Wait this long for the process to come up before PM2
      // declares the start a failure. Cold starts on small VPSes
      // can take a few seconds; matches the 10s health-check
      // window in deploy.sh.
      listen_timeout: 10_000,
      kill_timeout: 5_000,

      // Do NOT use PM2's --watch. We deploy via deploy.sh, which
      // does an explicit restart after the build/migrate steps.
      // PM2 watching would race against deploys and (worse)
      // restart on every disk write, including log writes,
      // which is a feedback loop.
      watch: false,
    },
  ],
};
