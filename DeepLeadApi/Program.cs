using Dapper;
using Microsoft.Data.SqlClient;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

var builder = WebApplication.CreateBuilder(args);

// Allow Chrome extension (chrome-extension://*) to call this local API
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.SetIsOriginAllowed(_ => true)
     .AllowAnyMethod()
     .AllowAnyHeader()));

var app = builder.Build();
app.UseCors();

var connStr = builder.Configuration.GetConnectionString("DefaultConnection")!;

// ─── Schema migrations (idempotent) ───────────────────────────────────────────
// Add new columns to existing tables without dropping/recreating them.
{
    using var db = new SqlConnection(connStr);
    await db.ExecuteAsync("""
        IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'notes')
            ALTER TABLE companies ADD notes NVARCHAR(MAX) NULL;
        IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'tags_json')
            ALTER TABLE companies ADD tags_json NVARCHAR(MAX) NULL;
        IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'validation_reason')
            ALTER TABLE companies ADD validation_reason NVARCHAR(500) NULL;
        IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('company_enrichments') AND name = 'full_result_json')
            ALTER TABLE company_enrichments ADD full_result_json NVARCHAR(MAX) NULL;

        -- Unique constraint so concurrent inserts for same name+city don't create duplicates
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_companies_name_city' AND object_id = OBJECT_ID('companies'))
            ALTER TABLE companies ADD CONSTRAINT UQ_companies_name_city UNIQUE (name, city);

        -- Existing-clients list (people/companies already in touch with) — used to
        -- hard-block duplicate outreach. Separate from 'companies' since these aren't leads.
        IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE type = 'U' AND name = 'existing_clients')
        CREATE TABLE existing_clients (
            id              UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
            company_name    NVARCHAR(300)    NOT NULL,
            normalized_name NVARCHAR(300)    NOT NULL,
            city            NVARCHAR(150)    NULL,
            phone           NVARCHAR(50)     NULL,
            normalized_phone NVARCHAR(50)    NULL,
            contact_name    NVARCHAR(200)    NULL,
            email           NVARCHAR(200)    NULL,
            notes           NVARCHAR(MAX)    NULL,
            uploaded_at     DATETIME2        NOT NULL DEFAULT GETDATE()
        );

        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_existing_clients_phone' AND object_id = OBJECT_ID('existing_clients'))
            CREATE INDEX ix_existing_clients_phone ON existing_clients (normalized_phone);
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_existing_clients_name_city' AND object_id = OBJECT_ID('existing_clients'))
            CREATE INDEX ix_existing_clients_name_city ON existing_clients (normalized_name, city);

        -- Search Sessions ("runs") — one row per Start click in the extension's
        -- Search Console or per batch campaign. Groups companies by run so the
        -- extension's per-session workspaces survive a full restore from MSSQL.
        -- Distinct from search_projects (which is one row per keyword+city term).
        IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE type = 'U' AND name = 'search_runs')
        CREATE TABLE search_runs (
            id               INT IDENTITY(1,1) PRIMARY KEY,
            name             NVARCHAR(300)  NOT NULL,
            country          NVARCHAR(10)   NULL,
            business_profile NVARCHAR(MAX)  NULL,
            status           NVARCHAR(20)   NOT NULL DEFAULT 'running',
            total_leads      INT            NOT NULL DEFAULT 0,
            created_at       DATETIME2      NOT NULL DEFAULT GETDATE(),
            completed_at     DATETIME2      NULL
        );

        IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'run_id')
            ALTER TABLE companies ADD run_id INT NULL;
        """);
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.MapGet("/api/health", () => new { ok = true, time = DateTime.UtcNow });

// ─── Config endpoint ──────────────────────────────────────────────────────────
// Returns ALL extension config — API keys, business profile, integrations.
// Extension has no Settings UI; everything lives in appsettings.json here.
app.MapGet("/api/config", () =>
{
    var geminiKey        = builder.Configuration["Gemini:ApiKey"];
    var geminiModel      = builder.Configuration["Gemini:Model"] ?? "gemini-flash-latest";
    var openAiKey        = builder.Configuration["OpenAI:ApiKey"];
    var openAiModel      = builder.Configuration["OpenAI:Model"] ?? "gpt-4o-mini";
    var anthropicKey     = builder.Configuration["Anthropic:ApiKey"];
    var anthropicModel   = builder.Configuration["Anthropic:Model"] ?? "claude-haiku-4-5-20251001";
    var businessProfile  = builder.Configuration["App:BusinessProfile"];
    var interaktKey      = builder.Configuration["Interakt:ApiKey"];
    var interaktTemplate = builder.Configuration["Interakt:TemplateName"];
    var interaktCountry  = builder.Configuration["Interakt:CountryCode"] ?? "+91";
    var crmApiUrl        = builder.Configuration["CRM:ApiUrl"];
    var crmApiKey        = builder.Configuration["CRM:ApiKey"];
    var crmAuthType      = builder.Configuration["CRM:AuthType"] ?? "bearer";

    var useGemini    = !string.IsNullOrWhiteSpace(geminiKey);
    var useAnthropic = !string.IsNullOrWhiteSpace(anthropicKey);
    var useOpenAi    = !string.IsNullOrWhiteSpace(openAiKey);
    // Explicit override in appsettings.json wins; fall back to auto-detect by key presence
    var explicitProvider = builder.Configuration["ResearchProvider"];
    var provider = explicitProvider switch {
        "openai"    when useOpenAi    => "openai",
        "anthropic" when useAnthropic => "anthropic",
        "gemini"    when useGemini    => "gemini",
        _           => useGemini ? "gemini" : (useAnthropic ? "anthropic" : "openai"),
    };

    return new
    {
        researchProvider     = provider,
        geminiApiKey         = geminiKey,
        geminiModel,
        openAiApiKey         = openAiKey,
        openAiModel,
        anthropicApiKey      = anthropicKey,
        anthropicModel,
        hasKey               = useGemini || useAnthropic || !string.IsNullOrWhiteSpace(openAiKey),
        businessProfile,
        interaktApiKey       = interaktKey,
        interaktTemplateName = interaktTemplate,
        interaktCountryCode  = interaktCountry,
        crmApiUrl,
        crmApiKey,
        crmAuthType,
    };
});

// Persists the business profile (used as the ICP validation prompt's "MY BUSINESS"
// section) directly into appsettings.json's App:BusinessProfile key — so it survives
// API restarts and stays the single source of truth (extension has no local Settings
// storage for this field; see BACKEND_FIELDS in useSettingsStore.ts). The JSON config
// provider reloads on file change, so the running process picks this up immediately
// without needing a restart.
app.MapPost("/api/config/business-profile", async (BusinessProfileUpdate body) =>
{
    var path = Path.Combine(builder.Environment.ContentRootPath, "appsettings.json");
    var json = await File.ReadAllTextAsync(path);
    var root = JsonNode.Parse(json)!.AsObject();

    if (root["App"] is not JsonObject appSection)
    {
        appSection = new JsonObject();
        root["App"] = appSection;
    }
    appSection["BusinessProfile"] = body.BusinessProfile;

    var options = new JsonSerializerOptions { WriteIndented = true };
    await File.WriteAllTextAsync(path, root.ToJsonString(options));

    return Results.Ok(new { ok = true });
});

// ─── Sync endpoint ────────────────────────────────────────────────────────────
app.MapPost("/api/sync", async (SyncPayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);

        // 1. Upsert search_project
        var projectId = await UpsertProject(db, payload.Session);

        // 2. Upsert companies
        var companyIdMap = new Dictionary<int, Guid>();
        foreach (var lead in payload.Leads)
        {
            var companyId = await UpsertCompany(db, lead, projectId);
            companyIdMap[lead.Id] = companyId;
        }

        // 3. Upsert enrichments + contacts
        foreach (var r in payload.ResearchResults)
        {
            if (!companyIdMap.TryGetValue(r.LeadId, out var companyId)) continue;
            await UpsertEnrichment(db, r, companyId);
            if (!string.IsNullOrWhiteSpace(r.DecisionMaker))
                await UpsertContact(db, r, companyId);
        }

        // Return the leadId → companyId map so the extension can persist mssqlId on each lead
        var leadIdMap = companyIdMap.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value.ToString());

        return Results.Ok(new
        {
            ok = true,
            synced = payload.Leads.Count,
            enrichments = payload.ResearchResults.Count,
            projectId,
            leadIdMap
        });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Sync failed");
    }
});

