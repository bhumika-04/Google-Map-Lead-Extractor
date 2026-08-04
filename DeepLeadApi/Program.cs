using Dapper;
using Microsoft.Data.SqlClient;
using System.Text.Json;
using System.Text.Json.Nodes;

var builder = WebApplication.CreateBuilder(args);

// Allow the Chrome extension (chrome-extension://*) and hosted callers to reach this API.
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.SetIsOriginAllowed(_ => true)
     .AllowAnyMethod()
     .AllowAnyHeader()));

var app = builder.Build();
app.UseCors();

var connStr = builder.Configuration.GetConnectionString("DefaultConnection")!;
SqlConnection Db() => new SqlConnection(connStr);

// The schema is created by create_database_full.sql (run drop_all_tables.sql first).
// This API does NOT create tables — it assumes the redesigned schema exists:
//   sessions · scraped_leads · imported_leads · existing_clients
//   outreach_conversations · conversation_messages · nurture_templates · nurture_sequences

// Only "scraped" and "imported" are valid lead kinds; map to the physical table.
static string LeadTable(string kind) => kind switch
{
    "scraped"  => "scraped_leads",
    "imported" => "imported_leads",
    _          => throw new ArgumentException("kind must be 'scraped' or 'imported'"),
};

// ═══════════════════════════════════════════════════════════════════════════
//  HEALTH + CONFIG  (unchanged — config lives in appsettings.json)
// ═══════════════════════════════════════════════════════════════════════════
app.MapGet("/api/health", () => new { ok = true, time = DateTime.UtcNow });

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
    var explicitProvider = builder.Configuration["ResearchProvider"];
    var provider = explicitProvider switch
    {
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
        hasKey               = useGemini || useAnthropic || useOpenAi,
        businessProfile,
        interaktApiKey       = interaktKey,
        interaktTemplateName = interaktTemplate,
        interaktCountryCode  = interaktCountry,
        crmApiUrl,
        crmApiKey,
        crmAuthType,
    };
});

