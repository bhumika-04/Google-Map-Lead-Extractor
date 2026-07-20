-- ============================================================
-- LeadScout AI — Phase 3 Add-Ons Migration
-- New feature: LinkedIn Business Intelligence
--
-- Stores publicly-visible LinkedIn company profile data, company
-- activity (last 6 months), core team members, and core-member
-- activity captured by the extension's automated LinkedIn scraper
-- (src/content/linkedinScraper.ts + src/services/linkedinScraperService.ts).
--
-- Compliance: the scraper never bypasses login/captcha/paywall/robots
-- restrictions or private pages — any field not visibly present on the
-- page is captured client-side as 'Not Available' rather than inferred.
--
-- Safe to re-run: all blocks use IF NOT EXISTS / IF EXISTS guards.
-- Run AFTER schema.sql, schema_v2_addons.sql, schema_v3_research_evidence.sql.
-- Run in SSMS against the 'deeplead' database.
-- ============================================================

USE deeplead;
GO

-- ─── 1. LinkedIn Company Profiles ────────────────────────────────────────────
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

PRINT '✓ linkedin_company_profiles table ready';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_linkedin_company_profiles_company')
    CREATE UNIQUE INDEX ix_linkedin_company_profiles_company
        ON linkedin_company_profiles (company_id);
GO

-- ─── 2. LinkedIn Company Posts ───────────────────────────────────────────────
-- Append-only — one row per public company post captured (last 6 months).

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

PRINT '✓ linkedin_company_posts table ready';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_linkedin_company_posts_company')
    CREATE INDEX ix_linkedin_company_posts_company
        ON linkedin_company_posts (company_id, within_six_months);
GO

-- ─── 3. LinkedIn People ───────────────────────────────────────────────────────
-- One current row per (company, person) — core team members identified by title.

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

PRINT '✓ linkedin_people table ready';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_linkedin_people_company')
    CREATE INDEX ix_linkedin_people_company
        ON linkedin_people (company_id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_linkedin_people_company_url')
    CREATE UNIQUE INDEX ux_linkedin_people_company_url
        ON linkedin_people (company_id, linkedin_url) WHERE linkedin_url IS NOT NULL;
GO

-- ─── 4. LinkedIn Person Posts ────────────────────────────────────────────────
-- Append-only — one row per public post on a core person's profile (last 6 months).

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

PRINT '✓ linkedin_person_posts table ready';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_linkedin_person_posts_company')
    CREATE INDEX ix_linkedin_person_posts_company
        ON linkedin_person_posts (company_id, within_six_months);
GO

-- ─── 5. Upsert proc for linkedin_company_profiles ────────────────────────────

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

PRINT '✓ usp_upsert_linkedin_company_profile procedure ready';
GO

-- ─── 6. Upsert proc for linkedin_people ──────────────────────────────────────

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

PRINT '✓ usp_upsert_linkedin_person procedure ready';
GO

-- ─── 7. Helpful queries for verification ─────────────────────────────────────

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
