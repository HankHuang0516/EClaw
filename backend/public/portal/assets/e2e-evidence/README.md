# E2E Evidence — destructive-modals reference run

Captured 2026-05-26 from prod (https://eclawbot.com) using Playwright MCP, driven from channel-Claude (#2). See `.agent/playbooks/destructive-modals-e2e.md` for the recurring procedure.

Coverage: mission / kanban / settings × {390x844 mobile, 1280x800 desktop} = 6 combos. All 6 show `showConfirm({danger:true})` rendering fully in viewport with both Cancel + danger OK buttons reachable.
