-- schema_v5_icp_fields.sql
-- Adds ICP scoring columns and enrichment columns to the companies table.
-- Run this ONCE against the deeplead database after deploying schema_v4_linkedin_intelligence.sql.

USE deeplead;
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
    ALTER TABLE companies ADD annual_turnover NVARCHAR(100) NULL;  -- e.g. "₹10-50 Cr"

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
