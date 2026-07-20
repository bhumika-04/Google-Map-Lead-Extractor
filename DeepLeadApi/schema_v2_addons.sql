-- ============================================================
-- LeadScout AI — Phase 2 Add-Ons Migration
-- New features: Follow-Up Scheduler, Interakt Nurture Sequences
--
-- Safe to re-run: all blocks use IF NOT EXISTS / IF EXISTS guards.
-- Run AFTER schema.sql (base schema must already exist).
-- Run in SSMS against the 'deeplead' database.
-- ============================================================

USE deeplead;
GO

-- ─── 1. Nurture Sequences ────────────────────────────────────────────────────
-- Stores scheduled follow-up messages for a specific company + template pair.
-- The service worker alarm fires hourly, fetches rows where:
--   status = 'pending' AND scheduled_for <= GETDATE()
-- and auto-sends via Interakt (if configured) or surfaces them in NurturePanel.
--
-- Lifecycle: pending → sent (auto or manual) | skipped (user dismissed)
-- ─────────────────────────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE type = 'U' AND name = 'nurture_sequences')
CREATE TABLE nurture_sequences (
    id              UNIQUEIDENTIFIER    NOT NULL  DEFAULT NEWID()   PRIMARY KEY,
    company_id      UNIQUEIDENTIFIER    NOT NULL  REFERENCES companies(id)         ON DELETE CASCADE,
    template_id     UNIQUEIDENTIFIER    NOT NULL  REFERENCES nurture_templates(id) ON DELETE CASCADE,
    scheduled_for   DATETIME2           NOT NULL,
    status          NVARCHAR(20)        NOT NULL  DEFAULT 'pending',   -- pending | sent | skipped
    sent_at         DATETIME2           NULL,
    created_at      DATETIME2           NOT NULL  DEFAULT GETDATE()
);
GO

PRINT '✓ nurture_sequences table ready';
GO

-- ─── 2. Indexes ──────────────────────────────────────────────────────────────
-- Composite index on (status, scheduled_for): the /api/nurture/due endpoint filters
-- on both columns, so this index is the hot path for every hourly alarm check.

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nurture_sequences_status_scheduled')
    CREATE INDEX ix_nurture_sequences_status_scheduled
        ON nurture_sequences (status, scheduled_for);
GO

-- Separate index on company_id so fetching all sequences for a company is fast
-- (used in NurturePanel → "Scheduled" tab filtered by company).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nurture_sequences_company')
    CREATE INDEX ix_nurture_sequences_company
        ON nurture_sequences (company_id);
GO

PRINT '✓ nurture_sequences indexes ready';
GO

-- ─── 3. outreach_conversations — ensure next_follow_up_at exists ─────────────
-- This column was in the original schema but may be missing on older installs.
-- The /api/followups/due and /api/followups/upcoming endpoints both filter on it.

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('outreach_conversations') AND name = 'next_follow_up_at'
)
    ALTER TABLE outreach_conversations
        ADD next_follow_up_at DATETIME NULL;
GO

-- Index so the follow-up queries (WHERE next_follow_up_at <= GETDATE()) don't scan.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_outreach_conversations_followup')
    CREATE INDEX ix_outreach_conversations_followup
        ON outreach_conversations (next_follow_up_at, stage)
        WHERE next_follow_up_at IS NOT NULL;
GO

PRINT '✓ outreach_conversations.next_follow_up_at ready';
GO

-- ─── 4. nurture_templates — ensure all columns exist ─────────────────────────
-- nurture_templates was in the base schema but without NOT NULL / DEFAULT guards.
-- These ALTER TABLEs bring an older install up to the expected state.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('nurture_templates') AND name = 'sequence_step')
    ALTER TABLE nurture_templates ADD sequence_step INT NOT NULL DEFAULT 1;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('nurture_templates') AND name = 'delay_days')
    ALTER TABLE nurture_templates ADD delay_days INT NOT NULL DEFAULT 3;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('nurture_templates') AND name = 'subject')
    ALTER TABLE nurture_templates ADD subject NVARCHAR(500) NULL;
GO

PRINT '✓ nurture_templates columns ready';
GO

-- ─── 5. Updated pipeline view ────────────────────────────────────────────────
-- Extends vw_lead_pipeline to surface the latest nurture sequence status for each
-- company so dashboard views can show "awaiting nurture" without joining manually.

IF OBJECT_ID('vw_lead_pipeline', 'V') IS NOT NULL
    DROP VIEW vw_lead_pipeline;
