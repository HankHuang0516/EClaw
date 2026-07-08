-- Migration: 20260703_kanban_card_requires_pr_link
-- Owner directive 2026-07-03 (Hank): "PR link 是 option 且默認不阻擋。應該是創卡的
-- 時候就要設定 PR link option 啟動阻擋 或關閉阻擋。自動化任務母卡也應該要能設定這個部分。"
--
-- PR-link enforcement in the OODA-R done-gate becomes a PER-CARD OPT-IN. When
-- requires_pr_link = TRUE, moving a card to done additionally requires the
-- evidence comment to cite a https://github.com/<owner>/<repo>/pull/<N> link.
-- DEFAULT FALSE = NOT blocking, so by default no card needs a PR link at done.
-- Settable at card creation (POST /card {requirePrLink}) and later
-- (PUT /card/:id/config {requirePrLink}), including on automation母卡.
--
-- This supersedes / generalises the automation-only PR-link exemption (PR #3870):
-- everything is exempt by default; opting in is what turns enforcement on. The
-- 6-item evidence checklist is unaffected and always enforced.

ALTER TABLE kanban_cards
    ADD COLUMN IF NOT EXISTS requires_pr_link BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN kanban_cards.requires_pr_link IS
    'OODA-R done-gate per-card PR-link opt-in. When TRUE, moving to done requires '
    'the evidence comment to include a github.com/<owner>/<repo>/pull/<N> link. '
    'DEFAULT FALSE = not blocking. Set at create (POST /card) or via '
    'PUT /card/:id/config. Automation/ops cards stay exempt even when opted in.';
