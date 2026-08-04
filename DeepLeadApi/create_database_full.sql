/* ============================================================================
   DeepLeadRPA — full schema (clean redesign)
   ----------------------------------------------------------------------------
   Model:
     sessions        one row per Search Console run OR import batch
     scraped_leads   Google Maps automation output      (session_id -> sessions)
     imported_leads  CSV/Excel uploads, self-contained  (session_id -> sessions)

   Each lead row carries its FULL lifecycle inline:
     capture -> enrichment (AI) -> validation (ICP) -> deep research
   "Validated" / "Researched" leads are STATES of a row (columns + views),
   never duplicated into separate tables.

   Auxiliary (outreach / nurture / existing clients) reference a lead
   polymorphically via (lead_id, lead_source) since leads live in two tables.

   Run drop_all_tables.sql first for a clean slate.
   Requires SQL Server 2016+ (CREATE OR ALTER, filtered indexes).
   Usage: sqlcmd -S <server> -d DeepLeadRPA -i create_database_full.sql
   ============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;   -- required for the filtered unique indexes below
GO

/* ═══ 1. SESSIONS ═══════════════════════════════════════════════════════════ */
IF OBJECT_ID('dbo.sessions', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.sessions (
    id                INT IDENTITY(1,1) PRIMARY KEY,
    name              NVARCHAR(200)  NOT NULL,
    source            NVARCHAR(20)   NOT NULL CONSTRAINT DF_sessions_source DEFAULT 'scrape', -- 'scrape' | 'import'
    country           NVARCHAR(10)   NULL,
    keywords_json     NVARCHAR(MAX)  NULL,                                                     -- ["Printing","Packaging"]
    cities_json       NVARCHAR(MAX)  NULL,                                                     -- ["Mumbai","Delhi"]
    business_profile  NVARCHAR(MAX)  NULL,                                                     -- per-session ICP prompt
    status            NVARCHAR(20)   NOT NULL CONSTRAINT DF_sessions_status DEFAULT 'active',  -- active|running|completed|stopped
    total_leads       INT            NOT NULL CONSTRAINT DF_sessions_total DEFAULT 0,
    created_at        DATETIME2      NOT NULL CONSTRAINT DF_sessions_created DEFAULT SYSUTCDATETIME(),
    completed_at      DATETIME2      NULL
  );
END
GO

/* ═══ 2. SCRAPED_LEADS ══════════════════════════════════════════════════════ */
IF OBJECT_ID('dbo.scraped_leads', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.scraped_leads (
    id                    INT IDENTITY(1,1) PRIMARY KEY,
    session_id            INT NOT NULL,
    -- Core (Google Maps)
    company_name          NVARCHAR(300)  NOT NULL,
    normalized_name       NVARCHAR(120)  NOT NULL,
    category              NVARCHAR(200)  NULL,
    rating                DECIMAL(3,2)   NULL,
    review_count          INT            NULL,
    address               NVARCHAR(500)  NULL,
    phone                 NVARCHAR(60)   NULL,
    website               NVARCHAR(500)  NULL,
    google_maps_url       NVARCHAR(1000) NULL,
    map_score             INT            NULL,
    city                  NVARCHAR(120)  NULL,
    keyword               NVARCHAR(200)  NULL,
    country               NVARCHAR(10)   NULL,
    -- Pipeline state
    status                NVARCHAR(30)   NOT NULL CONSTRAINT DF_scraped_status DEFAULT 'new',
    notes                 NVARCHAR(MAX)  NULL,
    tags_json             NVARCHAR(MAX)  NULL,
    -- Enrichment (AI) — scalar
    team_size             NVARCHAR(50)   NULL,
    annual_turnover       NVARCHAR(80)   NULL,
    industry              NVARCHAR(200)  NULL,
    decision_maker        NVARCHAR(200)  NULL,
    email                 NVARCHAR(200)  NULL,
    alternate_phone       NVARCHAR(60)   NULL,
    year_founded          INT            NULL,
    company_type          NVARCHAR(80)   NULL,
    employee_count        NVARCHAR(50)   NULL,
    headquarters          NVARCHAR(200)  NULL,
    linkedin              NVARCHAR(500)  NULL,
    facebook              NVARCHAR(500)  NULL,
    instagram             NVARCHAR(500)  NULL,
    twitter               NVARCHAR(500)  NULL,
    youtube               NVARCHAR(500)  NULL,
    whatsapp              NVARCHAR(200)  NULL,
    -- Enrichment (AI) — variable/rich (services, certifications, major_clients,
    -- team_members, pain_points, expansion_signals, current_software)
    enrichment_json       NVARCHAR(MAX)  NULL,
    enrichment_status     NVARCHAR(20)   NOT NULL CONSTRAINT DF_scraped_enrst DEFAULT 'pending', -- pending|done|failed|skipped
    enrichment_confidence DECIMAL(4,3)   NULL,
    enriched_at           DATETIME2      NULL,
    -- Validation / ICP
    validation_status     NVARCHAR(20)   NULL,   -- NULL = not validated; else relevant|not_relevant
    icp_score             INT            NULL,   -- 0..100
    icp_status            NVARCHAR(30)   NULL,   -- High Priority|Good Lead|Low Priority|Reject
    icp_reason            NVARCHAR(MAX)  NULL,
    score_breakdown_json  NVARCHAR(MAX)  NULL,
    validated_at          DATETIME2      NULL,
    -- Deep research
    research_status       NVARCHAR(20)   NOT NULL CONSTRAINT DF_scraped_resst DEFAULT 'none', -- none|queued|running|completed|failed
    research_summary      NVARCHAR(MAX)  NULL,
    research_json         NVARCHAR(MAX)  NULL,   -- full deep result + sources visited
    research_confidence   DECIMAL(4,3)   NULL,
    researched_at         DATETIME2      NULL,
    -- Timestamps
    captured_at           DATETIME2      NOT NULL CONSTRAINT DF_scraped_captured DEFAULT SYSUTCDATETIME(),
    updated_at            DATETIME2      NOT NULL CONSTRAINT DF_scraped_updated DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_scraped_session FOREIGN KEY (session_id) REFERENCES dbo.sessions(id) ON DELETE CASCADE
  );
END
GO

/* ═══ 3. IMPORTED_LEADS ═════════════════════════════════════════════════════ */
IF OBJECT_ID('dbo.imported_leads', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.imported_leads (
    id                    INT IDENTITY(1,1) PRIMARY KEY,
    session_id            INT NOT NULL,
    import_file           NVARCHAR(300)  NULL,
    source_row_json       NVARCHAR(MAX)  NULL,   -- original CSV/Excel row, for audit
    -- Core
    company_name          NVARCHAR(300)  NOT NULL,
    normalized_name       NVARCHAR(120)  NOT NULL,
    category              NVARCHAR(200)  NULL,
    rating                DECIMAL(3,2)   NULL,
    review_count          INT            NULL,
    address               NVARCHAR(500)  NULL,
    phone                 NVARCHAR(60)   NULL,
    website               NVARCHAR(500)  NULL,
    google_maps_url       NVARCHAR(1000) NULL,
    map_score             INT            NULL,
    city                  NVARCHAR(120)  NULL,
    keyword               NVARCHAR(200)  NULL,
    country               NVARCHAR(10)   NULL,
    -- Pipeline state (import target page sets the starting status:
    --   Lead Database -> 'new', Selected Leads -> 'selected', Research Queue -> 'research_queued')
    status                NVARCHAR(30)   NOT NULL CONSTRAINT DF_imported_status DEFAULT 'new',
    notes                 NVARCHAR(MAX)  NULL,
    tags_json             NVARCHAR(MAX)  NULL,
    -- Enrichment (AI) — scalar
    team_size             NVARCHAR(50)   NULL,
    annual_turnover       NVARCHAR(80)   NULL,
    industry              NVARCHAR(200)  NULL,
    decision_maker        NVARCHAR(200)  NULL,
    email                 NVARCHAR(200)  NULL,
    alternate_phone       NVARCHAR(60)   NULL,
    year_founded          INT            NULL,
    company_type          NVARCHAR(80)   NULL,
    employee_count        NVARCHAR(50)   NULL,
    headquarters          NVARCHAR(200)  NULL,
    linkedin              NVARCHAR(500)  NULL,
    facebook              NVARCHAR(500)  NULL,
    instagram             NVARCHAR(500)  NULL,
    twitter               NVARCHAR(500)  NULL,
    youtube               NVARCHAR(500)  NULL,
    whatsapp              NVARCHAR(200)  NULL,
    -- Enrichment (AI) — variable/rich
    enrichment_json       NVARCHAR(MAX)  NULL,
    enrichment_status     NVARCHAR(20)   NOT NULL CONSTRAINT DF_imported_enrst DEFAULT 'pending',
    enrichment_confidence DECIMAL(4,3)   NULL,
    enriched_at           DATETIME2      NULL,
    -- Validation / ICP
    validation_status     NVARCHAR(20)   NULL,
    icp_score             INT            NULL,
    icp_status            NVARCHAR(30)   NULL,
    icp_reason            NVARCHAR(MAX)  NULL,
    score_breakdown_json  NVARCHAR(MAX)  NULL,
    validated_at          DATETIME2      NULL,
    -- Deep research (stored inline — this is where an imported lead's research lands)
    research_status       NVARCHAR(20)   NOT NULL CONSTRAINT DF_imported_resst DEFAULT 'none',
    research_summary      NVARCHAR(MAX)  NULL,
    research_json         NVARCHAR(MAX)  NULL,
    research_confidence   DECIMAL(4,3)   NULL,
    researched_at         DATETIME2      NULL,
    -- Timestamps
    imported_at           DATETIME2      NOT NULL CONSTRAINT DF_imported_at DEFAULT SYSUTCDATETIME(),
    updated_at            DATETIME2      NOT NULL CONSTRAINT DF_imported_updated DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_imported_session FOREIGN KEY (session_id) REFERENCES dbo.sessions(id) ON DELETE CASCADE
  );
END
GO

/* ═══ 4. EXISTING_CLIENTS ═══ standalone list (exclude / compare) ════════════ */
IF OBJECT_ID('dbo.existing_clients', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.existing_clients (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    company_name    NVARCHAR(300) NOT NULL,
    normalized_name NVARCHAR(120) NOT NULL,
    city            NVARCHAR(120) NULL,
    phone           NVARCHAR(60)  NULL,
    website         NVARCHAR(500) NULL,
    notes           NVARCHAR(MAX) NULL,
    created_at      DATETIME2     NOT NULL CONSTRAINT DF_exclient_created DEFAULT SYSUTCDATETIME()
  );
END
GO

/* ═══ 5. OUTREACH ═══ conversations + messages (polymorphic lead ref) ════════ */
IF OBJECT_ID('dbo.outreach_conversations', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.outreach_conversations (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    lead_id         INT           NOT NULL,
    lead_source     NVARCHAR(20)  NOT NULL,   -- 'scraped' | 'imported'
    channel         NVARCHAR(30)  NOT NULL CONSTRAINT DF_conv_channel DEFAULT 'whatsapp',
    contact_name    NVARCHAR(200) NULL,
    contact_phone   NVARCHAR(60)  NULL,
    status          NVARCHAR(30)  NOT NULL CONSTRAINT DF_conv_status DEFAULT 'active',
    last_message_at DATETIME2     NULL,
    created_at      DATETIME2     NOT NULL CONSTRAINT DF_conv_created DEFAULT SYSUTCDATETIME()
  );
END
GO

IF OBJECT_ID('dbo.conversation_messages', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.conversation_messages (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    conversation_id INT           NOT NULL,
    direction       NVARCHAR(10)  NOT NULL,   -- 'in' | 'out'
    body            NVARCHAR(MAX) NULL,
    status          NVARCHAR(30)  NULL,       -- sent|delivered|read|failed
    sent_at         DATETIME2     NOT NULL CONSTRAINT DF_msg_sent DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_msg_conversation FOREIGN KEY (conversation_id) REFERENCES dbo.outreach_conversations(id) ON DELETE CASCADE
  );
END
GO

/* ═══ 6. NURTURE ═══ templates + per-lead sequences (follow-ups) ═════════════ */
IF OBJECT_ID('dbo.nurture_templates', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.nurture_templates (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    name        NVARCHAR(200) NOT NULL,
    channel     NVARCHAR(30)  NOT NULL CONSTRAINT DF_tmpl_channel DEFAULT 'whatsapp',
    body        NVARCHAR(MAX) NOT NULL,
    created_at  DATETIME2     NOT NULL CONSTRAINT DF_tmpl_created DEFAULT SYSUTCDATETIME()
  );
END
GO

IF OBJECT_ID('dbo.nurture_sequences', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.nurture_sequences (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    lead_id        INT          NOT NULL,
    lead_source    NVARCHAR(20) NOT NULL,   -- 'scraped' | 'imported'
    template_id    INT          NULL,
    status         NVARCHAR(30) NOT NULL CONSTRAINT DF_seq_status DEFAULT 'scheduled', -- scheduled|sent|done|cancelled
    next_action_at DATETIME2    NULL,
    notes          NVARCHAR(MAX) NULL,
    created_at     DATETIME2    NOT NULL CONSTRAINT DF_seq_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_seq_template FOREIGN KEY (template_id) REFERENCES dbo.nurture_templates(id)
  );
END
GO

/* ═══ INDEXES ═══════════════════════════════════════════════════════════════ */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_scraped_session' AND object_id=OBJECT_ID('dbo.scraped_leads'))
  CREATE INDEX IX_scraped_session ON dbo.scraped_leads(session_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_scraped_status' AND object_id=OBJECT_ID('dbo.scraped_leads'))
  CREATE INDEX IX_scraped_status ON dbo.scraped_leads(session_id, status);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_scraped_validation' AND object_id=OBJECT_ID('dbo.scraped_leads'))
  CREATE INDEX IX_scraped_validation ON dbo.scraped_leads(session_id, validation_status);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_scraped_research' AND object_id=OBJECT_ID('dbo.scraped_leads'))
  CREATE INDEX IX_scraped_research ON dbo.scraped_leads(session_id, research_status);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UQ_scraped_dedupe' AND object_id=OBJECT_ID('dbo.scraped_leads'))
  CREATE UNIQUE INDEX UQ_scraped_dedupe ON dbo.scraped_leads(session_id, normalized_name) WHERE normalized_name <> '';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_imported_session' AND object_id=OBJECT_ID('dbo.imported_leads'))
  CREATE INDEX IX_imported_session ON dbo.imported_leads(session_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_imported_status' AND object_id=OBJECT_ID('dbo.imported_leads'))
  CREATE INDEX IX_imported_status ON dbo.imported_leads(session_id, status);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_imported_validation' AND object_id=OBJECT_ID('dbo.imported_leads'))
  CREATE INDEX IX_imported_validation ON dbo.imported_leads(session_id, validation_status);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_imported_research' AND object_id=OBJECT_ID('dbo.imported_leads'))
  CREATE INDEX IX_imported_research ON dbo.imported_leads(session_id, research_status);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_exclient_norm' AND object_id=OBJECT_ID('dbo.existing_clients'))
  CREATE INDEX IX_exclient_norm ON dbo.existing_clients(normalized_name);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_conv_lead' AND object_id=OBJECT_ID('dbo.outreach_conversations'))
  CREATE INDEX IX_conv_lead ON dbo.outreach_conversations(lead_source, lead_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_msg_conv' AND object_id=OBJECT_ID('dbo.conversation_messages'))
  CREATE INDEX IX_msg_conv ON dbo.conversation_messages(conversation_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_seq_lead' AND object_id=OBJECT_ID('dbo.nurture_sequences'))
  CREATE INDEX IX_seq_lead ON dbo.nurture_sequences(lead_source, lead_id);
GO

/* ═══ VIEWS ═══ "validated" / "researched" are states, surfaced as views ═════ */
CREATE OR ALTER VIEW dbo.v_scraped_relevant    AS SELECT * FROM dbo.scraped_leads  WHERE validation_status = 'relevant';
GO
CREATE OR ALTER VIEW dbo.v_scraped_researched  AS SELECT * FROM dbo.scraped_leads  WHERE research_status  = 'completed';
GO
CREATE OR ALTER VIEW dbo.v_imported_relevant   AS SELECT * FROM dbo.imported_leads WHERE validation_status = 'relevant';
GO
CREATE OR ALTER VIEW dbo.v_imported_researched AS SELECT * FROM dbo.imported_leads WHERE research_status  = 'completed';
GO

PRINT 'DeepLeadRPA schema created.';
GO
