-- The audit page names an order from its approval, found by the approval's subject (auditRows in data.ts): by this
-- index, so a page reads its own rows whatever the number of approvals (2026-11-14). The action first: every change
-- of policy has the organisation as its subject, and the desk lists the orders of an organisation by their action. The
-- enrolment tickets find their confirmation by it too.
CREATE INDEX approvals_subject ON approvals (org_id, action, subject_id);
