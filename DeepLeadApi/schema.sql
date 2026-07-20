-- ============================================================
-- Google Map Lead Extractor — Complete Database Schema
-- Run this in SSMS against the 'deeplead' database
-- Safe to re-run multiple times — all checks use IF NOT EXISTS
-- ============================================================

USE deeplead;
GO

-- ── 1. Search Projects ────────────────────────────────────────
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

-- ── 2. Companies ──────────────────────────────────────────────
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

-- ── 3. Company Enrichments ────────────────────────────────────
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

-- ── 4. Company Contacts ───────────────────────────────────────
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

-- ── 5. Deep Research / Social Intelligence ────────────────────
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

-- ── 6. Outreach Conversations ─────────────────────────────────
-- Stage: cold → contacted → replied → nurturing → meeting_scheduled → won / lost
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

-- ── 7. Conversation Messages ──────────────────────────────────
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

-- ── 8. Nurture Templates ──────────────────────────────────────
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

-- ── Pipeline view ─────────────────────────────────────────────
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