// ─── Restore endpoint ─────────────────────────────────────────────────────────
// Called by extension on reinstall to pull all leads + research back from MSSQL.
app.MapGet("/api/restore", async () =>
{
    try
    {
        using var db = new SqlConnection(connStr);

        var companies = await db.QueryAsync<dynamic>("""
            SELECT
                c.id                 AS companyId,
                c.name               AS companyName,
                c.address,
                c.phone,
                c.website,
                c.google_maps_url    AS googleMapsUrl,
                c.rating,
                c.review_count       AS reviewCount,
                c.category,
                c.city,
                c.validation_status  AS validationStatus,
                c.enrichment_status  AS enrichmentStatus,
                c.notes,
                c.tags_json          AS tagsJson,
                c.validation_reason  AS validationReason,
                c.run_id             AS runId,
                p.name               AS sessionName,
                p.keywords           AS keyword,
                p.city               AS sessionCity,
                p.created_at         AS sessionCreatedAt
            FROM companies c
            LEFT JOIN search_projects p ON c.project_id = p.id
            ORDER BY c.created_at DESC
            """);

        var enrichments = await db.QueryAsync<dynamic>("""
            SELECT
                c.id                       AS companyId,
                e.official_website         AS website,
                e.email,
                e.alternate_phone          AS alternatePhone,
                e.whatsapp,
                e.linkedin_url             AS linkedIn,
                e.facebook_url             AS facebook,
                e.instagram_url            AS instagram,
                e.youtube_url              AS youtube,
                e.twitter_url              AS twitter,
                e.owner_name               AS decisionMaker,
                e.owner_linkedin           AS decisionMakerLinkedIn,
                e.industry,
                e.tagline,
                e.products_services        AS services,
                e.team_size                AS employeeCount,
                e.established_year         AS yearFounded,
                e.business_type            AS companyType,
                e.supplier_type            AS supplierBuyerType,
                e.description              AS summary,
                e.annual_turnover          AS annualTurnover,
                e.headquarters,
                e.team_members_json        AS teamMembersJson,
                e.certifications_json      AS certificationsJson,
                e.major_clients_json       AS majorClientsJson,
                e.expansion_signals_json   AS expansionSignalsJson,
                e.current_software_json    AS currentSoftwareJson,
                e.export_markets_json      AS exportMarketsJson,
                e.pain_points_json         AS painPointsJson,
                e.services_json            AS servicesJson,
                e.overall_confidence       AS confidence,
                e.enriched_at              AS enrichedAt,
                e.full_result_json         AS fullResultJson
            FROM company_enrichments e
            JOIN companies c ON e.company_id = c.id
            """);

        var deepResearch = await db.QueryAsync<dynamic>("""
            SELECT
                c.id                           AS companyId,
                dr.full_deep_research_json     AS fullDeepResearchJson,
                dr.recommended_pitch           AS recommendedPitch,
                dr.pitch_template              AS pitchTemplate,
                dr.researched_at               AS researchedAt
            FROM company_deep_research dr
            JOIN companies c ON dr.company_id = c.id
            """);

        return Results.Ok(new { ok = true, companies, enrichments, deepResearch });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Restore failed");
    }
});

// ─── Bulk validation status update ───────────────────────────────────────────
// Called when user confirms "Add N Relevant Leads to Selected".
// Accepts a list of { mssqlId, status } and batch-updates validation_status.

app.MapPost("/api/leads/validate-bulk", async (ValidateBulkPayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        int updated = 0;
        foreach (var item in payload.Updates)
        {
            var rows = await db.ExecuteAsync(
                "UPDATE companies SET validation_status = @status, updated_at = GETDATE() WHERE id = @id",
                new { status = item.Status, id = item.MssqlId });
            updated += rows;
        }
        return Results.Ok(new { ok = true, updated });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Bulk validation failed");
    }
});

// ─── Per-action lead save endpoints ──────────────────────────────────────────
// Called directly when leads are captured or validated — no batch wait needed.

app.MapPost("/api/leads/save", async (LeadSavePayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var projectId = await EnsureProject(db, payload.City, payload.Keyword);
        var companyId = await UpsertCompany(db, new LeadDto(
            payload.Id, payload.CompanyName, payload.Address, payload.Phone,
            payload.Website, payload.GoogleMapsUrl, payload.Rating,
            payload.ReviewCount, payload.Category, payload.City
        ), projectId);

        if (!string.IsNullOrWhiteSpace(payload.ValidationStatus))
        {
            await db.ExecuteAsync(
                "UPDATE companies SET validation_status = @status, updated_at = GETDATE() WHERE id = @id",
                new { status = payload.ValidationStatus, id = companyId });
        }

        // Persist notes, tags, validationReason if provided
        if (payload.Notes != null || payload.TagsJson != null || payload.ValidationReason != null)
        {
            await db.ExecuteAsync("""
                UPDATE companies SET
                    notes = COALESCE(@notes, notes),
                    tags_json = COALESCE(@tagsJson, tags_json),
                    validation_reason = COALESCE(@validationReason, validation_reason),
                    updated_at = GETDATE()
                WHERE id = @id
                """, new { notes = payload.Notes, tagsJson = payload.TagsJson, validationReason = payload.ValidationReason, id = companyId });
        }

        return Results.Ok(new { ok = true, companyId });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Lead save failed");
    }
});

// Update notes/tags/validationReason for an existing company (by mssqlId).
app.MapPost("/api/leads/meta", async (LeadMetaPayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        await db.ExecuteAsync("""
            UPDATE companies SET
                notes = COALESCE(@notes, notes),
                tags_json = COALESCE(@tagsJson, tags_json),
                validation_reason = COALESCE(@validationReason, validation_reason),
                updated_at = GETDATE()
            WHERE id = @id
            """, new { notes = payload.Notes, tagsJson = payload.TagsJson, validationReason = payload.ValidationReason, id = payload.MssqlId });
        return Results.Ok(new { ok = true });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Lead meta update failed");
    }
});

app.MapPost("/api/leads/save-batch", async (LeadBatchPayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var projectId = await EnsureProject(db, payload.City, payload.Keyword);
        int saved = 0;
        foreach (var lead in payload.Leads)
        {
            await UpsertCompany(db, new LeadDto(
                lead.Id, lead.CompanyName, lead.Address, lead.Phone,
                lead.Website, lead.GoogleMapsUrl, lead.Rating,
                lead.ReviewCount, lead.Category, payload.City
            ), projectId, payload.RunId);
            saved++;
        }
        return Results.Ok(new { ok = true, saved });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Batch save failed");
    }
});

// NOTE: server-side lightweight enrichment (raw HttpClient scraping of
// google.com/search) was removed — it got blocked with 403/429 from Google
// since it wasn't a real browser. All Google-search scraping now happens
// client-side via real (content-script-driven) browser tabs — see
// leadscout-ai-extension/src/services/websiteFetcher.ts + socialScraper.ts.
// Gemini is only ever called there to extract structured fields from the
// already-fetched page text, never to perform its own search.

// ─── Existing clients (already-in-touch list) ────────────────────────────────
// Uploaded via the dashboard's "Existing Clients" screen. Used to hard-block
// outreach to people the user is already in touch with — never sent to the AI.

static string NormalizeClientName(string s) =>
    Regex.Replace(s.ToLowerInvariant(), "[^a-z0-9\\s]", "").Trim();
static string NormalizeClientPhone(string s) =>
    Regex.Replace(s, "[\\s\\-().+]", "").ToLowerInvariant();

app.MapPost("/api/existing-clients/upload-batch", async (ExistingClientsUploadPayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        int saved = 0;
        foreach (var c in payload.Clients)
        {
            var name = c.CompanyName?.Trim();
            if (string.IsNullOrWhiteSpace(name)) continue;
            var normalizedName = NormalizeClientName(name);
            var normalizedPhone = string.IsNullOrWhiteSpace(c.Phone) ? null : NormalizeClientPhone(c.Phone);

            var exists = await db.ExecuteScalarAsync<int>("""
                SELECT COUNT(1) FROM existing_clients
                WHERE (@normalizedPhone IS NOT NULL AND normalized_phone = @normalizedPhone)
                   OR (normalized_name = @normalizedName AND ISNULL(city, '') = ISNULL(@city, ''))
                """, new { normalizedPhone, normalizedName, city = c.City });
            if (exists > 0) continue;

            await db.ExecuteAsync("""
                INSERT INTO existing_clients
                    (id, company_name, normalized_name, city, phone, normalized_phone, contact_name, email, notes, uploaded_at)
                VALUES
                    (NEWID(), @companyName, @normalizedName, @city, @phone, @normalizedPhone, @contactName, @email, @notes, GETDATE())
                """, new
            {
                companyName = name, normalizedName, city = c.City, phone = c.Phone,
                normalizedPhone, contactName = c.ContactName, email = c.Email, notes = c.Notes,
            });
            saved++;
        }
        return Results.Ok(new { ok = true, saved, skipped = payload.Clients.Count - saved });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Existing clients upload failed");
    }
});

app.MapGet("/api/existing-clients", async () =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var clients = await db.QueryAsync<dynamic>("""
            SELECT id AS mssqlId, company_name AS companyName, normalized_name AS normalizedName,
                   city, phone, normalized_phone AS normalizedPhone, contact_name AS contactName,
                   email, notes, uploaded_at AS uploadedAt
            FROM existing_clients
            ORDER BY uploaded_at DESC
            """);
        return Results.Ok(new { ok = true, clients });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Existing clients fetch failed");
    }
});

app.MapDelete("/api/existing-clients/{id}", async (Guid id) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        await db.ExecuteAsync("DELETE FROM existing_clients WHERE id = @id", new { id });
        return Results.Ok(new { ok = true });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Existing client delete failed");
    }
});

// ─── Research result save ─────────────────────────────────────────────────────
// Saves the complete AI research result to MSSQL — all fields including arrays.
// Called by the extension after research completes so full data survives reinstall.

