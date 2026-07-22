/* ==================================================================
   DeepLead / LeadScout AI  -  FULL DATABASE BOOTSTRAP (single file)
   ------------------------------------------------------------------
   Run this ONCE on your SQL Server (SSMS: open + Execute, or
   sqlcmd -S <server> -I -i create_database_full.sql).
   Creates the [DeepLeadRPA] database and every table, index, view and
   stored procedure. Idempotent - safe to re-run.
   ================================================================== */
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO
IF DB_ID('DeepLeadRPA') IS NULL
BEGIN
    CREATE DATABASE [DeepLeadRPA];
    PRINT 'Created database [DeepLeadRPA]';
END
GO
USE [DeepLeadRPA];
GO
SET QUOTED_IDENTIFIER ON;
GO

GO
/* ==========  schema.sql  ========== */
SET QUOTED_IDENTIFIER ON;
GO
-- ============================================================
-- Google Map Lead Extractor â€” Complete Database Schema
-- Run this in SSMS against the 'deeplead' database
-- Safe to re-run multiple times â€” all checks use IF NOT EXISTS
-- ============================================================

USE [DeepLeadRPA];
GO

-- â”€â”€ 1. Search Projects â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='search_projects' AND xtype='U')
CREATE TABLE search_projects (
    id              UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    name            NVARCHAR(255) NOT NULL,
    city            NVARCHAR(100),
    keywords        NVARCHAR(255),
    status          NVARCHAR(50)  DEFAULT 'active',
    total_found     INT           DEFAULT 0,
    total_enriched  INT           DEFAULT 0,
    created_at      DATETIME      DEFAULT GETDATE(),
    updated_at      DATETIME      DEFAULT GETDATE()
);
GO

-- â”€â”€ 2. Companies â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='companies' AND xtype='U')
CREATE TABLE companies (
    id                UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    project_id        UNIQUEIDENTIFIER REFERENCES search_projects(id),
    place_id          NVARCHAR(200),
    name              NVARCHAR(500) NOT NULL,
    address           NVARCHAR(1000),
    phone             NVARCHAR(100),
    website           NVARCHAR(1000),
    google_maps_url   NVARCHAR(1000),
    rating            DECIMAL(3,1),
    review_count      INT,
    category          NVARCHAR(255),
    city              NVARCHAR(100),
    enrichment_status NVARCHAR(50)  DEFAULT 'pending',
    validation_status NVARCHAR(50),
    outreach_status   NVARCHAR(50)  DEFAULT 'not_contacted',
    created_at        DATETIME      DEFAULT GETDATE(),
    updated_at        DATETIME      DEFAULT GETDATE()
);
GO

-- Add missing columns to existing companies table
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'validation_status')
    ALTER TABLE companies ADD validation_status NVARCHAR(50);
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'outreach_status')
    ALTER TABLE companies ADD outreach_status NVARCHAR(50) DEFAULT 'not_contacted';
GO

-- â”€â”€ 3. Company Enrichments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='company_enrichments' AND xtype='U')
CREATE TABLE company_enrichments (
    id                      UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    company_id              UNIQUEIDENTIFIER REFERENCES companies(id),
    official_website        NVARCHAR(1000),
    email                   NVARCHAR(255),
    alternate_phone         NVARCHAR(100),
    whatsapp                NVARCHAR(50),
    linkedin_url            NVARCHAR(1000),
    facebook_url            NVARCHAR(1000),
    instagram_url           NVARCHAR(1000),
    youtube_url             NVARCHAR(1000),
    twitter_url             NVARCHAR(1000),
    owner_name              NVARCHAR(255),
    owner_linkedin          NVARCHAR(1000),
    industry                NVARCHAR(100),
    tagline                 NVARCHAR(500),
    description             NVARCHAR(MAX),
    products_services       NVARCHAR(MAX),
    business_type           NVARCHAR(100),
    supplier_type           NVARCHAR(50),
    team_size               NVARCHAR(50),
    established_year        NVARCHAR(10),
    annual_turnover         NVARCHAR(100),
    headquarters            NVARCHAR(200),
    team_members_json       NVARCHAR(MAX),
    certifications_json     NVARCHAR(MAX),
    major_clients_json      NVARCHAR(MAX),
    expansion_signals_json  NVARCHAR(MAX),
    current_software_json   NVARCHAR(MAX),
    export_markets_json     NVARCHAR(MAX),
    pain_points_json        NVARCHAR(MAX),
    services_json           NVARCHAR(MAX),
    overall_confidence      DECIMAL(5,4),
    lead_score              INT,
    full_result_json        NVARCHAR(MAX),
    enriched_at             DATETIME,
    updated_at              DATETIME DEFAULT GETDATE()
);
GO

