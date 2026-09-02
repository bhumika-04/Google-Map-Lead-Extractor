-- Adds the "Verify from Google" columns to scraped_leads and imported_leads
-- on an EXISTING database. create_database_full.sql only creates these on a
-- fresh install (IF OBJECT_ID(...) IS NULL guards skip it on a DB that
-- already has the tables) -- run this once against a live database to add
-- them without touching any existing data. Safe to re-run.

IF COL_LENGTH('dbo.scraped_leads', 'team_size_verified') IS NULL
  ALTER TABLE dbo.scraped_leads ADD team_size_verified BIT NULL;
IF COL_LENGTH('dbo.scraped_leads', 'team_size_estimate') IS NULL
  ALTER TABLE dbo.scraped_leads ADD team_size_estimate NVARCHAR(50) NULL;
IF COL_LENGTH('dbo.scraped_leads', 'turnover_verified') IS NULL
  ALTER TABLE dbo.scraped_leads ADD turnover_verified BIT NULL;
IF COL_LENGTH('dbo.scraped_leads', 'annual_turnover_estimate') IS NULL
  ALTER TABLE dbo.scraped_leads ADD annual_turnover_estimate NVARCHAR(80) NULL;
GO

IF COL_LENGTH('dbo.imported_leads', 'team_size_verified') IS NULL
  ALTER TABLE dbo.imported_leads ADD team_size_verified BIT NULL;
IF COL_LENGTH('dbo.imported_leads', 'team_size_estimate') IS NULL
  ALTER TABLE dbo.imported_leads ADD team_size_estimate NVARCHAR(50) NULL;
IF COL_LENGTH('dbo.imported_leads', 'turnover_verified') IS NULL
  ALTER TABLE dbo.imported_leads ADD turnover_verified BIT NULL;
IF COL_LENGTH('dbo.imported_leads', 'annual_turnover_estimate') IS NULL
  ALTER TABLE dbo.imported_leads ADD annual_turnover_estimate NVARCHAR(80) NULL;
GO
