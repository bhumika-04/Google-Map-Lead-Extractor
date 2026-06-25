using Dapper;
using Microsoft.Data.SqlClient;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);

// Allow Chrome extension (chrome-extension://*) to call this local API
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.SetIsOriginAllowed(_ => true)
     .AllowAnyMethod()
     .AllowAnyHeader()));

var app = builder.Build();
app.UseCors();

var connStr = builder.Configuration.GetConnectionString("DefaultConnection")!;

// ─── Health check ─────────────────────────────────────────────────────────────
app.MapGet("/api/health", () => new { ok = true, time = DateTime.UtcNow });

// ─── Config endpoint ──────────────────────────────────────────────────────────
// Returns AI provider config so the extension never needs a manually entered key.
app.MapGet("/api/config", () =>
{
    var apiKey = builder.Configuration["OpenAI:ApiKey"];
    var model  = builder.Configuration["OpenAI:Model"] ?? "gpt-4o-mini";
    return new
    {
        researchProvider = "openai",
        openAiApiKey     = apiKey,
        openAiModel      = model,
        hasKey           = !string.IsNullOrWhiteSpace(apiKey),
    };
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

        return Results.Ok(new
        {
            ok = true,
            synced = payload.Leads.Count,
            enrichments = payload.ResearchResults.Count,
            projectId
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
                c.id                AS companyId,
                c.name              AS companyName,
                c.address,
                c.phone,
                c.website,
                c.google_maps_url   AS googleMapsUrl,
                c.rating,
                c.review_count      AS reviewCount,
                c.category,
                c.city,
                c.validation_status AS validationStatus,
                c.enrichment_status AS enrichmentStatus,
                p.name              AS sessionName,
                p.keywords          AS keyword,
                p.city              AS sessionCity,
                p.created_at        AS sessionCreatedAt
            FROM companies c
            JOIN search_projects p ON c.project_id = p.id
            ORDER BY c.created_at DESC
            """);

        var enrichments = await db.QueryAsync<dynamic>("""
            SELECT
                c.id            AS companyId,
                e.official_website AS website,
                e.email,
                e.linkedin_url  AS linkedIn,
                e.facebook_url  AS facebook,
                e.instagram_url AS instagram,
                e.youtube_url   AS youtube,
                e.owner_name    AS decisionMaker,
                e.products_services AS services,
                e.team_size     AS employeeCount,
                e.established_year AS yearFounded,
                e.business_type AS companyType,
                e.description   AS summary,
                e.overall_confidence AS confidence,
                e.enriched_at   AS enrichedAt
            FROM company_enrichments e
            JOIN companies c ON e.company_id = c.id
            """);

        return Results.Ok(new { ok = true, companies, enrichments });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Restore failed");
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

        return Results.Ok(new { ok = true, companyId });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Lead save failed");
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
            ), projectId);
            saved++;
        }
        return Results.Ok(new { ok = true, saved });
    }
    catch (Exception ex)
    {
        return Results.Problem(detail: ex.Message, title: "Batch save failed");
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

app.Run("http://localhost:5150");

// ─── DB helpers ───────────────────────────────────────────────────────────────

static async Task<Guid> UpsertProject(SqlConnection db, SessionDto s)
{
    const string sql = """
        MERGE search_projects AS target
        USING (SELECT @name AS name, @city AS city) AS src
            ON target.name = src.name AND target.city = src.city
        WHEN MATCHED THEN
            UPDATE SET total_found = @totalFound, updated_at = GETDATE()
        WHEN NOT MATCHED THEN
            INSERT (id, name, city, keywords, status, total_found, total_enriched, created_at, updated_at)
            VALUES (NEWID(), @name, @city, @keywords, 'completed', @totalFound, 0, GETDATE(), GETDATE())
        OUTPUT inserted.id;
        """;
    return await db.ExecuteScalarAsync<Guid>(sql, new
    {
        name = $"{s.Keyword} — {s.City}",
        city = s.City,
        keywords = s.Keyword,
        totalFound = s.TotalCaptured,
    });
}

static async Task<Guid> UpsertCompany(SqlConnection db, LeadDto lead, Guid projectId)
{
    var placeId = lead.GoogleMapsUrl?.Length > 200 ? lead.GoogleMapsUrl[..200] : lead.GoogleMapsUrl;
    var mapsUrl = lead.GoogleMapsUrl?.Length > 1000 ? lead.GoogleMapsUrl[..1000] : lead.GoogleMapsUrl;

    const string sql = """
        MERGE companies AS target
        USING (SELECT @projectId AS project_id, @name AS name) AS src
            ON target.project_id = src.project_id AND target.name = src.name
        WHEN MATCHED THEN
            UPDATE SET
                address = @address, phone = @phone, website = @website,
                google_maps_url = @googleMapsUrl, rating = @rating,
                review_count = @reviewCount, category = @category, updated_at = GETDATE()
        WHEN NOT MATCHED THEN
            INSERT (id, project_id, place_id, name, address, phone, website, google_maps_url,
                    rating, review_count, category, city, enrichment_status, created_at, updated_at)
            VALUES (NEWID(), @projectId, @placeId, @name, @address, @phone, @website, @googleMapsUrl,
                    @rating, @reviewCount, @category, @city, 'pending', GETDATE(), GETDATE())
        OUTPUT inserted.id;
        """;
    return await db.ExecuteScalarAsync<Guid>(sql, new
    {
        projectId, placeId, mapsUrl,
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
                enriched_at = GETDATE(), updated_at = GETDATE()
        WHEN NOT MATCHED THEN
            INSERT (id, company_id, official_website, email, linkedin_url, facebook_url,
                    instagram_url, youtube_url, owner_name, products_services, team_size,
                    established_year, business_type, description, overall_confidence,
                    lead_score, enriched_at, updated_at)
            VALUES (NEWID(), @companyId, @website, @email, @linkedIn, @facebook,
                    @instagram, @youtube, @decisionMaker, @services, @employeeCount,
                    @yearFounded, @companyType, @summary, @confidence, @leadScore,
                    GETDATE(), GETDATE());

        UPDATE companies SET enrichment_status = 'enriched', updated_at = GETDATE()
        WHERE id = @companyId;
        """;

    await db.ExecuteAsync(sql, new
    {
        companyId,
        website       = r.Website,
        email         = r.Email,
        linkedIn      = r.LinkedIn,
        facebook      = r.Facebook,
        instagram     = r.Instagram,
        youtube       = r.Youtube,
        decisionMaker = r.DecisionMaker,
        services      = servicesJson,
        employeeCount = r.EmployeeCount,
        yearFounded   = r.YearFounded?.ToString(),
        companyType   = r.CompanyType,
        summary       = r.Summary,
        confidence    = r.Confidence ?? 0.5m,
        leadScore     = score,
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
    int? YearFounded, string? CompanyType, decimal? Confidence
);

public record LeadSavePayload(
    int Id, string CompanyName, string City, string Keyword,
    string? Address, string? Phone, string? Website, string? GoogleMapsUrl,
    decimal? Rating, int? ReviewCount, string? Category, string? ValidationStatus
);

public record LeadBatchPayload(
    string City, string Keyword,
    List<LeadBatchItem> Leads
);

public record LeadBatchItem(
    int Id, string CompanyName,
    string? Address, string? Phone, string? Website, string? GoogleMapsUrl,
    decimal? Rating, int? ReviewCount, string? Category
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

public record TeamMemberDto(string Name, string Role);