-- Add missing columns to existing company_enrichments table
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'alternate_phone')
    ALTER TABLE company_enrichments ADD alternate_phone NVARCHAR(100);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'whatsapp')
    ALTER TABLE company_enrichments ADD whatsapp NVARCHAR(50);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'twitter_url')
    ALTER TABLE company_enrichments ADD twitter_url NVARCHAR(1000);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'owner_linkedin')
    ALTER TABLE company_enrichments ADD owner_linkedin NVARCHAR(1000);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'industry')
    ALTER TABLE company_enrichments ADD industry NVARCHAR(100);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'tagline')
    ALTER TABLE company_enrichments ADD tagline NVARCHAR(500);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'supplier_type')
    ALTER TABLE company_enrichments ADD supplier_type NVARCHAR(50);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'annual_turnover')
    ALTER TABLE company_enrichments ADD annual_turnover NVARCHAR(100);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'headquarters')
    ALTER TABLE company_enrichments ADD headquarters NVARCHAR(200);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'team_members_json')
    ALTER TABLE company_enrichments ADD team_members_json NVARCHAR(MAX);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'certifications_json')
    ALTER TABLE company_enrichments ADD certifications_json NVARCHAR(MAX);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'major_clients_json')
    ALTER TABLE company_enrichments ADD major_clients_json NVARCHAR(MAX);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'expansion_signals_json')
    ALTER TABLE company_enrichments ADD expansion_signals_json NVARCHAR(MAX);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'current_software_json')
    ALTER TABLE company_enrichments ADD current_software_json NVARCHAR(MAX);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'export_markets_json')
    ALTER TABLE company_enrichments ADD export_markets_json NVARCHAR(MAX);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'pain_points_json')
    ALTER TABLE company_enrichments ADD pain_points_json NVARCHAR(MAX);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'services_json')
    ALTER TABLE company_enrichments ADD services_json NVARCHAR(MAX);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'full_result_json')
    ALTER TABLE company_enrichments ADD full_result_json NVARCHAR(MAX);
GO

-- â”€â”€ 4. Company Contacts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='company_contacts' AND xtype='U')
CREATE TABLE company_contacts (
    id              UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    company_id      UNIQUEIDENTIFIER REFERENCES companies(id),
    full_name       NVARCHAR(255),
    role            NVARCHAR(255),
    email           NVARCHAR(255),
    phone           NVARCHAR(100),
    linkedin_url    NVARCHAR(1000),
    instagram_url   NVARCHAR(1000),
    twitter_url     NVARCHAR(1000),
    facebook_url    NVARCHAR(1000),
    whatsapp        NVARCHAR(50),
    source_type     NVARCHAR(50),
    confidence      DECIMAL(5,4),
    discovered_at   DATETIME DEFAULT GETDATE()
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_contacts') AND name = 'role')
    ALTER TABLE company_contacts ADD role NVARCHAR(255);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_contacts') AND name = 'phone')
    ALTER TABLE company_contacts ADD phone NVARCHAR(100);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_contacts') AND name = 'instagram_url')
    ALTER TABLE company_contacts ADD instagram_url NVARCHAR(1000);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_contacts') AND name = 'twitter_url')
    ALTER TABLE company_contacts ADD twitter_url NVARCHAR(1000);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_contacts') AND name = 'facebook_url')
    ALTER TABLE company_contacts ADD facebook_url NVARCHAR(1000);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_contacts') AND name = 'whatsapp')
    ALTER TABLE company_contacts ADD whatsapp NVARCHAR(50);
GO

-- â”€â”€ 5. Deep Research / Social Intelligence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='company_deep_research' AND xtype='U')
CREATE TABLE company_deep_research (
    id                      UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    company_id              UNIQUEIDENTIFIER REFERENCES companies(id),
    recommended_pitch       NVARCHAR(MAX),
    pitch_template          NVARCHAR(MAX),
    people_activity_json    NVARCHAR(MAX),
    company_signals_json    NVARCHAR(MAX),
    intent_signals_json     NVARCHAR(MAX),
    full_deep_research_json NVARCHAR(MAX),
    researched_at           DATETIME DEFAULT GETDATE(),
    created_at              DATETIME DEFAULT GETDATE(),
    updated_at              DATETIME DEFAULT GETDATE()
);
GO

-- â”€â”€ 6. Outreach Conversations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Stage: cold â†’ contacted â†’ replied â†’ nurturing â†’ meeting_scheduled â†’ won / lost
IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='outreach_conversations' AND xtype='U')
CREATE TABLE outreach_conversations (
    id                  UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    company_id          UNIQUEIDENTIFIER REFERENCES companies(id),
    contact_id          UNIQUEIDENTIFIER REFERENCES company_contacts(id) NULL,
    channel             NVARCHAR(50) NOT NULL,
    contact_name        NVARCHAR(255),
    stage               NVARCHAR(50) DEFAULT 'cold',
    last_activity_at    DATETIME DEFAULT GETDATE(),
    next_follow_up_at   DATETIME NULL,
    notes               NVARCHAR(MAX),
    created_at          DATETIME DEFAULT GETDATE(),
    updated_at          DATETIME DEFAULT GETDATE()
);
GO

-- â”€â”€ 7. Conversation Messages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='conversation_messages' AND xtype='U')
CREATE TABLE conversation_messages (
    id                UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    conversation_id   UNIQUEIDENTIFIER REFERENCES outreach_conversations(id),
    direction         NVARCHAR(10) NOT NULL,
    content           NVARCHAR(MAX),
    channel           NVARCHAR(50),
    sent_at           DATETIME DEFAULT GETDATE(),
    read_at           DATETIME NULL
);
GO