app.MapPost("/api/research/save", async (ResearchSavePayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);

        // Find the company by Google Maps URL or name+city
        var companyId = await db.ExecuteScalarAsync<Guid?>(
            "SELECT id FROM companies WHERE google_maps_url = @url OR (name = @name AND city = @city)",
            new { url = payload.GoogleMapsUrl, name = payload.CompanyName, city = payload.City });

        if (!companyId.HasValue) return Results.NotFound(new { ok = false, error = "Company not found in DB" });

        await db.ExecuteAsync("""
            MERGE company_enrichments AS target
            USING (SELECT @companyId AS company_id) AS src ON target.company_id = src.company_id
            WHEN MATCHED THEN UPDATE SET
                official_website       = @website,
                email                  = @email,
                alternate_phone        = @alternatePhone,
                whatsapp               = @whatsapp,
                linkedin_url           = @linkedIn,
                facebook_url           = @facebook,
                instagram_url          = @instagram,
                youtube_url            = @youtube,
                twitter_url            = @twitter,
                owner_name             = @decisionMaker,
                owner_linkedin         = @decisionMakerLinkedIn,
                industry               = @industry,
                tagline                = @tagline,
                description            = @summary,
                products_services      = @services,
                business_type          = @companyType,
                supplier_type          = @supplierType,
                team_size              = @employeeCount,
                established_year       = @yearFounded,
                annual_turnover        = @annualTurnover,
                headquarters           = @headquarters,
                team_members_json      = @teamMembersJson,
                certifications_json    = @certificationsJson,
                major_clients_json     = @majorClientsJson,
                expansion_signals_json = @expansionSignalsJson,
                current_software_json  = @currentSoftwareJson,
                export_markets_json    = @exportMarketsJson,
                pain_points_json       = @painPointsJson,
                services_json          = @servicesJson,
                overall_confidence     = @confidence,
                lead_score             = @leadScore,
                full_result_json       = @fullResultJson,
                enriched_at            = GETDATE(),
                updated_at             = GETDATE()
            WHEN NOT MATCHED THEN INSERT (
                id, company_id, official_website, email, alternate_phone, whatsapp,
                linkedin_url, facebook_url, instagram_url, youtube_url, twitter_url,
                owner_name, owner_linkedin, industry, tagline, description, products_services,
                business_type, supplier_type, team_size, established_year, annual_turnover,
                headquarters, team_members_json, certifications_json, major_clients_json,
                expansion_signals_json, current_software_json, export_markets_json,
                pain_points_json, services_json, overall_confidence, lead_score,
                full_result_json, enriched_at, updated_at
            ) VALUES (
                NEWID(), @companyId, @website, @email, @alternatePhone, @whatsapp,
                @linkedIn, @facebook, @instagram, @youtube, @twitter,
                @decisionMaker, @decisionMakerLinkedIn, @industry, @tagline, @summary, @services,
                @companyType, @supplierType, @employeeCount, @yearFounded, @annualTurnover,
                @headquarters, @teamMembersJson, @certificationsJson, @majorClientsJson,
                @expansionSignalsJson, @currentSoftwareJson, @exportMarketsJson,
                @painPointsJson, @servicesJson, @confidence, @leadScore,
                @fullResultJson, GETDATE(), GETDATE()
            );

            UPDATE companies SET enrichment_status='enriched', updated_at=GETDATE() WHERE id=@companyId;
            """, new
        {
            companyId          = companyId.Value,
            website            = payload.Website,
            email              = payload.Email,
            alternatePhone     = payload.AlternatePhone,
            whatsapp           = payload.Whatsapp,
            linkedIn           = payload.LinkedIn,
            facebook           = payload.Facebook,
            instagram          = payload.Instagram,
            youtube            = payload.Youtube,
            twitter            = payload.Twitter,
            decisionMaker      = payload.DecisionMaker,
            decisionMakerLinkedIn = payload.DecisionMakerLinkedIn,
            industry           = payload.Industry,
            tagline            = payload.Tagline,
            summary            = payload.Summary,
            services           = payload.Services,
            companyType        = payload.CompanyType,
            supplierType       = payload.SupplierType,
            employeeCount      = payload.EmployeeCount,
            yearFounded        = payload.YearFounded?.ToString(),
            annualTurnover     = payload.AnnualTurnover,
            headquarters       = payload.Headquarters,
            teamMembersJson    = payload.TeamMembersJson,
            certificationsJson = payload.CertificationsJson,
            majorClientsJson   = payload.MajorClientsJson,
            expansionSignalsJson = payload.ExpansionSignalsJson,
            currentSoftwareJson = payload.CurrentSoftwareJson,
            exportMarketsJson  = payload.ExportMarketsJson,
            painPointsJson     = payload.PainPointsJson,
            servicesJson       = payload.ServicesJson,
            confidence         = payload.Confidence ?? 0.5m,
            leadScore          = (int)Math.Round((double)(payload.Confidence ?? 0.5m) * 100),
            fullResultJson     = payload.FullResultJson,
        });

        // Upsert all team members as individual contacts
        if (!string.IsNullOrWhiteSpace(payload.TeamMembersJson))
        {
            var members = System.Text.Json.JsonSerializer.Deserialize<List<TeamMemberDto>>(payload.TeamMembersJson);
            if (members != null)
            {
                foreach (var m in members)
                {
                    var exists = await db.ExecuteScalarAsync<int>(
                        "SELECT COUNT(1) FROM company_contacts WHERE company_id=@cid AND full_name=@name",
                        new { cid = companyId.Value, name = m.Name });
                    if (exists == 0)
                        await db.ExecuteAsync("""
                            INSERT INTO company_contacts (id, company_id, full_name, role, source_type, confidence, discovered_at)
                            VALUES (NEWID(), @cid, @name, @role, 'ai_research', 0.8, GETDATE())
                            """, new { cid = companyId.Value, name = m.Name, role = m.Role });
                }
            }
        }

        return Results.Ok(new { ok = true, companyId });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Research save failed");
    }
});

// ─── Deep research save ───────────────────────────────────────────────────────

app.MapPost("/api/deep-research/save", async (DeepResearchSavePayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);

        var companyId = await db.ExecuteScalarAsync<Guid?>(
            "SELECT id FROM companies WHERE google_maps_url = @url OR (name = @name AND city = @city)",
            new { url = payload.GoogleMapsUrl, name = payload.CompanyName, city = payload.City });

        if (!companyId.HasValue) return Results.NotFound(new { ok = false, error = "Company not found" });

        await db.ExecuteAsync("""
            MERGE company_deep_research AS target
            USING (SELECT @companyId AS company_id) AS src ON target.company_id = src.company_id
            WHEN MATCHED THEN UPDATE SET
                recommended_pitch       = @pitch,
                pitch_template          = @template,
                people_activity_json    = @peopleJson,
                company_signals_json    = @companySignalsJson,
                intent_signals_json     = @intentSignalsJson,
                full_deep_research_json = @fullJson,
                researched_at           = GETDATE(),
                updated_at              = GETDATE()
            WHEN NOT MATCHED THEN INSERT (
                id, company_id, recommended_pitch, pitch_template,
                people_activity_json, company_signals_json, intent_signals_json,
                full_deep_research_json, researched_at
            ) VALUES (
                NEWID(), @companyId, @pitch, @template,
                @peopleJson, @companySignalsJson, @intentSignalsJson,
                @fullJson, GETDATE()
            );
            """, new
        {
            companyId          = companyId.Value,
            pitch              = payload.RecommendedPitch,
            template           = payload.PitchTemplate,
            peopleJson         = payload.PeopleActivityJson,
            companySignalsJson = payload.CompanySignalsJson,
            intentSignalsJson  = payload.IntentSignalsJson,
            fullJson           = payload.FullDeepResearchJson,
        });

        return Results.Ok(new { ok = true, companyId });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Deep research save failed");
    }
});

// ─── LinkedIn Business Intelligence (Phase 3) ──────────────────────────────────
// Compliance: data captured here is whatever the extension's scraper found
// publicly visible — fields it could not see are sent as "Not Available"
// strings rather than inferred. These endpoints just persist what's given.

app.MapPost("/api/linkedin/company-profile", async (LinkedInCompanyProfilePayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var companyId = await db.ExecuteScalarAsync<Guid?>(
            "SELECT id FROM companies WHERE google_maps_url = @url OR (name = @name AND city = @city)",
            new { url = payload.GoogleMapsUrl, name = payload.CompanyName, city = payload.City });
        if (!companyId.HasValue) return Results.NotFound(new { ok = false, error = "Company not found" });

        await db.ExecuteAsync(
            "EXEC usp_upsert_linkedin_company_profile @company_id=@companyId, @company_name=@companyName, @linkedin_url=@linkedinUrl, @industry=@industry, @company_size=@companySize, @followers=@followers, @location=@location, @about_text=@aboutText",
            new
            {
                companyId  = companyId.Value,
                companyName = payload.CompanyName,
                linkedinUrl = payload.LinkedinUrl,
                industry    = payload.Industry,
                companySize = payload.CompanySize,
                followers   = payload.Followers,
                location    = payload.Location,
                aboutText   = payload.AboutText,
            });

        return Results.Ok(new { ok = true, companyId });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "LinkedIn company profile save failed");
    }
});

