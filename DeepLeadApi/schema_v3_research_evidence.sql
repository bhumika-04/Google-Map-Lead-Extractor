-- ============================================================
-- LeadScout AI — Phase 3 Add-Ons Migration
-- New feature: Evidence-Based Company Research Pipeline
--
-- Mirrors the extension's IndexedDB tables (searchEvidence,
-- sourcePages, companyResearch — db.ts version 7) so the same
-- evidence trail can be persisted to MSSQL for reporting/backup.
--
-- Safe to re-run: all blocks use IF NOT EXISTS / IF EXISTS guards.
-- Run AFTER schema.sql and schema_v2_addons.sql (base schema must
-- already exist).
-- Run in SSMS against the 'deeplead' database.
-- ============================================================

USE deeplead;
GO

-- ─── 1. Search Evidence ──────────────────────────────────────────────────────
-- One row per Google search result captured for a company (accepted AND
-- rejected — rejected rows keep reject_reason for auditability, so a wrong-
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

PRINT '✓ search_evidence table ready';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_search_evidence_company')
    CREATE INDEX ix_search_evidence_company
        ON search_evidence (company_id, rank);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_search_evidence_type')
    CREATE INDEX ix_search_evidence_type
        ON search_evidence (detected_type, rejected);
GO

PRINT '✓ search_evidence indexes ready';
GO

-- ─── 2. Source Pages ─────────────────────────────────────────────────────────
-- One row per source link actually opened (a subset of search_evidence —
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

PRINT '✓ source_pages table ready';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_source_pages_company')
    CREATE INDEX ix_source_pages_company
        ON source_pages (company_id, status);
GO

PRINT '✓ source_pages indexes ready';
GO

-- ─── 3. Company Research ─────────────────────────────────────────────────────
-- One row per company — the merged, confidence-weighted result of all
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

PRINT '✓ company_research table ready';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_company_research_company')
    CREATE INDEX ix_company_research_company
        ON company_research (company_id);
GO

PRINT '✓ company_research indexes ready';
GO

-- ─── 4. Upsert proc for company_research ─────────────────────────────────────
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

PRINT '✓ usp_upsert_company_research procedure ready';
GO

-- ─── 5. Updated pipeline view ────────────────────────────────────────────────
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

PRINT '✓ vw_lead_pipeline updated with evidence-research columns';
GO

-- ─── 6. Helpful queries for verification ─────────────────────────────────────
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