-- â”€â”€ 8. Nurture Templates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='nurture_templates' AND xtype='U')
CREATE TABLE nurture_templates (
    id                UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    name              NVARCHAR(255),
    channel           NVARCHAR(50),
    stage             NVARCHAR(50),
    sequence_step     INT DEFAULT 1,
    delay_days        INT DEFAULT 3,
    subject           NVARCHAR(500),
    message_template  NVARCHAR(MAX),
    created_at        DATETIME DEFAULT GETDATE()
);
GO

-- â”€â”€ Pipeline view â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
IF OBJECT_ID('vw_lead_pipeline', 'V') IS NOT NULL DROP VIEW vw_lead_pipeline;
GO

CREATE VIEW vw_lead_pipeline AS
SELECT
    c.id                    AS company_id,
    c.name                  AS company_name,
    c.city,
    c.phone,
    c.website,
    c.category,
    c.validation_status,
    c.enrichment_status,
    c.outreach_status,
    c.created_at            AS captured_at,
    p.keywords,
    e.email,
    e.owner_name            AS decision_maker,
    e.owner_linkedin,
    e.linkedin_url,
    e.instagram_url,
    e.twitter_url,
    e.whatsapp,
    e.industry,
    e.annual_turnover,
    e.overall_confidence    AS research_confidence,
    e.enriched_at,
    dr.recommended_pitch,
    dr.researched_at        AS deep_researched_at,
    conv.channel            AS outreach_channel,
    conv.stage              AS conversation_stage,
    conv.last_activity_at,
    conv.next_follow_up_at
FROM companies c
JOIN search_projects p ON c.project_id = p.id
LEFT JOIN company_enrichments e ON e.company_id = c.id
LEFT JOIN company_deep_research dr ON dr.company_id = c.id
LEFT JOIN (
    SELECT company_id, channel, stage, last_activity_at, next_follow_up_at,
           ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY last_activity_at DESC) AS rn
    FROM outreach_conversations
) conv ON conv.company_id = c.id AND conv.rn = 1;
GO

PRINT 'Schema created/updated successfully.';
GO


GO
/* ==========  schema_v2_addons.sql  ========== */
SET QUOTED_IDENTIFIER ON;
GO
-- ============================================================
-- LeadScout AI â€” Phase 2 Add-Ons Migration
-- New features: Follow-Up Scheduler, Interakt Nurture Sequences
--
-- Safe to re-run: all blocks use IF NOT EXISTS / IF EXISTS guards.
-- Run AFTER schema.sql (base schema must already exist).
-- Run in SSMS against the 'deeplead' database.
-- ============================================================

USE [DeepLeadRPA];
GO

-- â”€â”€â”€ 1. Nurture Sequences â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Stores scheduled follow-up messages for a specific company + template pair.
-- The service worker alarm fires hourly, fetches rows where:
--   status = 'pending' AND scheduled_for <= GETDATE()
-- and auto-sends via Interakt (if configured) or surfaces them in NurturePanel.
--
-- Lifecycle: pending â†’ sent (auto or manual) | skipped (user dismissed)
-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

PRINT 'âœ“ nurture_sequences table ready';
GO

-- â”€â”€â”€ 2. Indexes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Composite index on (status, scheduled_for): the /api/nurture/due endpoint filters
-- on both columns, so this index is the hot path for every hourly alarm check.

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nurture_sequences_status_scheduled')
    CREATE INDEX ix_nurture_sequences_status_scheduled
        ON nurture_sequences (status, scheduled_for);
GO

-- Separate index on company_id so fetching all sequences for a company is fast
-- (used in NurturePanel â†’ "Scheduled" tab filtered by company).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_nurture_sequences_company')
    CREATE INDEX ix_nurture_sequences_company
        ON nurture_sequences (company_id);
GO

PRINT 'âœ“ nurture_sequences indexes ready';
GO

-- â”€â”€â”€ 3. outreach_conversations â€” ensure next_follow_up_at exists â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

PRINT 'âœ“ outreach_conversations.next_follow_up_at ready';
GO

-- â”€â”€â”€ 4. nurture_templates â€” ensure all columns exist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

PRINT 'âœ“ nurture_templates columns ready';
GO

-- â”€â”€â”€ 5. Updated pipeline view â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

PRINT 'âœ“ vw_lead_pipeline updated with nurture columns';
GO

-- â”€â”€â”€ 6. Helpful queries for verification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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


GO
/* ==========  schema_v3_research_evidence.sql  ========== */
SET QUOTED_IDENTIFIER ON;
GO
-- ============================================================
-- LeadScout AI â€” Phase 3 Add-Ons Migration
-- New feature: Evidence-Based Company Research Pipeline
--
-- Mirrors the extension's IndexedDB tables (searchEvidence,
-- sourcePages, companyResearch â€” db.ts version 7) so the same
-- evidence trail can be persisted to MSSQL for reporting/backup.
--
-- Safe to re-run: all blocks use IF NOT EXISTS / IF EXISTS guards.
-- Run AFTER schema.sql and schema_v2_addons.sql (base schema must
-- already exist).
-- Run in SSMS against the 'deeplead' database.
-- ============================================================

USE [DeepLeadRPA];
GO