app.MapPost("/api/linkedin/company-posts", async (LinkedInCompanyPostsPayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var companyId = await db.ExecuteScalarAsync<Guid?>(
            "SELECT id FROM companies WHERE google_maps_url = @url OR (name = @name AND city = @city)",
            new { url = payload.GoogleMapsUrl, name = payload.CompanyName, city = payload.City });
        if (!companyId.HasValue) return Results.NotFound(new { ok = false, error = "Company not found" });

        foreach (var p in payload.Posts)
        {
            await db.ExecuteAsync("""
                INSERT INTO linkedin_company_posts (
                    id, company_id, post_date, post_text, post_url, engagement_count,
                    detected_theme, hiring_signal, expansion_signal, product_signal, event_signal, within_six_months
                ) VALUES (
                    NEWID(), @companyId, @postDate, @postText, @postUrl, @engagementCount,
                    @detectedTheme, @hiringSignal, @expansionSignal, @productSignal, @eventSignal, @withinSixMonths
                )
                """, new
            {
                companyId       = companyId.Value,
                postDate        = p.PostDate,
                postText        = p.PostText,
                postUrl         = p.PostUrl,
                engagementCount = p.EngagementCount,
                detectedTheme   = p.DetectedTheme,
                hiringSignal    = p.HiringSignal,
                expansionSignal = p.ExpansionSignal,
                productSignal   = p.ProductSignal,
                eventSignal     = p.EventSignal,
                withinSixMonths = p.WithinSixMonths,
            });
        }

        return Results.Ok(new { ok = true, companyId, saved = payload.Posts.Count });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "LinkedIn company posts save failed");
    }
});

app.MapPost("/api/linkedin/people", async (LinkedInPeoplePayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var companyId = await db.ExecuteScalarAsync<Guid?>(
            "SELECT id FROM companies WHERE google_maps_url = @url OR (name = @name AND city = @city)",
            new { url = payload.GoogleMapsUrl, name = payload.CompanyName, city = payload.City });
        if (!companyId.HasValue) return Results.NotFound(new { ok = false, error = "Company not found" });

        foreach (var p in payload.People)
        {
            await db.ExecuteAsync(
                "EXEC usp_upsert_linkedin_person @company_id=@companyId, @name=@name, @title=@title, @linkedin_url=@linkedinUrl, @company_name=@companyName, @role_category=@roleCategory, @confidence=@confidence",
                new
                {
                    companyId   = companyId.Value,
                    name        = p.Name,
                    title       = p.Title,
                    linkedinUrl = p.LinkedinUrl,
                    companyName = payload.CompanyName,
                    roleCategory = p.RoleCategory,
                    confidence   = p.Confidence,
                });
        }

        return Results.Ok(new { ok = true, companyId, saved = payload.People.Count });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "LinkedIn people save failed");
    }
});

app.MapPost("/api/linkedin/person-posts", async (LinkedInPersonPostsPayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var companyId = await db.ExecuteScalarAsync<Guid?>(
            "SELECT id FROM companies WHERE google_maps_url = @url OR (name = @name AND city = @city)",
            new { url = payload.GoogleMapsUrl, name = payload.CompanyName, city = payload.City });
        if (!companyId.HasValue) return Results.NotFound(new { ok = false, error = "Company not found" });

        var personId = await db.ExecuteScalarAsync<Guid?>(
            "SELECT id FROM linkedin_people WHERE company_id = @companyId AND linkedin_url = @url",
            new { companyId = companyId.Value, url = payload.PersonLinkedinUrl });

        foreach (var p in payload.Posts)
        {
            await db.ExecuteAsync("""
                INSERT INTO linkedin_person_posts (
                    id, company_id, person_id, person_name, person_linkedin_url, post_date, post_text, post_url,
                    detected_theme, business_interest, hiring_signal, company_mention, within_six_months
                ) VALUES (
                    NEWID(), @companyId, @personId, @personName, @personLinkedinUrl, @postDate, @postText, @postUrl,
                    @detectedTheme, @businessInterest, @hiringSignal, @companyMention, @withinSixMonths
                )
                """, new
            {
                companyId         = companyId.Value,
                personId          = personId,
                personName        = payload.PersonName,
                personLinkedinUrl = payload.PersonLinkedinUrl,
                postDate          = p.PostDate,
                postText          = p.PostText,
                postUrl           = p.PostUrl,
                detectedTheme     = p.DetectedTheme,
                businessInterest  = p.BusinessInterest,
                hiringSignal      = p.HiringSignal,
                companyMention    = p.CompanyMention,
                withinSixMonths   = p.WithinSixMonths,
            });
        }

        return Results.Ok(new { ok = true, companyId, saved = payload.Posts.Count });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "LinkedIn person posts save failed");
    }
});

app.MapGet("/api/leads/{leadId}/linkedin-intelligence", async (Guid leadId) =>
{
    try
    {
        using var db = new SqlConnection(connStr);

        var profile = await db.QueryFirstOrDefaultAsync(
            "SELECT company_name AS CompanyName, linkedin_url AS LinkedinUrl, industry, company_size AS CompanySize, followers, location, about_text AS AboutText, captured_at AS CapturedAt FROM linkedin_company_profiles WHERE company_id = @leadId",
            new { leadId });

        var companyPosts = await db.QueryAsync(
            "SELECT post_date AS PostDate, post_text AS PostText, post_url AS PostUrl, engagement_count AS EngagementCount, detected_theme AS DetectedTheme, hiring_signal AS HiringSignal, expansion_signal AS ExpansionSignal, product_signal AS ProductSignal, event_signal AS EventSignal FROM linkedin_company_posts WHERE company_id = @leadId AND within_six_months = 1 ORDER BY captured_at DESC",
            new { leadId });

        var people = await db.QueryAsync(
            "SELECT name, title, linkedin_url AS LinkedinUrl, role_category AS RoleCategory, confidence FROM linkedin_people WHERE company_id = @leadId ORDER BY confidence DESC",
            new { leadId });

        var personPosts = await db.QueryAsync(
            "SELECT person_name AS PersonName, person_linkedin_url AS PersonLinkedinUrl, post_date AS PostDate, post_text AS PostText, post_url AS PostUrl, detected_theme AS DetectedTheme, business_interest AS BusinessInterest, hiring_signal AS HiringSignal, company_mention AS CompanyMention FROM linkedin_person_posts WHERE company_id = @leadId AND within_six_months = 1 ORDER BY captured_at DESC",
            new { leadId });

        return Results.Ok(new { companyProfile = profile, companyPosts, people, personPosts });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "LinkedIn intelligence fetch failed");
    }
});

// ─── Outreach endpoints ───────────────────────────────────────────────────────

// Log a message sent on any channel
app.MapPost("/api/outreach/send", async (OutreachSendPayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);

        // Get or create conversation for this company+channel
        var convId = await db.ExecuteScalarAsync<Guid?>(
            "SELECT id FROM outreach_conversations WHERE company_id=@cid AND channel=@channel",
            new { cid = payload.CompanyId, channel = payload.Channel });

        if (!convId.HasValue)
        {
            convId = Guid.NewGuid();
            await db.ExecuteAsync("""
                INSERT INTO outreach_conversations
                    (id, company_id, contact_id, channel, contact_name, stage, last_activity_at)
                VALUES
                    (@id, @cid, @contactId, @channel, @contactName, 'contacted', GETDATE())
                """, new
            {
                id          = convId.Value,
                cid         = payload.CompanyId,
                contactId   = payload.ContactId,
                channel     = payload.Channel,
                contactName = payload.ContactName,
            });
        }
        else
        {
            await db.ExecuteAsync(
                "UPDATE outreach_conversations SET stage='contacted', last_activity_at=GETDATE(), updated_at=GETDATE() WHERE id=@id",
                new { id = convId.Value });
        }

        // Log the message
        await db.ExecuteAsync("""
            INSERT INTO conversation_messages (id, conversation_id, direction, content, channel, sent_at)
            VALUES (NEWID(), @convId, 'outbound', @content, @channel, GETDATE())
            """, new { convId = convId.Value, content = payload.MessageText, channel = payload.Channel });

        // Update company outreach status
        await db.ExecuteAsync(
            "UPDATE companies SET outreach_status='contacted', updated_at=GETDATE() WHERE id=@id",
            new { id = payload.CompanyId });

        return Results.Ok(new { ok = true, conversationId = convId });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Outreach send failed");
    }
});

// Log a reply received from the prospect
app.MapPost("/api/outreach/reply", async (OutreachReplyPayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);

        await db.ExecuteAsync("""
            INSERT INTO conversation_messages (id, conversation_id, direction, content, channel, sent_at)
            VALUES (NEWID(), @convId, 'inbound', @content, @channel, GETDATE());

            UPDATE outreach_conversations
            SET stage='replied', last_activity_at=GETDATE(), updated_at=GETDATE()
            WHERE id=@convId;

            UPDATE companies
            SET outreach_status='replied', updated_at=GETDATE()
            WHERE id=(SELECT company_id FROM outreach_conversations WHERE id=@convId);
            """, new { convId = payload.ConversationId, content = payload.ReplyText, channel = payload.Channel });

        return Results.Ok(new { ok = true });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Reply log failed");
    }
});

