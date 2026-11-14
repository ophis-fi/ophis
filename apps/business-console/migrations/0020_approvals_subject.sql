-- The audit page names an order from its approval, found by the approval's subject (auditRows in data.ts): by this
-- index, so a page reads its own rows whatever the number of approvals (2026-11-14).
CREATE INDEX approvals_subject ON approvals (org_id, subject_id);