-- â”€â”€â”€ 1. Search Evidence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- One row per Google search result captured for a company (accepted AND
-- rejected â€” rejected rows keep reject_reason for auditability, so a wrong-
-- company match can always be traced back to why it was excluded).

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE type = 'U' AND name = 'search_evidence')
CREATE TABLE search_evidence (
    id                UNIQUEIDENTIFIER    NOT NULL  DEFAULT NEWID()   PRIMARY KEY,
    company_id        UNIQUEIDENTIFIER    NOT NULL  REFERENCES companies(id) ON DELETE CASCADE,
    query             NVARCHAR(500),
    title             NVARCHAR(500),
    url               NVARCHAR(1000)      NOT NULL,
    display_url       NVARCHAR(500),
    snippet           NVARCHAR(1000),
    rank              INT,
    source_domain     NVARCHAR(255),
    detected_type     NVARCHAR(50),        -- official_website|linkedin|facebook|instagram|youtube|
                                            -- indiamart|tradeindia|zaubacorp|ambitionbox|
                                            -- company_directory|review_site|unknown
    match_confidence  DECIMAL(5,4),        -- 0-1 name-match score vs. the lead's company name
    rejected          BIT                 NOT NULL  DEFAULT 0,
    reject_reason     NVARCHAR(500),
    captured_at       DATETIME2           NOT NULL  DEFAULT GETDATE()
);
GO

PRINT 'âœ“ search_evidence table ready';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_search_evidence_company')
    CREATE INDEX ix_search_evidence_company
        ON search_evidence (company_id, rank);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_search_evidence_type')
    CREATE INDEX ix_search_evidence_type
        ON search_evidence (detected_type, rejected);
GO

PRINT 'âœ“ search_evidence indexes ready';
GO

-- â”€â”€â”€ 2. Source Pages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- One row per source link actually opened (a subset of search_evidence â€”
-- only priority types get visited). Holds the raw scraped text plus the
-- per-page AI extraction result, so every extracted field stays traceable
-- to the exact page it came from.

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE type = 'U' AND name = 'source_pages')
CREATE TABLE source_pages (
    id                UNIQUEIDENTIFIER    NOT NULL  DEFAULT NEWID()   PRIMARY KEY,
    company_id        UNIQUEIDENTIFIER    NOT NULL  REFERENCES companies(id) ON DELETE CASCADE,
    evidence_id       UNIQUEIDENTIFIER    NULL      REFERENCES search_evidence(id),
    url               NVARCHAR(1000)      NOT NULL,
    source_domain     NVARCHAR(255),
    source_type       NVARCHAR(50),
    page_title        NVARCHAR(500),
    raw_text          NVARCHAR(MAX),
    extracted_json    NVARCHAR(MAX),       -- JSON.stringify of this page's AI extraction
    confidence        DECIMAL(5,4),
    status            NVARCHAR(20)        NOT NULL  DEFAULT 'pending',  -- pending|fetched|extracted|failed
    error_message     NVARCHAR(1000),
    captured_at       DATETIME2           NOT NULL  DEFAULT GETDATE()
);
GO

PRINT 'âœ“ source_pages table ready';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_source_pages_company')
    CREATE INDEX ix_source_pages_company
        ON source_pages (company_id, status);
GO

PRINT 'âœ“ source_pages indexes ready';
GO

-- â”€â”€â”€ 3. Company Research â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- One row per company â€” the merged, confidence-weighted result of all
-- source_pages for that company. This is the evidence-pipeline equivalent
-- of company_enrichments, surfaced in the extension's Company Intelligence page.

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE type = 'U' AND name = 'company_research')
CREATE TABLE company_research (
    id                  UNIQUEIDENTIFIER    NOT NULL  DEFAULT NEWID()   PRIMARY KEY,
    company_id          UNIQUEIDENTIFIER    NOT NULL  REFERENCES companies(id) ON DELETE CASCADE,
    company_name        NVARCHAR(500),
    official_website    NVARCHAR(1000),
    linkedin_url        NVARCHAR(1000),
    facebook_url        NVARCHAR(1000),
    instagram_url       NVARCHAR(1000),
    indiamart_url       NVARCHAR(1000),
    tradeindia_url      NVARCHAR(1000),
    owner_name          NVARCHAR(255),
    directors           NVARCHAR(MAX),
    products_services   NVARCHAR(MAX),
    business_type       NVARCHAR(100),
    team_size           NVARCHAR(50),
    turnover            NVARCHAR(100),
    established_year    INT,
    address             NVARCHAR(1000),
    phone               NVARCHAR(100),
    email               NVARCHAR(255),
    confidence          DECIMAL(5,4),
    sources_json        NVARCHAR(MAX),      -- { field: sourcePageId } attribution map
    created_at          DATETIME2           NOT NULL  DEFAULT GETDATE(),
    updated_at          DATETIME2           NOT NULL  DEFAULT GETDATE()
);
GO

PRINT 'âœ“ company_research table ready';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_company_research_company')
    CREATE INDEX ix_company_research_company
        ON company_research (company_id);
GO

PRINT 'âœ“ company_research indexes ready';
GO

-- â”€â”€â”€ 4. Upsert proc for company_research â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- One company can be re-researched multiple times; this keeps a single
-- current row per company_id instead of accumulating duplicates, while
-- search_evidence / source_pages stay append-only (full history of every run).