// Update conversation stage (e.g. replied → nurturing → meeting_scheduled → won)
app.MapPost("/api/outreach/stage", async (OutreachStagePayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        await db.ExecuteAsync("""
            UPDATE outreach_conversations
            SET stage=@stage, notes=COALESCE(@notes, notes),
                next_follow_up_at=@followUp,
                last_activity_at=GETDATE(), updated_at=GETDATE()
            WHERE id=@convId;

            UPDATE companies
            SET outreach_status=@stage, updated_at=GETDATE()
            WHERE id=(SELECT company_id FROM outreach_conversations WHERE id=@convId);
            """, new
        {
            convId   = payload.ConversationId,
            stage    = payload.Stage,
            notes    = payload.Notes,
            followUp = payload.NextFollowUpAt,
        });
        return Results.Ok(new { ok = true });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Stage update failed");
    }
});

// Get full conversation history for a company
app.MapGet("/api/outreach/{companyId}", async (Guid companyId) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var conversations = await db.QueryAsync<dynamic>("""
            SELECT
                oc.id, oc.channel, oc.contact_name AS contactName, oc.stage,
                oc.last_activity_at AS lastActivityAt, oc.next_follow_up_at AS nextFollowUpAt,
                oc.notes
            FROM outreach_conversations oc
            WHERE oc.company_id = @companyId
            ORDER BY oc.last_activity_at DESC
            """, new { companyId });

        var messages = await db.QueryAsync<dynamic>("""
            SELECT cm.id, cm.conversation_id AS conversationId, cm.direction,
                   cm.content, cm.channel, cm.sent_at AS sentAt
            FROM conversation_messages cm
            JOIN outreach_conversations oc ON cm.conversation_id = oc.id
            WHERE oc.company_id = @companyId
            ORDER BY cm.sent_at ASC
            """, new { companyId });

        return Results.Ok(new { ok = true, conversations, messages });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Outreach fetch failed");
    }
});

// ─── Restore endpoint (updated to include research + deep research) ────────────

app.MapGet("/api/restore/full/{companyId}", async (Guid companyId) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var enrichment = await db.QueryFirstOrDefaultAsync<dynamic>(
            "SELECT full_result_json AS researchJson FROM company_enrichments WHERE company_id=@id",
            new { id = companyId });
        var deepResearch = await db.QueryFirstOrDefaultAsync<dynamic>(
            "SELECT full_deep_research_json AS deepResearchJson FROM company_deep_research WHERE company_id=@id",
            new { id = companyId });
        return Results.Ok(new { ok = true, enrichment, deepResearch });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Full restore failed");
    }
});

// ─── Extension full-backup endpoints ─────────────────────────────────────────
// Saves/restores the complete IndexedDB dump so reinstalling the extension
// doesn't lose any data. The backup lives as a JSON file next to the API.
var backupPath = Path.Combine(AppContext.BaseDirectory, "extension-backup.json");

app.MapPost("/api/extension-backup", async (HttpRequest req) =>
{
    try
    {
        using var reader = new StreamReader(req.Body);
        var json = await reader.ReadToEndAsync();
        await File.WriteAllTextAsync(backupPath, json);
        return Results.Ok(new { ok = true, savedAt = DateTime.UtcNow });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Backup save failed");
    }
});

app.MapGet("/api/extension-backup", async (HttpContext ctx) =>
{
    if (!File.Exists(backupPath))
    {
        ctx.Response.ContentType = "application/json";
        await ctx.Response.WriteAsync("{\"ok\":false,\"data\":null}");
        return;
    }

    try
    {
        var json = await File.ReadAllTextAsync(backupPath);
        // Write raw JSON directly — avoids JsonDocument disposed-object error
        // that occurs when using a 'using var doc' whose lifetime ends before
        // the response body is serialized by ASP.NET's result pipeline.
        ctx.Response.ContentType = "application/json";
        await ctx.Response.WriteAsync($"{{\"ok\":true,\"data\":{json}}}");
    }
    catch (Exception ex)
    {
        ctx.Response.StatusCode = 500;
        ctx.Response.ContentType = "application/json";
        await ctx.Response.WriteAsync($"{{\"ok\":false,\"error\":\"{ex.Message.Replace("\"", "'")}\"}}");
    }
});

app.MapDelete("/api/extension-backup", () =>
{
    if (File.Exists(backupPath)) File.Delete(backupPath);
    return Results.Ok(new { ok = true });
});

// ─── Follow-up endpoints ──────────────────────────────────────────────────────

app.MapGet("/api/followups/due", async () =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var items = await db.QueryAsync<dynamic>("""
            SELECT
                oc.id               AS conversationId,
                c.id                AS companyId,
                c.name              AS companyName,
                c.city,
                oc.channel,
                oc.contact_name     AS contactName,
                oc.stage,
                oc.next_follow_up_at AS nextFollowUpAt,
                oc.notes,
                oc.last_activity_at  AS lastActivityAt
            FROM outreach_conversations oc
            JOIN companies c ON oc.company_id = c.id
            WHERE oc.next_follow_up_at IS NOT NULL
              AND oc.next_follow_up_at <= GETDATE()
              AND oc.stage NOT IN ('won', 'lost')
            ORDER BY oc.next_follow_up_at ASC
            """);
        return Results.Ok(new { ok = true, followups = items });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Follow-ups fetch failed");
    }
});

app.MapGet("/api/followups/upcoming", async () =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var items = await db.QueryAsync<dynamic>("""
            SELECT
                oc.id               AS conversationId,
                c.id                AS companyId,
                c.name              AS companyName,
                c.city,
                oc.channel,
                oc.contact_name     AS contactName,
                oc.stage,
                oc.next_follow_up_at AS nextFollowUpAt,
                oc.notes,
                oc.last_activity_at  AS lastActivityAt
            FROM outreach_conversations oc
            JOIN companies c ON oc.company_id = c.id
            WHERE oc.next_follow_up_at IS NOT NULL
              AND oc.next_follow_up_at > GETDATE()
              AND oc.stage NOT IN ('won', 'lost')
            ORDER BY oc.next_follow_up_at ASC
            """);
        return Results.Ok(new { ok = true, followups = items });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Upcoming follow-ups fetch failed");
    }
});

// ─── Nurture template endpoints ───────────────────────────────────────────────

app.MapGet("/api/nurture/templates", async () =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var templates = await db.QueryAsync<dynamic>("""
            SELECT id, name, channel, stage, sequence_step AS sequenceStep,
                   delay_days AS delayDays, subject, message_template AS messageTemplate,
                   created_at AS createdAt
            FROM nurture_templates
            ORDER BY channel, stage, sequence_step
            """);
        return Results.Ok(new { ok = true, templates });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Templates fetch failed");
    }
});

app.MapPost("/api/nurture/templates", async (NurtureTemplatePayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var id = Guid.NewGuid();
        await db.ExecuteAsync("""
            INSERT INTO nurture_templates (id, name, channel, stage, sequence_step, delay_days,
                subject, message_template, created_at)
            VALUES (@id, @name, @channel, @stage, @sequenceStep, @delayDays,
                @subject, @messageTemplate, GETDATE())
            """, new
        {
            id,
            name = payload.Name,
            channel = payload.Channel,
            stage = payload.Stage,
            sequenceStep = payload.SequenceStep,
            delayDays = payload.DelayDays,
            subject = payload.Subject,
            messageTemplate = payload.MessageTemplate,
        });
        return Results.Ok(new { ok = true, id });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Template create failed");
    }
});

app.MapPut("/api/nurture/templates/{id}", async (Guid id, NurtureTemplatePayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        await db.ExecuteAsync("""
            UPDATE nurture_templates
            SET name = @name, channel = @channel, stage = @stage,
                sequence_step = @sequenceStep, delay_days = @delayDays,
                subject = @subject, message_template = @messageTemplate
            WHERE id = @id
            """, new
        {
            id,
            name = payload.Name,
            channel = payload.Channel,
            stage = payload.Stage,
            sequenceStep = payload.SequenceStep,
            delayDays = payload.DelayDays,
            subject = payload.Subject,
            messageTemplate = payload.MessageTemplate,
        });
        return Results.Ok(new { ok = true });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Template update failed");
    }
});

app.MapDelete("/api/nurture/templates/{id}", async (Guid id) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        await db.ExecuteAsync("DELETE FROM nurture_templates WHERE id = @id", new { id });
        return Results.Ok(new { ok = true });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Template delete failed");
    }
});

app.MapPost("/api/nurture/schedule", async (NurtureSchedulePayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var id = Guid.NewGuid();
        var scheduledFor = DateTime.UtcNow.AddDays(payload.DelayDays);
        await db.ExecuteAsync("""
            INSERT INTO nurture_sequences
                (id, company_id, template_id, scheduled_for, status, created_at)
            VALUES (@id, @companyId, @templateId, @scheduledFor, 'pending', GETDATE())
            """, new { id, companyId = payload.CompanyId, templateId = payload.TemplateId, scheduledFor });
        return Results.Ok(new { ok = true, id, scheduledFor });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Schedule failed");
    }
});

app.MapGet("/api/nurture/due", async () =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var sequences = await db.QueryAsync<dynamic>("""
            SELECT
                ns.id, c.name AS companyName, c.city, cc.phone,
                cc.full_name AS contactName,
                nt.name AS templateName, nt.channel, nt.message_template AS messageTemplate,
                ns.scheduled_for AS scheduledFor
            FROM nurture_sequences ns
            JOIN companies c ON ns.company_id = c.id
            JOIN nurture_templates nt ON ns.template_id = nt.id
            LEFT JOIN company_contacts cc ON cc.company_id = c.id
            WHERE ns.status = 'pending'
              AND ns.scheduled_for <= GETDATE()
            ORDER BY ns.scheduled_for ASC
            """);
        return Results.Ok(new { ok = true, sequences });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Due sequences fetch failed");
    }
});