GO

CREATE VIEW vw_lead_pipeline AS
SELECT
    c.id                        AS company_id,
    c.name                      AS company_name,
    c.city,
    c.phone,
    c.website,
    c.category,
    c.validation_status,
    c.enrichment_status,
    c.outreach_status,
    c.created_at                AS captured_at,
    p.keywords,

    -- AI Enrichment
    e.email,
    e.owner_name                AS decision_maker,
    e.owner_linkedin,
    e.linkedin_url,
    e.instagram_url,
    e.twitter_url,
    e.whatsapp,
    e.industry,
    e.annual_turnover,
    e.overall_confidence        AS research_confidence,
    e.enriched_at,

    -- Deep Research / Pitch
    dr.recommended_pitch,
    dr.researched_at            AS deep_researched_at,

    -- Latest Outreach Conversation
    conv.channel                AS outreach_channel,
    conv.stage                  AS conversation_stage,
    conv.last_activity_at,
    conv.next_follow_up_at,

    -- Latest Nurture Sequence (if any)
    ns.template_name            AS nurture_template_name,
    ns.nurture_channel,
    ns.nurture_status,
    ns.scheduled_for            AS nurture_scheduled_for,
    ns.sent_at                  AS nurture_sent_at

FROM companies c
JOIN search_projects p ON c.project_id = p.id
LEFT JOIN company_enrichments e
    ON e.company_id = c.id
LEFT JOIN company_deep_research dr
    ON dr.company_id = c.id
LEFT JOIN (
    -- Most recent conversation per company
    SELECT company_id, channel, stage, last_activity_at, next_follow_up_at,
           ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY last_activity_at DESC) AS rn
    FROM outreach_conversations
) conv ON conv.company_id = c.id AND conv.rn = 1
LEFT JOIN (
    -- Most recent nurture sequence per company (pending or sent)
    SELECT
        ns.company_id,
        nt.name     AS template_name,
        nt.channel  AS nurture_channel,
        ns.status   AS nurture_status,
        ns.scheduled_for,
        ns.sent_at,
        ROW_NUMBER() OVER (PARTITION BY ns.company_id ORDER BY ns.scheduled_for DESC) AS rn
    FROM nurture_sequences ns
    JOIN nurture_templates nt ON ns.template_id = nt.id
    WHERE ns.status IN ('pending', 'sent')
) ns ON ns.company_id = c.id AND ns.rn = 1;
GO

PRINT '✓ vw_lead_pipeline updated with nurture columns';
GO

-- ─── 6. Helpful queries for verification ─────────────────────────────────────
-- Uncomment and run in SSMS to verify the migration worked correctly.

/*
-- Check table was created:
SELECT TOP 5 * FROM nurture_sequences ORDER BY created_at DESC;

-- Check indexes exist:
SELECT name, type_desc FROM sys.indexes WHERE object_id = OBJECT_ID('nurture_sequences');

-- Check follow-up index:
SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID('outreach_conversations');

-- Check view columns:
SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.VIEW_COLUMN_USAGE
WHERE VIEW_NAME = 'vw_lead_pipeline'
ORDER BY COLUMN_NAME;

-- Due sequences (what /api/nurture/due returns):
SELECT ns.id, c.name, nt.name AS template, ns.scheduled_for, ns.status
FROM nurture_sequences ns
JOIN companies c ON ns.company_id = c.id
JOIN nurture_templates nt ON ns.template_id = nt.id
WHERE ns.status = 'pending' AND ns.scheduled_for <= GETDATE()
ORDER BY ns.scheduled_for;

-- Overdue follow-ups (what /api/followups/due returns):
SELECT oc.id, c.name, oc.channel, oc.stage, oc.next_follow_up_at
FROM outreach_conversations oc
JOIN companies c ON oc.company_id = c.id
WHERE oc.next_follow_up_at <= GETDATE()
  AND oc.stage NOT IN ('won', 'lost')
ORDER BY oc.next_follow_up_at;
*/

PRINT '';
PRINT '============================================================';
PRINT 'Phase 2 add-ons migration complete.';
PRINT 'Tables : nurture_sequences';
PRINT 'Indexes: ix_nurture_sequences_status_scheduled';
PRINT '         ix_nurture_sequences_company';
PRINT '         ix_outreach_conversations_followup';
PRINT 'View   : vw_lead_pipeline (updated with nurture columns)';
PRINT '============================================================';
GO