IF OBJECT_ID('usp_upsert_company_research', 'P') IS NOT NULL
    DROP PROCEDURE usp_upsert_company_research;
GO

CREATE PROCEDURE usp_upsert_company_research
    @company_id          UNIQUEIDENTIFIER,
    @company_name        NVARCHAR(500),
    @official_website    NVARCHAR(1000) = NULL,
    @linkedin_url        NVARCHAR(1000) = NULL,
    @facebook_url        NVARCHAR(1000) = NULL,
    @instagram_url       NVARCHAR(1000) = NULL,
    @indiamart_url       NVARCHAR(1000) = NULL,
    @tradeindia_url      NVARCHAR(1000) = NULL,
    @owner_name          NVARCHAR(255)  = NULL,
    @directors           NVARCHAR(MAX)  = NULL,
    @products_services   NVARCHAR(MAX)  = NULL,
    @business_type       NVARCHAR(100)  = NULL,
    @team_size           NVARCHAR(50)   = NULL,
    @turnover            NVARCHAR(100)  = NULL,
    @established_year    INT            = NULL,
    @address             NVARCHAR(1000) = NULL,
    @phone               NVARCHAR(100)  = NULL,
    @email               NVARCHAR(255)  = NULL,
    @confidence          DECIMAL(5,4)   = NULL,
    @sources_json        NVARCHAR(MAX)  = NULL
AS
BEGIN
    SET NOCOUNT ON;

    MERGE company_research AS target
    USING (SELECT @company_id AS company_id) AS src
        ON target.company_id = src.company_id
    WHEN MATCHED THEN
        UPDATE SET
            company_name      = @company_name,
            official_website  = @official_website,
            linkedin_url      = @linkedin_url,
            facebook_url      = @facebook_url,
            instagram_url     = @instagram_url,
            indiamart_url     = @indiamart_url,
            tradeindia_url    = @tradeindia_url,
            owner_name        = @owner_name,
            directors         = @directors,
            products_services = @products_services,
            business_type     = @business_type,
            team_size         = @team_size,
            turnover          = @turnover,
            established_year  = @established_year,
            address           = @address,
            phone             = @phone,
            email             = @email,
            confidence        = @confidence,
            sources_json      = @sources_json,
            updated_at        = GETDATE()
    WHEN NOT MATCHED THEN
        INSERT (
            company_id, company_name, official_website, linkedin_url, facebook_url,
            instagram_url, indiamart_url, tradeindia_url, owner_name, directors,
            products_services, business_type, team_size, turnover, established_year,
            address, phone, email, confidence, sources_json
        )
        VALUES (
            @company_id, @company_name, @official_website, @linkedin_url, @facebook_url,
            @instagram_url, @indiamart_url, @tradeindia_url, @owner_name, @directors,
            @products_services, @business_type, @team_size, @turnover, @established_year,
            @address, @phone, @email, @confidence, @sources_json
        );
END
GO

PRINT 'âœ“ usp_upsert_company_research procedure ready';
GO

-- â”€â”€â”€ 5. Updated pipeline view â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Extends vw_lead_pipeline to surface the evidence-pipeline confidence and
-- source-page counts alongside the existing AI-enrichment confidence.

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

    -- AI Enrichment (single-call pipeline)
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

    -- Evidence-Based Research (Phase 3)
    cr.confidence                AS evidence_confidence,
    cr.official_website          AS evidence_website,
    cr.updated_at                AS evidence_updated_at,
    sp.source_page_count,
    sp.extracted_page_count,

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
LEFT JOIN company_research cr
    ON cr.company_id = c.id
LEFT JOIN (
    SELECT company_id,
           COUNT(*)                                            AS source_page_count,
           SUM(CASE WHEN status = 'extracted' THEN 1 ELSE 0 END) AS extracted_page_count
    FROM source_pages
    GROUP BY company_id
) sp ON sp.company_id = c.id
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

PRINT 'âœ“ vw_lead_pipeline updated with evidence-research columns';
GO

-- â”€â”€â”€ 6. Helpful queries for verification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Uncomment and run in SSMS to verify the migration worked correctly.

/*
-- Check tables were created:
SELECT TOP 5 * FROM search_evidence  ORDER BY captured_at DESC;
SELECT TOP 5 * FROM source_pages     ORDER BY captured_at DESC;
SELECT TOP 5 * FROM company_research ORDER BY updated_at  DESC;

-- All evidence for one company (accepted + rejected, ranked):
SELECT rank, title, url, detected_type, match_confidence, rejected, reject_reason
FROM search_evidence
WHERE company_id = '00000000-0000-0000-0000-000000000000'
ORDER BY rank;

-- Source pages actually visited for one company:
SELECT url, source_type, status, confidence, error_message
FROM source_pages
WHERE company_id = '00000000-0000-0000-0000-000000000000';

-- Upsert example:
EXEC usp_upsert_company_research
    @company_id = '00000000-0000-0000-0000-000000000000',
    @company_name = 'Acme Packaging Pvt Ltd',
    @official_website = 'https://acmepackaging.com',
    @confidence = 0.82;

-- Pipeline view with evidence-research columns:
SELECT company_name, research_confidence, evidence_confidence,
       source_page_count, extracted_page_count
FROM vw_lead_pipeline
ORDER BY evidence_updated_at DESC;
*/

