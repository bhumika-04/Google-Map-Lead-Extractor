/* ============================================================================
   DeepLeadRPA — CLEAN DATA + RESEED IDENTITIES (keep schema)
   ----------------------------------------------------------------------------
   Deletes every row from every table but leaves the schema (tables, indexes,
   views, constraints) exactly as-is, then resets each IDENTITY column so the
   next inserted row gets id = 1 again.

   Unlike drop_all_tables.sql, this does NOT touch table structure — use this
   when you just want an empty database to start capturing fresh, not a
   schema rebuild.

   WARNING: irreversible — all rows in every DeepLeadRPA table are deleted.

   Usage: sqlcmd -S <server> -d DeepLeadRPA -i clean_database.sql
   ============================================================================ */

USE DeepLeadRPA;
GO

-- Deleted in child-before-parent order so foreign keys never block a DELETE
-- (sessions -> scraped_leads/imported_leads is ON DELETE CASCADE, but the
-- rest are not, so order matters here).

DELETE FROM dbo.conversation_messages;
DELETE FROM dbo.outreach_conversations;

DELETE FROM dbo.nurture_sequences;
DELETE FROM dbo.nurture_templates;

DELETE FROM dbo.scraped_leads;
DELETE FROM dbo.imported_leads;
DELETE FROM dbo.sessions;

DELETE FROM dbo.existing_clients;
GO

-- Reseed every IDENTITY column back to 0 so the next insert starts at 1.
DBCC CHECKIDENT ('dbo.conversation_messages', RESEED, 0);
DBCC CHECKIDENT ('dbo.outreach_conversations', RESEED, 0);
DBCC CHECKIDENT ('dbo.nurture_sequences', RESEED, 0);
DBCC CHECKIDENT ('dbo.nurture_templates', RESEED, 0);
DBCC CHECKIDENT ('dbo.scraped_leads', RESEED, 0);
DBCC CHECKIDENT ('dbo.imported_leads', RESEED, 0);
DBCC CHECKIDENT ('dbo.sessions', RESEED, 0);
DBCC CHECKIDENT ('dbo.existing_clients', RESEED, 0);
GO

PRINT 'DeepLeadRPA data cleared, all identities reseeded to 0.';
GO