app.MapGet("/api/nurture/scheduled", async () =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var sequences = await db.QueryAsync<dynamic>("""
            SELECT
                ns.id, c.name AS companyName, c.city, cc.phone,
                cc.full_name AS contactName,
                nt.name AS templateName, nt.channel, nt.message_template AS messageTemplate,
                ns.scheduled_for AS scheduledFor, ns.status
            FROM nurture_sequences ns
            JOIN companies c ON ns.company_id = c.id
            JOIN nurture_templates nt ON ns.template_id = nt.id
            LEFT JOIN company_contacts cc ON cc.company_id = c.id
            WHERE ns.status IN ('pending', 'sent')
            ORDER BY ns.scheduled_for DESC
            """);
        return Results.Ok(new { ok = true, sequences });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Scheduled sequences fetch failed");
    }
});

app.MapPost("/api/nurture/complete/{id}", async (Guid id) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        await db.ExecuteAsync("""
            UPDATE nurture_sequences SET status = 'sent', sent_at = GETDATE() WHERE id = @id
            """, new { id });
        return Results.Ok(new { ok = true });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Complete failed");
    }
});

app.MapPost("/api/nurture/skip/{id}", async (Guid id) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        await db.ExecuteAsync("""
            UPDATE nurture_sequences SET status = 'skipped' WHERE id = @id
            """, new { id });
        return Results.Ok(new { ok = true });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Skip failed");
    }
});

// ─── Phase 3: Evidence-based research — MSSQL as sole source of truth ────────
// search_evidence, source_pages, company_research are saved directly here.
// The extension never writes these to IndexedDB after version 8.

app.MapPost("/api/phase3/save", async (Phase3SavePayload payload) =>
{
    try
    {
        using var db = new SqlConnection(connStr);

        if (!Guid.TryParse(payload.MssqlCompanyId, out var companyId))
            return Results.BadRequest(new { ok = false, error = "Invalid mssqlCompanyId" });

        // Save search evidence rows (append-only — each research run adds new rows)
        var evidenceIdMap = new Dictionary<string, Guid>(); // url → MSSQL id
        foreach (var e in payload.Evidence)
        {
            var evidenceId = Guid.NewGuid();
            evidenceIdMap[e.Url] = evidenceId;
            await db.ExecuteAsync("""
                INSERT INTO search_evidence
                    (id, company_id, query, title, url, display_url, snippet, rank,
                     source_domain, detected_type, match_confidence, rejected, reject_reason, captured_at)
                VALUES
                    (@id, @companyId, @query, @title, @url, @displayUrl, @snippet, @rank,
                     @sourceDomain, @detectedType, @matchConfidence, @rejected, @rejectReason, GETDATE())
                """, new
            {
                id            = evidenceId,
                companyId,
                query         = e.Query,
                title         = e.Title,
                url           = e.Url,
                displayUrl    = e.DisplayUrl,
                snippet       = e.Snippet,
                rank          = e.Rank,
                sourceDomain  = e.SourceDomain,
                detectedType  = e.DetectedType,
                matchConfidence = e.MatchConfidence,
                rejected      = e.Rejected,
                rejectReason  = e.RejectReason,
            });
        }

        // Save source pages (FK to evidence via URL lookup)
        foreach (var sp in payload.SourcePages)
        {
            evidenceIdMap.TryGetValue(sp.Url, out var evidenceId);
            await db.ExecuteAsync("""
                INSERT INTO source_pages
                    (id, company_id, evidence_id, url, source_domain, source_type,
                     page_title, extracted_json, confidence, status, error_message, captured_at)
                VALUES
                    (NEWID(), @companyId, @evidenceId, @url, @sourceDomain, @sourceType,
                     @pageTitle, @extractedJson, @confidence, @status, @errorMessage, GETDATE())
                """, new
            {
                companyId,
                evidenceId    = evidenceId == Guid.Empty ? (Guid?)null : evidenceId,
                url           = sp.Url,
                sourceDomain  = sp.SourceDomain,
                sourceType    = sp.SourceType,
                pageTitle     = sp.PageTitle,
                extractedJson = sp.ExtractedJson,
                confidence    = sp.Confidence,
                status        = sp.Status,
                errorMessage  = sp.ErrorMessage,
            });
        }

        // Upsert company_research (one current row per company — re-research overwrites)
        var cr = payload.CompanyResearch;
        await db.ExecuteAsync("""
            EXEC usp_upsert_company_research
                @company_id=@companyId, @company_name=@companyName,
                @official_website=@officialWebsite, @linkedin_url=@linkedinUrl,
                @facebook_url=@facebookUrl, @instagram_url=@instagramUrl,
                @indiamart_url=@indiamartUrl, @tradeindia_url=@tradeindiaUrl,
                @owner_name=@ownerName, @directors=@directors,
                @products_services=@productsServices, @business_type=@businessType,
                @team_size=@teamSize, @turnover=@turnover,
                @established_year=@establishedYear, @address=@address,
                @phone=@phone, @email=@email,
                @confidence=@confidence, @sources_json=@sourcesJson
            """, new
        {
            companyId,
            companyName      = cr.CompanyName,
            officialWebsite  = cr.OfficialWebsite,
            linkedinUrl      = cr.LinkedinUrl,
            facebookUrl      = cr.FacebookUrl,
            instagramUrl     = cr.InstagramUrl,
            indiamartUrl     = cr.IndiamartUrl,
            tradeindiaUrl    = cr.TradeindiaUrl,
            ownerName        = cr.OwnerName,
            directors        = cr.Directors,
            productsServices = cr.ProductsServices,
            businessType     = cr.BusinessType,
            teamSize         = cr.TeamSize,
            turnover         = cr.Turnover,
            establishedYear  = cr.EstablishedYear,
            address          = cr.Address,
            phone            = cr.Phone,
            email            = cr.Email,
            confidence       = cr.Confidence,
            sourcesJson      = cr.SourcesJson,
        });

        return Results.Ok(new { ok = true });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Phase 3 save failed");
    }
});

app.MapGet("/api/phase3/companies", async () =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var companies = await db.QueryAsync<dynamic>("""
            SELECT
                c.id                     AS mssqlId,
                c.name                   AS companyName,
                c.city,
                cr.official_website      AS officialWebsite,
                cr.linkedin_url          AS linkedinUrl,
                cr.facebook_url          AS facebookUrl,
                cr.instagram_url         AS instagramUrl,
                cr.indiamart_url         AS indiamartUrl,
                cr.tradeindia_url        AS tradeindiaUrl,
                cr.owner_name            AS ownerName,
                cr.directors,
                cr.products_services     AS productsServices,
                cr.business_type         AS businessType,
                cr.team_size             AS teamSize,
                cr.turnover,
                cr.established_year      AS establishedYear,
                cr.address,
                cr.phone,
                cr.email,
                cr.confidence,
                cr.sources_json          AS sourcesJson,
                cr.updated_at            AS updatedAt,
                (SELECT COUNT(*) FROM search_evidence se WHERE se.company_id = c.id)  AS evidenceCount,
                (SELECT COUNT(*) FROM source_pages sp WHERE sp.company_id = c.id
                    AND sp.status = 'extracted')                                       AS sourcePagesCount
            FROM company_research cr
            JOIN companies c ON cr.company_id = c.id
            ORDER BY cr.updated_at DESC
            """);
        return Results.Ok(new { ok = true, companies });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Phase 3 companies list failed");
    }
});

app.MapGet("/api/phase3/company/{mssqlId}", async (Guid mssqlId) =>
{
    try
    {
        using var db = new SqlConnection(connStr);

        var research = await db.QueryFirstOrDefaultAsync<dynamic>("""
            SELECT
                c.id                     AS mssqlId,
                c.name                   AS companyName,
                c.city,
                cr.official_website      AS officialWebsite,
                cr.linkedin_url          AS linkedinUrl,
                cr.facebook_url          AS facebookUrl,
                cr.instagram_url         AS instagramUrl,
                cr.indiamart_url         AS indiamartUrl,
                cr.tradeindia_url        AS tradeindiaUrl,
                cr.owner_name            AS ownerName,
                cr.directors,
                cr.products_services     AS productsServices,
                cr.business_type         AS businessType,
                cr.team_size             AS teamSize,
                cr.turnover,
                cr.established_year      AS establishedYear,
                cr.address,
                cr.phone,
                cr.email,
                cr.confidence,
                cr.sources_json          AS sourcesJson,
                cr.updated_at            AS updatedAt
            FROM company_research cr
            JOIN companies c ON cr.company_id = c.id
            WHERE c.id = @mssqlId
            """, new { mssqlId });

        if (research == null) return Results.NotFound(new { ok = false, error = "No research data for this company" });

        var evidence = await db.QueryAsync<dynamic>("""
            SELECT id, query, title, url,
                   display_url     AS displayUrl,
                   snippet, rank,
                   source_domain   AS sourceDomain,
                   detected_type   AS detectedType,
                   match_confidence AS matchConfidence,
                   rejected,
                   reject_reason   AS rejectReason,
                   captured_at     AS capturedAt
            FROM search_evidence
            WHERE company_id = @mssqlId
            ORDER BY rank ASC
            """, new { mssqlId });

        var sourcePages = await db.QueryAsync<dynamic>("""
            SELECT id, url,
                   source_domain   AS sourceDomain,
                   source_type     AS sourceType,
                   page_title      AS pageTitle,
                   extracted_json  AS extractedJson,
                   confidence, status,
                   error_message   AS errorMessage,
                   captured_at     AS capturedAt
            FROM source_pages
            WHERE company_id = @mssqlId
            ORDER BY captured_at ASC
            """, new { mssqlId });

        return Results.Ok(new { ok = true, research, evidence, sourcePages });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Phase 3 company detail failed");
    }
});