PRINT '';
PRINT '============================================================';
PRINT 'Phase 3 evidence-research migration complete.';
PRINT 'Tables : search_evidence, source_pages, company_research';
PRINT 'Indexes: ix_search_evidence_company, ix_search_evidence_type';
PRINT '         ix_source_pages_company, ix_company_research_company';
PRINT 'Proc   : usp_upsert_company_research';
PRINT 'View   : vw_lead_pipeline (updated with evidence-research columns)';
PRINT '============================================================';
GO


GO
/* ==========  schema_v4_linkedin_intelligence.sql  ========== */
SET QUOTED_IDENTIFIER ON;
GO
-- ============================================================
-- LeadScout AI â€” Phase 3 Add-Ons Migration
-- New feature: LinkedIn Business Intelligence
--
-- Stores publicly-visible LinkedIn company profile data, company
-- activity (last 6 months), core team members, and core-member
-- activity captured by the extension's automated LinkedIn scraper
-- (src/content/linkedinScraper.ts + src/services/linkedinScraperService.ts).
--
-- Compliance: the scraper never bypasses login/captcha/paywall/robots
-- restrictions or private pages â€” any field not visibly present on the
-- page is captured client-side as 'Not Available' rather than inferred.
--
-- Safe to re-run: all blocks use IF NOT EXISTS / IF EXISTS guards.
-- Run AFTER schema.sql, schema_v2_addons.sql, schema_v3_research_evidence.sql.
-- Run in SSMS against the 'deeplead' database.
-- ============================================================

USE [DeepLeadRPA];
GO

-- â”€â”€â”€ 1. LinkedIn Company Profiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- One current row per company (re-running the scraper updates it in place).

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE type = 'U' AND name = 'linkedin_company_profiles')
CREATE TABLE linkedin_company_profiles (
    id              UNIQUEIDENTIFIER    NOT NULL  DEFAULT NEWID()   PRIMARY KEY,
    company_id      UNIQUEIDENTIFIER    NOT NULL  REFERENCES companies(id) ON DELETE CASCADE,
    company_name    NVARCHAR(500),
    linkedin_url    NVARCHAR(1000),
    industry        NVARCHAR(255),
    company_size    NVARCHAR(100),
    followers       NVARCHAR(100),
    location        NVARCHAR(500),
    about_text      NVARCHAR(MAX),
    captured_at     DATETIME2           NOT NULL  DEFAULT GETDATE(),
    updated_at      DATETIME2           NOT NULL  DEFAULT GETDATE()
);
GO

PRINT 'âœ“ linkedin_company_profiles table ready';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_linkedin_company_profiles_company')
    CREATE UNIQUE INDEX ix_linkedin_company_profiles_company
        ON linkedin_company_profiles (company_id);
GO

-- â”€â”€â”€ 2. LinkedIn Company Posts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Append-only â€” one row per public company post captured (last 6 months).

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE type = 'U' AND name = 'linkedin_company_posts')
CREATE TABLE linkedin_company_posts (
    id                UNIQUEIDENTIFIER    NOT NULL  DEFAULT NEWID()   PRIMARY KEY,
    company_id        UNIQUEIDENTIFIER    NOT NULL  REFERENCES companies(id) ON DELETE CASCADE,
    post_date         NVARCHAR(100),       -- ISO date when visible, else relative text ("3w")
    post_text         NVARCHAR(MAX),
    post_url          NVARCHAR(1000),
    engagement_count   INT                 NULL,
    detected_theme     NVARCHAR(50),        -- hiring|expansion|product|event|general
    hiring_signal      BIT                 NOT NULL  DEFAULT 0,
    expansion_signal   BIT                 NOT NULL  DEFAULT 0,
    product_signal     BIT                 NOT NULL  DEFAULT 0,
    event_signal       BIT                 NOT NULL  DEFAULT 0,
    within_six_months  BIT                 NOT NULL  DEFAULT 0,
    captured_at        DATETIME2           NOT NULL  DEFAULT GETDATE()
);
GO

PRINT 'âœ“ linkedin_company_posts table ready';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_linkedin_company_posts_company')
    CREATE INDEX ix_linkedin_company_posts_company
        ON linkedin_company_posts (company_id, within_six_months);
GO

-- â”€â”€â”€ 3. LinkedIn People â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- One current row per (company, person) â€” core team members identified by title.

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE type = 'U' AND name = 'linkedin_people')
CREATE TABLE linkedin_people (
    id              UNIQUEIDENTIFIER    NOT NULL  DEFAULT NEWID()   PRIMARY KEY,
    company_id      UNIQUEIDENTIFIER    NOT NULL  REFERENCES companies(id) ON DELETE CASCADE,
    name            NVARCHAR(255),
    title           NVARCHAR(255),
    linkedin_url    NVARCHAR(1000),
    company_name    NVARCHAR(500),
    role_category   NVARCHAR(100),       -- Founder|MD|CEO|...|Other (see CORE_ROLE_TITLES)
    confidence      DECIMAL(5,4),        -- 0-1 confidence of the role_category match
    captured_at     DATETIME2           NOT NULL  DEFAULT GETDATE(),
    updated_at      DATETIME2           NOT NULL  DEFAULT GETDATE()
);
GO

