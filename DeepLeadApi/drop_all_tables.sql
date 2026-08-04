/* ============================================================================
   DeepLeadRPA — DROP EVERYTHING (clean slate)
   ----------------------------------------------------------------------------
   Drops all views, foreign keys, and tables in the current database so
   create_database_full.sql can rebuild from scratch. Does NOT drop the
   database itself (see the DROP DATABASE option at the bottom if you want that).

   WARNING: irreversible — all data in DeepLeadRPA is destroyed.

   Usage: sqlcmd -S <server> -d DeepLeadRPA -i drop_all_tables.sql
   ============================================================================ */

USE DeepLeadRPA;
GO

DECLARE @sql NVARCHAR(MAX);

-- 1) Drop all views
SET @sql = N'';
SELECT @sql += 'DROP VIEW ' + QUOTENAME(SCHEMA_NAME(schema_id)) + '.' + QUOTENAME(name) + ';' + CHAR(10)
FROM sys.views;
IF @sql <> N'' EXEC sp_executesql @sql;

-- 2) Drop all foreign keys (so tables can be dropped in any order)
SET @sql = N'';
SELECT @sql += 'ALTER TABLE ' + QUOTENAME(SCHEMA_NAME(t.schema_id)) + '.' + QUOTENAME(t.name)
             + ' DROP CONSTRAINT ' + QUOTENAME(fk.name) + ';' + CHAR(10)
FROM sys.foreign_keys fk
JOIN sys.tables t ON t.object_id = fk.parent_object_id;
IF @sql <> N'' EXEC sp_executesql @sql;

-- 3) Drop all tables
SET @sql = N'';
SELECT @sql += 'DROP TABLE ' + QUOTENAME(SCHEMA_NAME(schema_id)) + '.' + QUOTENAME(name) + ';' + CHAR(10)
FROM sys.tables;
IF @sql <> N'' EXEC sp_executesql @sql;
GO

PRINT 'All views, foreign keys, and tables dropped from DeepLeadRPA.';
GO

/* ----------------------------------------------------------------------------
   OPTION: drop and recreate the ENTIRE database instead of just its tables.
   Uncomment and run from the master database (needs exclusive access):

   USE master;
   GO
   ALTER DATABASE DeepLeadRPA SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
   DROP DATABASE DeepLeadRPA;
   GO
   CREATE DATABASE DeepLeadRPA;
   GO
   ---------------------------------------------------------------------------- */