// ─── POST /api/companies/batch-icp ────────────────────────────────────────────
// Saves ICP score, status, reason, breakdown and enrichment fields (teamSize,
// turnover, industry, etc.) for multiple leads in one call.
// All fields are stored as dedicated columns on the companies table (schema_v5).

app.MapPost("/api/companies/batch-icp", async (BatchIcpPayload payload) =>
{
    if (payload?.Updates == null || payload.Updates.Count == 0)
        return Results.BadRequest("No updates provided");

    try
    {
        using var db = new SqlConnection(connStr);
        foreach (var u in payload.Updates)
        {
            if (string.IsNullOrWhiteSpace(u.MssqlId)) continue;

            await db.ExecuteAsync(@"
                UPDATE companies SET
                    icp_score           = @IcpScore,
                    icp_status          = @IcpStatus,
                    icp_reason          = @IcpReason,
                    icp_score_breakdown = @IcpScoreBreakdown,
                    team_size           = COALESCE(@TeamSize, team_size),
                    annual_turnover     = COALESCE(@AnnualTurnover, annual_turnover),
                    industry            = COALESCE(@Industry, industry),
                    company_type        = COALESCE(@CompanyType, company_type),
                    decision_maker      = COALESCE(@DecisionMaker, decision_maker),
                    updated_at          = GETUTCDATE()
                WHERE id = @MssqlId",
                new {
                    u.MssqlId,
                    u.IcpScore,
                    u.IcpStatus,
                    u.IcpReason,
                    u.IcpScoreBreakdown,
                    u.TeamSize,
                    u.AnnualTurnover,
                    u.Industry,
                    u.CompanyType,
                    u.DecisionMaker,
                });
        }
        return Results.Ok(new { updated = payload.Updates.Count });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Batch ICP update failed");
    }
});

// ─── Search Sessions (search_runs) ────────────────────────────────────────────
// One row per Start click in the extension's Search Console (or per batch
// campaign). Companies carry run_id so per-session workspaces survive restore.

app.MapPost("/api/search-runs", async (SearchRunCreate body) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var id = await db.ExecuteScalarAsync<int>("""
            INSERT INTO search_runs (name, country, business_profile, status, total_leads, created_at)
            OUTPUT inserted.id
            VALUES (@name, @country, @businessProfile, @status, 0, GETDATE())
            """, new
        {
            name = body.Name,
            country = body.Country,
            businessProfile = body.BusinessProfile,
            status = string.IsNullOrWhiteSpace(body.Status) ? "running" : body.Status,
        });
        return Results.Ok(new { id });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Search run create failed");
    }
});

app.MapPut("/api/search-runs/{id:int}", async (int id, SearchRunUpdate body) =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        await db.ExecuteAsync("""
            UPDATE search_runs SET
                name = COALESCE(@name, name),
                status = COALESCE(@status, status),
                total_leads = COALESCE(@totalLeads, total_leads),
                business_profile = COALESCE(@businessProfile, business_profile),
                completed_at = CASE WHEN @status IN ('completed', 'stopped') THEN GETDATE() ELSE completed_at END
            WHERE id = @id
            """, new { id, name = body.Name, status = body.Status, totalLeads = body.TotalLeads, businessProfile = body.BusinessProfile });
        return Results.Ok(new { ok = true });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Search run update failed");
    }
});

app.MapGet("/api/search-runs", async () =>
{
    try
    {
        using var db = new SqlConnection(connStr);
        var runs = await db.QueryAsync<dynamic>("""
            SELECT
                id,
                name,
                country,
                business_profile AS businessProfile,
                status,
                total_leads      AS totalLeads,
                created_at       AS createdAt
            FROM search_runs
            ORDER BY created_at DESC
            """);
        return Results.Ok(runs);
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Search run list failed");
    }
});

app.Run("http://localhost:5150");

// ─── DB helpers ───────────────────────────────────────────────────────────────

static async Task<Guid> UpsertProject(SqlConnection db, SessionDto s)
{
    // COALESCE(inserted.id, deleted.id) safely returns the id for both INSERT and UPDATE paths.
    const string sql = """
        MERGE search_projects AS target
        USING (SELECT @name AS name, @city AS city) AS src
            ON target.name = src.name AND target.city = src.city
        WHEN MATCHED THEN
            UPDATE SET total_found = @totalFound, updated_at = GETDATE()
        WHEN NOT MATCHED THEN
            INSERT (id, name, city, keywords, status, total_found, total_enriched, created_at, updated_at)
            VALUES (NEWID(), @name, @city, @keywords, 'completed', @totalFound, 0, GETDATE(), GETDATE())
        OUTPUT COALESCE(inserted.id, deleted.id);
        """;
    return await db.ExecuteScalarAsync<Guid>(sql, new
    {
        name = $"{s.Keyword} — {s.City}",
        city = s.City,
        keywords = s.Keyword,
        totalFound = s.TotalCaptured,
    });
}

static async Task<Guid> UpsertCompany(SqlConnection db, LeadDto lead, Guid projectId, int? runId = null)
{
    var placeId = lead.GoogleMapsUrl?.Length > 200 ? lead.GoogleMapsUrl[..200] : lead.GoogleMapsUrl;
    var mapsUrl = lead.GoogleMapsUrl?.Length > 1000 ? lead.GoogleMapsUrl[..1000] : lead.GoogleMapsUrl;

    // Unique key is (name, city) — keyword/project-agnostic.
    // Same company captured under different keyword searches is one record, not many.
    // run_id keeps the FIRST run that captured the company (same rule as project_id).
    const string sql = """
        MERGE companies AS target
        USING (SELECT @name AS name, @city AS city) AS src
            ON target.name = src.name AND target.city = src.city
        WHEN MATCHED THEN
            UPDATE SET
                project_id = COALESCE(target.project_id, @projectId),
                run_id = COALESCE(target.run_id, @runId),
                address = COALESCE(@address, target.address),
                phone = COALESCE(@phone, target.phone),
                website = COALESCE(@website, target.website),
                google_maps_url = COALESCE(@googleMapsUrl, target.google_maps_url),
                rating = COALESCE(@rating, target.rating),
                review_count = COALESCE(@reviewCount, target.review_count),
                category = COALESCE(@category, target.category),
                updated_at = GETDATE()
        WHEN NOT MATCHED THEN
            INSERT (id, project_id, run_id, place_id, name, address, phone, website, google_maps_url,
                    rating, review_count, category, city, enrichment_status, created_at, updated_at)
            VALUES (NEWID(), @projectId, @runId, @placeId, @name, @address, @phone, @website, @googleMapsUrl,
                    @rating, @reviewCount, @category, @city, 'pending', GETDATE(), GETDATE())
        OUTPUT COALESCE(inserted.id, deleted.id);
        """;
    return await db.ExecuteScalarAsync<Guid>(sql, new
    {
        projectId, runId, placeId, mapsUrl,
        name = lead.CompanyName,
        address = lead.Address,
        phone = lead.Phone,
        website = lead.Website,
        googleMapsUrl = mapsUrl,
        rating = lead.Rating,
        reviewCount = lead.ReviewCount,
        category = lead.Category,
        city = lead.City,
    });
}

static async Task UpsertEnrichment(SqlConnection db, ResearchResultDto r, Guid companyId)
{
    var servicesJson = r.Services != null ? JsonSerializer.Serialize(r.Services) : null;
    var score = (int)Math.Round((double)(r.Confidence ?? 0.5m) * 100);

    const string sql = """
        MERGE company_enrichments AS target
        USING (SELECT @companyId AS company_id) AS src ON target.company_id = src.company_id
        WHEN MATCHED THEN
            UPDATE SET
                official_website = @website, email = @email,
                linkedin_url = @linkedIn, facebook_url = @facebook,
                instagram_url = @instagram, youtube_url = @youtube,
                owner_name = @decisionMaker, products_services = @services,
                team_size = @employeeCount, established_year = @yearFounded,
                business_type = @companyType, description = @summary,
                overall_confidence = @confidence, lead_score = @leadScore,
                full_result_json = COALESCE(@fullResultJson, full_result_json),
                enriched_at = GETDATE(), updated_at = GETDATE()
        WHEN NOT MATCHED THEN
            INSERT (id, company_id, official_website, email, linkedin_url, facebook_url,
                    instagram_url, youtube_url, owner_name, products_services, team_size,
                    established_year, business_type, description, overall_confidence,
                    lead_score, full_result_json, enriched_at, updated_at)
            VALUES (NEWID(), @companyId, @website, @email, @linkedIn, @facebook,
                    @instagram, @youtube, @decisionMaker, @services, @employeeCount,
                    @yearFounded, @companyType, @summary, @confidence, @leadScore,
                    @fullResultJson, GETDATE(), GETDATE());

        UPDATE companies SET enrichment_status = 'enriched', updated_at = GETDATE()
        WHERE id = @companyId;
        """;

    await db.ExecuteAsync(sql, new
    {
        companyId,
        website        = r.Website,
        email          = r.Email,
        linkedIn       = r.LinkedIn,
        facebook       = r.Facebook,
        instagram      = r.Instagram,
        youtube        = r.Youtube,
        decisionMaker  = r.DecisionMaker,
        services       = servicesJson,
        employeeCount  = r.EmployeeCount,
        yearFounded    = r.YearFounded?.ToString(),
        companyType    = r.CompanyType,
        summary        = r.Summary,
        confidence     = r.Confidence ?? 0.5m,
        leadScore      = score,
        fullResultJson = r.FullResultJson,
    });
}