PRINT 'âœ“ linkedin_people table ready';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_linkedin_people_company')
    CREATE INDEX ix_linkedin_people_company
        ON linkedin_people (company_id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_linkedin_people_company_url')
    CREATE UNIQUE INDEX ux_linkedin_people_company_url
        ON linkedin_people (company_id, linkedin_url) WHERE linkedin_url IS NOT NULL;
GO

-- â”€â”€â”€ 4. LinkedIn Person Posts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Append-only â€” one row per public post on a core person's profile (last 6 months).

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE type = 'U' AND name = 'linkedin_person_posts')
CREATE TABLE linkedin_person_posts (
    id                  UNIQUEIDENTIFIER    NOT NULL  DEFAULT NEWID()   PRIMARY KEY,
    company_id          UNIQUEIDENTIFIER    NOT NULL  REFERENCES companies(id) ON DELETE CASCADE,
    person_id           UNIQUEIDENTIFIER    NULL      REFERENCES linkedin_people(id) ON DELETE NO ACTION,
    person_name         NVARCHAR(255),
    person_linkedin_url NVARCHAR(1000),
    post_date           NVARCHAR(100),
    post_text           NVARCHAR(MAX),
    post_url            NVARCHAR(1000),
    detected_theme      NVARCHAR(50),
    business_interest   NVARCHAR(50),
    hiring_signal       BIT                 NOT NULL  DEFAULT 0,
    company_mention     BIT                 NOT NULL  DEFAULT 0,
    within_six_months   BIT                 NOT NULL  DEFAULT 0,
    captured_at         DATETIME2           NOT NULL  DEFAULT GETDATE()
);
GO

PRINT 'âœ“ linkedin_person_posts table ready';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_linkedin_person_posts_company')
    CREATE INDEX ix_linkedin_person_posts_company
        ON linkedin_person_posts (company_id, within_six_months);
GO

-- â”€â”€â”€ 5. Upsert proc for linkedin_company_profiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

IF OBJECT_ID('usp_upsert_linkedin_company_profile', 'P') IS NOT NULL
    DROP PROCEDURE usp_upsert_linkedin_company_profile;
GO

CREATE PROCEDURE usp_upsert_linkedin_company_profile
    @company_id     UNIQUEIDENTIFIER,
    @company_name   NVARCHAR(500)  = NULL,
    @linkedin_url   NVARCHAR(1000) = NULL,
    @industry       NVARCHAR(255)  = NULL,
    @company_size   NVARCHAR(100)  = NULL,
    @followers      NVARCHAR(100)  = NULL,
    @location       NVARCHAR(500)  = NULL,
    @about_text     NVARCHAR(MAX)  = NULL
AS
BEGIN
    SET NOCOUNT ON;

    MERGE linkedin_company_profiles AS target
    USING (SELECT @company_id AS company_id) AS src
        ON target.company_id = src.company_id
    WHEN MATCHED THEN
        UPDATE SET
            company_name = @company_name, linkedin_url = @linkedin_url,
            industry     = @industry,     company_size = @company_size,
            followers    = @followers,    location     = @location,
            about_text   = @about_text,   updated_at   = GETDATE()
    WHEN NOT MATCHED THEN
        INSERT (company_id, company_name, linkedin_url, industry, company_size, followers, location, about_text)
        VALUES (@company_id, @company_name, @linkedin_url, @industry, @company_size, @followers, @location, @about_text);
END
GO

PRINT 'âœ“ usp_upsert_linkedin_company_profile procedure ready';
GO

-- â”€â”€â”€ 6. Upsert proc for linkedin_people â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

IF OBJECT_ID('usp_upsert_linkedin_person', 'P') IS NOT NULL
    DROP PROCEDURE usp_upsert_linkedin_person;
GO

CREATE PROCEDURE usp_upsert_linkedin_person
    @company_id     UNIQUEIDENTIFIER,
    @name           NVARCHAR(255)  = NULL,
    @title          NVARCHAR(255)  = NULL,
    @linkedin_url   NVARCHAR(1000) = NULL,
    @company_name   NVARCHAR(500)  = NULL,
    @role_category  NVARCHAR(100)  = NULL,
    @confidence     DECIMAL(5,4)   = NULL
AS
BEGIN
    SET NOCOUNT ON;

    MERGE linkedin_people AS target
    USING (SELECT @company_id AS company_id, @linkedin_url AS linkedin_url) AS src
        ON target.company_id = src.company_id AND target.linkedin_url = src.linkedin_url
    WHEN MATCHED THEN
        UPDATE SET
            name = @name, title = @title, company_name = @company_name,
            role_category = @role_category, confidence = @confidence, updated_at = GETDATE()
    WHEN NOT MATCHED THEN
        INSERT (company_id, name, title, linkedin_url, company_name, role_category, confidence)
        VALUES (@company_id, @name, @title, @linkedin_url, @company_name, @role_category, @confidence);
END
GO

PRINT 'âœ“ usp_upsert_linkedin_person procedure ready';
GO