app.MapPost("/api/config/business-profile", async (BusinessProfileUpdate body) =>
{
    var path = Path.Combine(builder.Environment.ContentRootPath, "appsettings.json");
    var json = await File.ReadAllTextAsync(path);
    var root = JsonNode.Parse(json)!.AsObject();
    if (root["App"] is not JsonObject appSection) { appSection = new JsonObject(); root["App"] = appSection; }
    appSection["BusinessProfile"] = body.BusinessProfile;
    await File.WriteAllTextAsync(path, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    return Results.Ok(new { ok = true });
});

// ═══════════════════════════════════════════════════════════════════════════
//  SESSIONS
// ═══════════════════════════════════════════════════════════════════════════
app.MapGet("/api/sessions", async () =>
{
    using var db = Db();
    var rows = await db.QueryAsync(
        "SELECT id, name, source, country, keywords_json, cities_json, business_profile, status, total_leads, created_at, completed_at FROM sessions ORDER BY created_at DESC");
    return Results.Ok(rows);
});

app.MapPost("/api/sessions", async (SessionIn body) =>
{
    using var db = Db();
    var id = await db.ExecuteScalarAsync<int>("""
        INSERT INTO sessions (name, source, country, keywords_json, cities_json, business_profile, status)
        OUTPUT INSERTED.id
        VALUES (@Name, @Source, @Country, @KeywordsJson, @CitiesJson, @BusinessProfile, @Status);
        """, new
    {
        body.Name,
        Source = string.IsNullOrWhiteSpace(body.Source) ? "scrape" : body.Source,
        body.Country,
        KeywordsJson = JsonSerializer.Serialize(body.Keywords ?? Array.Empty<string>()),
        CitiesJson   = JsonSerializer.Serialize(body.Cities ?? Array.Empty<string>()),
        body.BusinessProfile,
        Status = string.IsNullOrWhiteSpace(body.Status) ? "active" : body.Status,
    });
    return Results.Ok(new { id });
});

app.MapPut("/api/sessions/{id:int}", async (int id, SessionUpdate body) =>
{
    using var db = Db();
    await db.ExecuteAsync("""
        UPDATE sessions SET
          name             = COALESCE(@Name, name),
          status           = COALESCE(@Status, status),
          business_profile = COALESCE(@BusinessProfile, business_profile),
          total_leads      = COALESCE(@TotalLeads, total_leads),
          completed_at     = CASE WHEN @Status IN ('completed','stopped') THEN SYSUTCDATETIME() ELSE completed_at END
        WHERE id = @Id;
        """, new { Id = id, body.Name, body.Status, body.BusinessProfile, body.TotalLeads });
    return Results.Ok(new { ok = true });
});

app.MapDelete("/api/sessions/{id:int}", async (int id) =>
{
    using var db = Db();
    await db.ExecuteAsync("DELETE FROM sessions WHERE id = @id", new { id }); // cascades to leads
    return Results.Ok(new { ok = true });
});

// ═══════════════════════════════════════════════════════════════════════════
//  LEADS  (kind = scraped | imported)
// ═══════════════════════════════════════════════════════════════════════════

// Upsert a batch of leads for a session (dedupe on session_id + normalized_name).
// Capture fields only — enrichment/validation/research are set by their own endpoints
// and are never clobbered by a re-sync.
app.MapPost("/api/leads/{kind}/save-batch", async (string kind, SaveBatchIn body) =>
{
    string table;
    try { table = LeadTable(kind); } catch (ArgumentException e) { return Results.BadRequest(new { error = e.Message }); }

    var importCols = kind == "imported" ? ", import_file, source_row_json" : "";
    var importVals = kind == "imported" ? ", @ImportFile, @SourceRowJson" : "";
    var stampCol   = kind == "imported" ? "imported_at" : "captured_at";

    var sql = $"""
        MERGE {table} AS t
        USING (SELECT @SessionId AS session_id, @NormalizedName AS normalized_name) AS s
          ON t.session_id = s.session_id AND t.normalized_name = s.normalized_name
        WHEN MATCHED THEN UPDATE SET
          company_name = @CompanyName, category = @Category, rating = @Rating,
          review_count = @ReviewCount, address = @Address, phone = @Phone, website = @Website,
          google_maps_url = @GoogleMapsUrl, map_score = @MapScore, city = @City,
          keyword = @Keyword, country = @Country, notes = COALESCE(@Notes, t.notes),
          tags_json = COALESCE(@TagsJson, t.tags_json), updated_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT
          (session_id, company_name, normalized_name, category, rating, review_count, address,
           phone, website, google_maps_url, map_score, city, keyword, country, status, notes,
           tags_json, {stampCol}{importCols})
          VALUES
          (@SessionId, @CompanyName, @NormalizedName, @Category, @Rating, @ReviewCount, @Address,
           @Phone, @Website, @GoogleMapsUrl, @MapScore, @City, @Keyword, @Country, @Status, @Notes,
           @TagsJson, SYSUTCDATETIME(){importVals})
        OUTPUT INSERTED.id, INSERTED.normalized_name;
        """;

    using var db = Db();
    await db.OpenAsync();
    using var tx = db.BeginTransaction();
    var ids = new List<object>();
    foreach (var l in body.Leads)
    {
        var row = await db.QuerySingleAsync(sql, new
        {
            body.SessionId, body.ImportFile,
            l.CompanyName, l.NormalizedName, l.Category, l.Rating, l.ReviewCount, l.Address,
            l.Phone, l.Website, l.GoogleMapsUrl, l.MapScore, l.City, l.Keyword, l.Country,
            Status = string.IsNullOrWhiteSpace(l.Status) ? "new" : l.Status,
            l.Notes, l.TagsJson, l.SourceRowJson,
        }, tx);
        ids.Add(new { normalizedName = (string)row.normalized_name, id = (int)row.id });
    }
    tx.Commit();
    return Results.Ok(new { saved = ids.Count, ids });
});

// Enrichment result → inline columns + enrichment_json.
app.MapPut("/api/leads/{kind}/{id:int}/enrichment", async (string kind, int id, EnrichmentIn body) =>
{
    string table;
    try { table = LeadTable(kind); } catch (ArgumentException e) { return Results.BadRequest(new { error = e.Message }); }
    using var db = Db();
    await db.ExecuteAsync($"""
        UPDATE {table} SET
          team_size = COALESCE(@TeamSize, team_size),
          annual_turnover = COALESCE(@AnnualTurnover, annual_turnover),
          industry = COALESCE(@Industry, industry),
          decision_maker = COALESCE(@DecisionMaker, decision_maker),
          email = COALESCE(@Email, email),
          alternate_phone = COALESCE(@AlternatePhone, alternate_phone),
          year_founded = COALESCE(@YearFounded, year_founded),
          company_type = COALESCE(@CompanyType, company_type),
          employee_count = COALESCE(@EmployeeCount, employee_count),
          headquarters = COALESCE(@Headquarters, headquarters),
          linkedin = COALESCE(@LinkedIn, linkedin), facebook = COALESCE(@Facebook, facebook),
          instagram = COALESCE(@Instagram, instagram), twitter = COALESCE(@Twitter, twitter),
          youtube = COALESCE(@Youtube, youtube), whatsapp = COALESCE(@Whatsapp, whatsapp),
          enrichment_json = COALESCE(@EnrichmentJson, enrichment_json),
          enrichment_confidence = COALESCE(@Confidence, enrichment_confidence),
          enrichment_status = 'done', enriched_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
        WHERE id = @Id;
        """, new
    {
        Id = id, body.TeamSize, body.AnnualTurnover, body.Industry, body.DecisionMaker, body.Email,
        body.AlternatePhone, body.YearFounded, body.CompanyType, body.EmployeeCount, body.Headquarters,
        body.LinkedIn, body.Facebook, body.Instagram, body.Twitter, body.Youtube, body.Whatsapp,
        body.EnrichmentJson, body.Confidence,
    });
    return Results.Ok(new { ok = true });
});

// Validation / ICP score.
app.MapPut("/api/leads/{kind}/{id:int}/validation", async (string kind, int id, ValidationIn body) =>
{
    string table;
    try { table = LeadTable(kind); } catch (ArgumentException e) { return Results.BadRequest(new { error = e.Message }); }
    using var db = Db();
    await db.ExecuteAsync($"""
        UPDATE {table} SET
          validation_status = @ValidationStatus, icp_score = @IcpScore, icp_status = @IcpStatus,
          icp_reason = @IcpReason, score_breakdown_json = @ScoreBreakdownJson,
          validated_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
        WHERE id = @Id;
        """, new { Id = id, body.ValidationStatus, body.IcpScore, body.IcpStatus, body.IcpReason, body.ScoreBreakdownJson });
    return Results.Ok(new { ok = true });
});

// Bulk validation (one round-trip for many leads).
app.MapPost("/api/leads/{kind}/validate-bulk", async (string kind, ValidationBulkIn body) =>
{
    string table;
    try { table = LeadTable(kind); } catch (ArgumentException e) { return Results.BadRequest(new { error = e.Message }); }
    using var db = Db();
    await db.OpenAsync();
    using var tx = db.BeginTransaction();
    var sql = $"""
        UPDATE {table} SET validation_status=@ValidationStatus, icp_score=@IcpScore, icp_status=@IcpStatus,
          icp_reason=@IcpReason, score_breakdown_json=@ScoreBreakdownJson,
          validated_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME() WHERE id=@Id;
        """;
    foreach (var v in body.Items)
        await db.ExecuteAsync(sql, new { v.Id, v.ValidationStatus, v.IcpScore, v.IcpStatus, v.IcpReason, v.ScoreBreakdownJson }, tx);
    tx.Commit();
    return Results.Ok(new { updated = body.Items.Length });
});

// Deep research result → research columns + refresh intel scalars research found.
app.MapPut("/api/leads/{kind}/{id:int}/research", async (string kind, int id, ResearchIn body) =>
{
    string table;
    try { table = LeadTable(kind); } catch (ArgumentException e) { return Results.BadRequest(new { error = e.Message }); }
    using var db = Db();
    await db.ExecuteAsync($"""
        UPDATE {table} SET
          research_status = COALESCE(@ResearchStatus, 'completed'),
          research_summary = COALESCE(@ResearchSummary, research_summary),
          research_json = COALESCE(@ResearchJson, research_json),
          research_confidence = COALESCE(@Confidence, research_confidence),
          decision_maker = COALESCE(@DecisionMaker, decision_maker),
          email = COALESCE(@Email, email),
          annual_turnover = COALESCE(@AnnualTurnover, annual_turnover),
          team_size = COALESCE(@TeamSize, team_size),
          industry = COALESCE(@Industry, industry),
          linkedin = COALESCE(@LinkedIn, linkedin), facebook = COALESCE(@Facebook, facebook),
          instagram = COALESCE(@Instagram, instagram), twitter = COALESCE(@Twitter, twitter),
          youtube = COALESCE(@Youtube, youtube), whatsapp = COALESCE(@Whatsapp, whatsapp),
          researched_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
        WHERE id = @Id;
        """, new
    {
        Id = id, body.ResearchStatus, body.ResearchSummary, body.ResearchJson, body.Confidence,
        body.DecisionMaker, body.Email, body.AnnualTurnover, body.TeamSize, body.Industry,
        body.LinkedIn, body.Facebook, body.Instagram, body.Twitter, body.Youtube, body.Whatsapp,
    });
    return Results.Ok(new { ok = true });
});

// Status change (new | selected | not_relevant | research_queued | ...).
app.MapPut("/api/leads/{kind}/{id:int}/status", async (string kind, int id, StatusIn body) =>
{
    string table;
    try { table = LeadTable(kind); } catch (ArgumentException e) { return Results.BadRequest(new { error = e.Message }); }
    using var db = Db();
    await db.ExecuteAsync($"UPDATE {table} SET status=@Status, updated_at=SYSUTCDATETIME() WHERE id=@Id",
        new { Id = id, body.Status });
    return Results.Ok(new { ok = true });
});

// List a kind's leads (optionally by session).
app.MapGet("/api/leads/{kind}", async (string kind, int? sessionId) =>
{
    string table;
    try { table = LeadTable(kind); } catch (ArgumentException e) { return Results.BadRequest(new { error = e.Message }); }
    using var db = Db();
    var sql = sessionId is null
        ? $"SELECT * FROM {table} ORDER BY id DESC"
        : $"SELECT * FROM {table} WHERE session_id=@sessionId ORDER BY id DESC";
    return Results.Ok(await db.QueryAsync(sql, new { sessionId }));
});

// Full download for local rebuild (sync-down).
app.MapGet("/api/restore", async () =>
{
    using var db = Db();
    var sessions       = await db.QueryAsync("SELECT * FROM sessions ORDER BY created_at DESC");
    var scrapedLeads   = await db.QueryAsync("SELECT * FROM scraped_leads");
    var importedLeads  = await db.QueryAsync("SELECT * FROM imported_leads");
    return Results.Ok(new { sessions, scrapedLeads, importedLeads });
});

// ═══════════════════════════════════════════════════════════════════════════
//  EXISTING CLIENTS
// ═══════════════════════════════════════════════════════════════════════════
app.MapGet("/api/existing-clients", async () =>
{
    using var db = Db();
    return Results.Ok(await db.QueryAsync("SELECT * FROM existing_clients ORDER BY created_at DESC"));
});

app.MapPost("/api/existing-clients/upload-batch", async (ExistingClientBatch body) =>
{
    using var db = Db();
    await db.OpenAsync();
    using var tx = db.BeginTransaction();
    foreach (var c in body.Clients)
        await db.ExecuteAsync("""
            INSERT INTO existing_clients (company_name, normalized_name, city, phone, website, notes)
            VALUES (@CompanyName, @NormalizedName, @City, @Phone, @Website, @Notes);
            """, new { c.CompanyName, c.NormalizedName, c.City, c.Phone, c.Website, c.Notes }, tx);
    tx.Commit();
    return Results.Ok(new { saved = body.Clients.Length });
});

app.MapDelete("/api/existing-clients/{id:int}", async (int id) =>
{
    using var db = Db();
    await db.ExecuteAsync("DELETE FROM existing_clients WHERE id=@id", new { id });
    return Results.Ok(new { ok = true });
});

// ═══════════════════════════════════════════════════════════════════════════
//  OUTREACH + NURTURE  (leads referenced polymorphically: lead_source + lead_id)
// ═══════════════════════════════════════════════════════════════════════════
app.MapGet("/api/outreach/conversations", async () =>
{
    using var db = Db();
    return Results.Ok(await db.QueryAsync("SELECT * FROM outreach_conversations ORDER BY created_at DESC"));
});

app.MapPost("/api/outreach/conversations", async (ConversationIn body) =>
{
    using var db = Db();
    var id = await db.ExecuteScalarAsync<int>("""
        INSERT INTO outreach_conversations (lead_id, lead_source, channel, contact_name, contact_phone, status)
        OUTPUT INSERTED.id
        VALUES (@LeadId, @LeadSource, @Channel, @ContactName, @ContactPhone, @Status);
        """, new
    {
        body.LeadId, body.LeadSource,
        Channel = string.IsNullOrWhiteSpace(body.Channel) ? "whatsapp" : body.Channel,
        body.ContactName, body.ContactPhone,
        Status = string.IsNullOrWhiteSpace(body.Status) ? "active" : body.Status,
    });
    return Results.Ok(new { id });
});

app.MapGet("/api/outreach/conversations/{id:int}/messages", async (int id) =>
{
    using var db = Db();
    return Results.Ok(await db.QueryAsync("SELECT * FROM conversation_messages WHERE conversation_id=@id ORDER BY sent_at", new { id }));
});

app.MapPost("/api/outreach/conversations/{id:int}/messages", async (int id, MessageIn body) =>
{
    using var db = Db();
    await db.ExecuteAsync("""
        INSERT INTO conversation_messages (conversation_id, direction, body, status)
        VALUES (@Id, @Direction, @Body, @Status);
        UPDATE outreach_conversations SET last_message_at=SYSUTCDATETIME() WHERE id=@Id;
        """, new { Id = id, body.Direction, body.Body, body.Status });
    return Results.Ok(new { ok = true });
});

app.MapGet("/api/nurture/templates", async () =>
{
    using var db = Db();
    return Results.Ok(await db.QueryAsync("SELECT * FROM nurture_templates ORDER BY created_at DESC"));
});

app.MapPost("/api/nurture/templates", async (TemplateIn body) =>
{
    using var db = Db();
    var id = await db.ExecuteScalarAsync<int>("""
        INSERT INTO nurture_templates (name, channel, body)
        OUTPUT INSERTED.id VALUES (@Name, @Channel, @Body);
        """, new { body.Name, Channel = string.IsNullOrWhiteSpace(body.Channel) ? "whatsapp" : body.Channel, body.Body });
    return Results.Ok(new { id });
});

app.MapGet("/api/nurture/sequences", async () =>
{
    using var db = Db();
    return Results.Ok(await db.QueryAsync("SELECT * FROM nurture_sequences ORDER BY created_at DESC"));
});

app.MapPost("/api/nurture/sequences", async (SequenceIn body) =>
{
    using var db = Db();
    var id = await db.ExecuteScalarAsync<int>("""
        INSERT INTO nurture_sequences (lead_id, lead_source, template_id, status, next_action_at, notes)
        OUTPUT INSERTED.id
        VALUES (@LeadId, @LeadSource, @TemplateId, @Status, @NextActionAt, @Notes);
        """, new
    {
        body.LeadId, body.LeadSource, body.TemplateId,
        Status = string.IsNullOrWhiteSpace(body.Status) ? "scheduled" : body.Status,
        body.NextActionAt, body.Notes,
    });
    return Results.Ok(new { id });
});

app.MapPut("/api/nurture/sequences/{id:int}", async (int id, SequenceUpdate body) =>
{
    using var db = Db();
    await db.ExecuteAsync("""
        UPDATE nurture_sequences SET
          status = COALESCE(@Status, status),
          next_action_at = COALESCE(@NextActionAt, next_action_at),
          notes = COALESCE(@Notes, notes)
        WHERE id = @Id;
        """, new { Id = id, body.Status, body.NextActionAt, body.Notes });
    return Results.Ok(new { ok = true });
});

app.Run("http://localhost:5150");

// ═══════════════════════════════════════════════════════════════════════════
//  DTOs
// ═══════════════════════════════════════════════════════════════════════════
record BusinessProfileUpdate(string BusinessProfile);

record SessionIn(string Name, string? Source, string? Country, string[]? Keywords, string[]? Cities, string? BusinessProfile, string? Status);
record SessionUpdate(string? Name, string? Status, string? BusinessProfile, int? TotalLeads);

record LeadIn(
    string CompanyName, string NormalizedName, string? Category, decimal? Rating, int? ReviewCount,
    string? Address, string? Phone, string? Website, string? GoogleMapsUrl, int? MapScore,
    string? City, string? Keyword, string? Country, string? Status, string? Notes, string? TagsJson,
    string? SourceRowJson);
record SaveBatchIn(int SessionId, string? ImportFile, LeadIn[] Leads);

record EnrichmentIn(
    string? TeamSize, string? AnnualTurnover, string? Industry, string? DecisionMaker, string? Email,
    string? AlternatePhone, int? YearFounded, string? CompanyType, string? EmployeeCount, string? Headquarters,
    string? LinkedIn, string? Facebook, string? Instagram, string? Twitter, string? Youtube, string? Whatsapp,
    string? EnrichmentJson, decimal? Confidence);

record ValidationIn(string? ValidationStatus, int? IcpScore, string? IcpStatus, string? IcpReason, string? ScoreBreakdownJson);
record ValidationItem(int Id, string? ValidationStatus, int? IcpScore, string? IcpStatus, string? IcpReason, string? ScoreBreakdownJson);
record ValidationBulkIn(ValidationItem[] Items);

record ResearchIn(
    string? ResearchStatus, string? ResearchSummary, string? ResearchJson, decimal? Confidence,
    string? DecisionMaker, string? Email, string? AnnualTurnover, string? TeamSize, string? Industry,
    string? LinkedIn, string? Facebook, string? Instagram, string? Twitter, string? Youtube, string? Whatsapp);

record StatusIn(string Status);

record ExistingClient(string CompanyName, string NormalizedName, string? City, string? Phone, string? Website, string? Notes);
record ExistingClientBatch(ExistingClient[] Clients);

record ConversationIn(int LeadId, string LeadSource, string? Channel, string? ContactName, string? ContactPhone, string? Status);
record MessageIn(string Direction, string? Body, string? Status);
record TemplateIn(string Name, string? Channel, string Body);
record SequenceIn(int LeadId, string LeadSource, int? TemplateId, string? Status, DateTime? NextActionAt, string? Notes);
record SequenceUpdate(string? Status, DateTime? NextActionAt, string? Notes);
