-- The audit page names an order from its approval, found by the approval's subject (auditRows in data.ts): by this
-- index, so a page reads its own rows whatever the number of approvals (2026-11-14). With the action: every change of
-- policy has the organisation as its subject, and would be read for each row about it. The enrolment tickets find
-- their confirmation by it too.
CREATE INDEX approvals_subject ON approvals (org_id, subject_id, action);
