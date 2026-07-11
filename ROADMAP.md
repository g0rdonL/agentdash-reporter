# Roadmap — agentdash-reporter

<!-- provenance: drafted with Gordon in-session 2026-07-11 -->

The public one-command client for agentdash.ink: watches local AI coding
sessions and reports status every 60s. Zero runtime dependencies (Node ≥18),
launchd service, curl | bash install. The install experience IS the product
— anything that adds a dependency or a manual step is a regression.

## Now

- [ ] R1: Claude Code session adapter — native Claude Code sessions detected
      and reported alongside Happy and Kimi Code — why: most prospective
      users run plain Claude Code, not the Happy harness.

## Next

- [ ] R2: Reporter health is self-evident — install verifies end-to-end and
      a dead/broken reporter is diagnosable from one log location documented
      in the README — why: a silently dead reporter looks like "no agents
      running" upstream.

## Later

- R3: Linux support (systemd unit) for server-hosted agents.

## Non-goals

- npm packages or any runtime dependency (zero-dep constraint is load-bearing).
- Windows support.
- Collecting session content — status metadata only, never transcripts.
