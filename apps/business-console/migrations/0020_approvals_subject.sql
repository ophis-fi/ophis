-- The audit page names an order from its approval, found by the approval's subject (auditRows in data.ts): by this
-- index, so a page reads its own rows whatever the number of approvals (2026-11-14). Orders only: every change of
-- policy has the organisation as its subject, and would be read for each row about it.
CREATE INDEX approvals_order_subject ON approvals (org_id, subject_id) WHERE action = 'order';
