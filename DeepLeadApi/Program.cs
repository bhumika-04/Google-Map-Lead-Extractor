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