static async Task UpsertContact(SqlConnection db, ResearchResultDto r, Guid companyId)
{
    var exists = await db.ExecuteScalarAsync<int>(
        "SELECT COUNT(1) FROM company_contacts WHERE company_id = @companyId", new { companyId });
    if (exists > 0) return;

    await db.ExecuteAsync("""
        INSERT INTO company_contacts
            (id, company_id, full_name, email, linkedin_url, source_type, confidence, discovered_at)
        VALUES
            (NEWID(), @companyId, @fullName, @email, @linkedIn, 'ai_research', @confidence, GETDATE())
        """, new
    {
        companyId,
        fullName    = r.DecisionMaker,
        email       = r.Email,
        linkedIn    = r.LinkedIn,
        confidence  = r.Confidence ?? 0.5m,
    });
}

static async Task<Guid> EnsureProject(SqlConnection db, string city, string keyword)
{
    var name = $"{keyword} — {city}";
    var existing = await db.ExecuteScalarAsync<Guid?>(
        "SELECT id FROM search_projects WHERE name = @name AND city = @city",
        new { name, city });
    if (existing.HasValue) return existing.Value;

    var id = Guid.NewGuid();
    await db.ExecuteAsync("""
        INSERT INTO search_projects (id, name, city, keywords, status, total_found, total_enriched, created_at, updated_at)
        VALUES (@id, @name, @city, @keywords, 'active', 0, 0, GETDATE(), GETDATE())
        """, new { id, name, city, keywords = keyword });
    return id;
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────

public record BusinessProfileUpdate(string BusinessProfile);

public record SyncPayload(
    SessionDto Session,
    List<LeadDto> Leads,
    List<ResearchResultDto> ResearchResults
);

public record SessionDto(string City, string Keyword, int TotalCaptured);

public record LeadDto(
    int Id, string CompanyName, string? Address, string? Phone,
    string? Website, string? GoogleMapsUrl, decimal? Rating,
    int? ReviewCount, string? Category, string City
);

public record ResearchResultDto(
    int LeadId, string? DecisionMaker, string? Email, string? Website,
    string? LinkedIn, string? Facebook, string? Instagram, string? Youtube,
    string? Summary, string[]? Services, string? EmployeeCount,
    int? YearFounded, string? CompanyType, decimal? Confidence,
    string? FullResultJson = null
);

public record LeadSavePayload(
    int Id, string CompanyName, string City, string Keyword,
    string? Address, string? Phone, string? Website, string? GoogleMapsUrl,
    decimal? Rating, int? ReviewCount, string? Category, string? ValidationStatus,
    string? Notes = null, string? TagsJson = null, string? ValidationReason = null
);

public record LeadMetaPayload(
    string MssqlId,
    string? Notes = null,
    string? TagsJson = null,
    string? ValidationReason = null
);

public record LeadBatchPayload(
    string City, string Keyword,
    List<LeadBatchItem> Leads,
    int? RunId = null
);

public record SearchRunCreate(string Name, string? Country, string? BusinessProfile, string? Status);

public record SearchRunUpdate(string? Name, string? Status, int? TotalLeads, string? BusinessProfile);

public record LeadBatchItem(
    int Id, string CompanyName,
    string? Address, string? Phone, string? Website, string? GoogleMapsUrl,
    decimal? Rating, int? ReviewCount, string? Category
);

public record ValidateBulkPayload(List<ValidateBulkItem> Updates);
public record ValidateBulkItem(string MssqlId, string Status);

public record BatchIcpPayload(List<BatchIcpItem> Updates);
public record BatchIcpItem(
    string MssqlId,
    int    IcpScore,
    string IcpStatus,
    string IcpReason,
    string? IcpScoreBreakdown,
    string? TeamSize,
    string? AnnualTurnover,
    string? Industry,
    string? CompanyType,
    string? DecisionMaker
);

public record ResearchSavePayload(
    string CompanyName, string City, string? GoogleMapsUrl,
    // Contact
    string? Website, string? Email, string? AlternatePhone, string? Whatsapp,
    // Social
    string? LinkedIn, string? Facebook, string? Instagram, string? Youtube, string? Twitter,
    // Decision maker
    string? DecisionMaker, string? DecisionMakerLinkedIn,
    // Business
    string? Industry, string? Tagline, string? Summary, string? Services,
    string? CompanyType, string? SupplierType, string? EmployeeCount,
    int? YearFounded, string? AnnualTurnover, string? Headquarters,
    // JSON arrays
    string? TeamMembersJson, string? CertificationsJson, string? MajorClientsJson,
    string? ExpansionSignalsJson, string? CurrentSoftwareJson, string? ExportMarketsJson,
    string? PainPointsJson, string? ServicesJson,
    // Score + full blob
    decimal? Confidence, string? FullResultJson
);

public record DeepResearchSavePayload(
    string CompanyName, string City, string? GoogleMapsUrl,
    string? RecommendedPitch, string? PitchTemplate,
    string? PeopleActivityJson, string? CompanySignalsJson, string? IntentSignalsJson,
    string? FullDeepResearchJson
);

public record LinkedInCompanyProfilePayload(
    string CompanyName, string City, string? GoogleMapsUrl,
    string? LinkedinUrl, string? Industry, string? CompanySize,
    string? Followers, string? Location, string? AboutText
);

public record LinkedInCompanyPostItem(
    string? PostDate, string? PostText, string? PostUrl, int? EngagementCount,
    string? DetectedTheme, bool HiringSignal, bool ExpansionSignal,
    bool ProductSignal, bool EventSignal, bool WithinSixMonths
);

public record LinkedInCompanyPostsPayload(
    string CompanyName, string City, string? GoogleMapsUrl,
    List<LinkedInCompanyPostItem> Posts
);

public record LinkedInPersonItem(
    string? Name, string? Title, string? LinkedinUrl,
    string? RoleCategory, decimal? Confidence
);

public record LinkedInPeoplePayload(
    string CompanyName, string City, string? GoogleMapsUrl,
    List<LinkedInPersonItem> People
);

public record LinkedInPersonPostItem(
    string? PostDate, string? PostText, string? PostUrl,
    string? DetectedTheme, string? BusinessInterest, bool HiringSignal,
    bool CompanyMention, bool WithinSixMonths
);

public record LinkedInPersonPostsPayload(
    string CompanyName, string City, string? GoogleMapsUrl,
    string? PersonLinkedinUrl, string? PersonName,
    List<LinkedInPersonPostItem> Posts
);

public record OutreachSendPayload(
    Guid CompanyId, string Channel, string? ContactName,
    Guid? ContactId, string MessageText
);

public record OutreachReplyPayload(
    Guid ConversationId, string Channel, string ReplyText
);

public record OutreachStagePayload(
    Guid ConversationId, string Stage, string? Notes, DateTime? NextFollowUpAt
);

public record NurtureTemplatePayload(
    string Name, string Channel, string Stage, int SequenceStep,
    int DelayDays, string? Subject, string MessageTemplate
);

public record NurtureSchedulePayload(
    Guid CompanyId, Guid TemplateId, int DelayDays
);

public record TeamMemberDto(string Name, string Role);

public record ExistingClientsUploadPayload(List<ExistingClientItem> Clients);

public record ExistingClientItem(
    string CompanyName, string? City, string? Phone, string? ContactName, string? Email, string? Notes
);

// ─── Phase 3 DTOs ─────────────────────────────────────────────────────────────

public record SearchEvidenceItem(
    string Query, string Title, string Url, string DisplayUrl, string Snippet,
    int Rank, string SourceDomain, string DetectedType,
    decimal MatchConfidence, bool Rejected, string? RejectReason
);

public record SourcePageItem(
    string Url, string SourceDomain, string SourceType, string? PageTitle,
    string? ExtractedJson, decimal? Confidence, string Status, string? ErrorMessage
);

public record CompanyResearchItem(
    string CompanyName, string? OfficialWebsite, string? LinkedinUrl,
    string? FacebookUrl, string? InstagramUrl, string? IndiamartUrl, string? TradeindiaUrl,
    string? OwnerName, string? Directors, string? ProductsServices, string? BusinessType,
    string? TeamSize, string? Turnover, int? EstablishedYear, string? Address,
    string? Phone, string? Email, decimal Confidence, string? SourcesJson
);

public record Phase3SavePayload(
    string MssqlCompanyId,
    List<SearchEvidenceItem> Evidence,
    List<SourcePageItem> SourcePages,
    CompanyResearchItem CompanyResearch
);