-- â”€â”€â”€ 7. Helpful queries for verification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/*
SELECT TOP 5 * FROM linkedin_company_profiles ORDER BY updated_at DESC;
SELECT TOP 5 * FROM linkedin_company_posts    ORDER BY captured_at DESC;
SELECT TOP 5 * FROM linkedin_people           ORDER BY updated_at DESC;
SELECT TOP 5 * FROM linkedin_person_posts     ORDER BY captured_at DESC;

EXEC usp_upsert_linkedin_company_profile
    @company_id = '00000000-0000-0000-0000-000000000000',
    @company_name = 'Acme Packaging Pvt Ltd',
    @linkedin_url = 'https://www.linkedin.com/company/acme-packaging/',
    @industry = 'Packaging and Containers';

-- All hiring-signal posts for a company:
SELECT post_date, post_text, post_url FROM linkedin_company_posts
WHERE company_id = '00000000-0000-0000-0000-000000000000' AND hiring_signal = 1
ORDER BY captured_at DESC;
*/

PRINT '';
PRINT '============================================================';
PRINT 'Phase 3 LinkedIn Business Intelligence migration complete.';
PRINT 'Tables : linkedin_company_profiles, linkedin_company_posts,';
PRINT '         linkedin_people, linkedin_person_posts';
PRINT 'Procs  : usp_upsert_linkedin_company_profile, usp_upsert_linkedin_person';
PRINT '============================================================';
GO


GO
/* ==========  schema_v5_icp_fields.sql  ========== */
SET QUOTED_IDENTIFIER ON;
GO
-- schema_v5_icp_fields.sql
-- Adds ICP scoring columns and enrichment columns to the companies table.
-- Run this ONCE against the deeplead database after deploying schema_v4_linkedin_intelligence.sql.

USE [DeepLeadRPA];
GO

-- ICP scoring columns (populated after Gemini validation runs)
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'icp_score')
    ALTER TABLE companies ADD icp_score INT NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'icp_status')
    ALTER TABLE companies ADD icp_status NVARCHAR(50) NULL;  -- high_fit / good_fit / low_priority / hold / reject

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'icp_reason')
    ALTER TABLE companies ADD icp_reason NVARCHAR(MAX) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'icp_score_breakdown')
    ALTER TABLE companies ADD icp_score_breakdown NVARCHAR(MAX) NULL;  -- e.g. "Industry:20 Scale:18 ERP:15 BizType:10 DM:7"

-- Enrichment columns (from AI pre-validation enrichment step)
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'team_size')
    ALTER TABLE companies ADD team_size NVARCHAR(100) NULL;   -- e.g. "10-50", "50-200"

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'annual_turnover')
    ALTER TABLE companies ADD annual_turnover NVARCHAR(100) NULL;  -- e.g. "â‚¹10-50 Cr"

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'industry')
    ALTER TABLE companies ADD industry NVARCHAR(200) NULL;    -- e.g. "Label Printing"

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'company_type')
    ALTER TABLE companies ADD company_type NVARCHAR(100) NULL;   -- e.g. "Pvt Ltd"

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'decision_maker')
    ALTER TABLE companies ADD decision_maker NVARCHAR(300) NULL;  -- owner/director name

-- Index for fast ICP score filtering (e.g. WHERE icp_score >= 50)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('companies') AND name = 'IX_companies_icp_score')
    CREATE INDEX IX_companies_icp_score ON companies(icp_score);
GO

PRINT 'schema_v5_icp_fields.sql applied successfully.';


GO
/* ==========  runtime migrations (mirrors Program.cs startup)  ========== */
SET QUOTED_IDENTIFIER ON;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'notes')
    ALTER TABLE companies ADD notes NVARCHAR(MAX) NULL;
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'tags_json')
    ALTER TABLE companies ADD tags_json NVARCHAR(MAX) NULL;
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'validation_reason')
    ALTER TABLE companies ADD validation_reason NVARCHAR(500) NULL;
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'full_result_json')
    ALTER TABLE company_enrichments ADD full_result_json NVARCHAR(MAX) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_companies_name_city' AND object_id = OBJECT_ID('companies'))
    ALTER TABLE companies ADD CONSTRAINT UQ_companies_name_city UNIQUE (name, city);
GO
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE type = 'U' AND name = 'existing_clients')
CREATE TABLE existing_clients (
    id               UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    company_name     NVARCHAR(300)    NOT NULL,
    normalized_name  NVARCHAR(300)    NOT NULL,
    city             NVARCHAR(150)    NULL,
    phone            NVARCHAR(50)     NULL,
    normalized_phone NVARCHAR(50)     NULL,
    contact_name     NVARCHAR(200)    NULL,
    email            NVARCHAR(200)    NULL,
    notes            NVARCHAR(MAX)    NULL,
    uploaded_at      DATETIME2        NOT NULL DEFAULT GETDATE()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_existing_clients_phone' AND object_id = OBJECT_ID('existing_clients'))
    CREATE INDEX ix_existing_clients_phone ON existing_clients (normalized_phone);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_existing_clients_name_city' AND object_id = OBJECT_ID('existing_clients'))
    CREATE INDEX ix_existing_clients_name_city ON existing_clients (normalized_name, city);
GO
PRINT 'DeepLeadRPA database bootstrap complete.';
GO
