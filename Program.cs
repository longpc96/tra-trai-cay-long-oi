using System.Text.Json;
using System.Text.Json.Nodes;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var root = Directory.GetParent(app.Environment.ContentRootPath)!.FullName;
var publicDir = Path.Combine(root, "public");
var dataDir = Path.Combine(root, "data");
var dataFile = Path.Combine(dataDir, "store.json");
var adminPassword = Environment.GetEnvironmentVariable("ADMIN_PASSWORD") ?? "1234";
var sessions = new HashSet<string>();
var jsonOptions = new JsonSerializerOptions { PropertyNamingPolicy = null, WriteIndented = true };

void EnsureStore()
{
    Directory.CreateDirectory(dataDir);
    if (File.Exists(dataFile)) return;
    var store = new JsonObject
    {
        ["shopName"] = "Shop Order",
        ["products"] = new JsonArray
        {
            new JsonObject
            {
                ["id"] = Guid.NewGuid().ToString(),
                ["name"] = "San pham mau",
                ["price"] = 99000,
                ["description"] = "Ban co the doi thanh san pham that trong trang quan tri.",
                ["image"] = "",
                ["isActive"] = true
            }
        },
        ["orders"] = new JsonArray()
    };
    File.WriteAllText(dataFile, store.ToJsonString(jsonOptions));
}

JsonObject ReadStore()
{
    EnsureStore();
    var store = JsonNode.Parse(File.ReadAllText(dataFile))!.AsObject();
    store["products"] ??= new JsonArray();
    store["orders"] ??= new JsonArray();
    foreach (var product in store["products"]!.AsArray().OfType<JsonObject>())
    {
        product["isActive"] ??= true;
    }
    return store;
}

void WriteStore(JsonObject store)
{
    Directory.CreateDirectory(dataDir);
    File.WriteAllText(dataFile, store.ToJsonString(jsonOptions));
}

bool IsAdmin(HttpRequest request)
{
    var header = request.Headers.Authorization.ToString();
    return header.StartsWith("Bearer ") && sessions.Contains(header[7..]);
}

string? RequiredText(JsonNode? value, int maxLength)
{
    var text = value?.ToString().Trim() ?? "";
    return text.Length > 0 && text.Length <= maxLength ? text : null;
}

JsonObject PublicShop(JsonObject store)
{
    var products = new JsonArray();
    foreach (var product in store["products"]!.AsArray().OfType<JsonObject>())
    {
        if (product["isActive"]?.GetValue<bool>() != false) products.Add(product.DeepClone());
    }
    return new JsonObject
    {
        ["shopName"] = store["shopName"]?.ToString() ?? "Shop Order",
        ["products"] = products
    };
}

JsonObject AdminSummary(JsonObject store)
{
    double revenue = 0;
    int sold = 0;
    foreach (var order in store["orders"]!.AsArray().OfType<JsonObject>())
    {
        revenue += order["total"]?.GetValue<double>() ?? 0;
        if (order["items"] is JsonArray items)
        {
            sold += items.OfType<JsonObject>().Sum(item => item["quantity"]?.GetValue<int>() ?? 0);
        }
        else
        {
            sold += order["quantity"]?.GetValue<int>() ?? 0;
        }
    }
    return new JsonObject
    {
        ["shopName"] = store["shopName"]?.ToString() ?? "Shop Order",
        ["products"] = store["products"]!.DeepClone(),
        ["orders"] = store["orders"]!.DeepClone(),
        ["summary"] = new JsonObject
        {
            ["totalRevenue"] = revenue,
            ["totalOrders"] = store["orders"]!.AsArray().Count,
            ["totalSold"] = sold
        }
    };
}

JsonObject Error(string message) => new() { ["error"] = message };

app.MapGet("/api/shop", () => Results.Json(PublicShop(ReadStore())));

app.MapPost("/api/admin/login", async (HttpRequest request) =>
{
    var body = (await JsonNode.ParseAsync(request.Body))?.AsObject() ?? new JsonObject();
    if ((body["password"]?.ToString() ?? "") != adminPassword)
    {
        return Results.Json(Error("Sai mat khau."), statusCode: 401);
    }
    var token = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
    sessions.Add(token);
    return Results.Json(new JsonObject { ["token"] = token });
});

app.MapGet("/api/admin/dashboard", (HttpRequest request) =>
    IsAdmin(request) ? Results.Json(AdminSummary(ReadStore())) : Results.Json(Error("Ban can dang nhap quan tri."), statusCode: 401));

app.MapPut("/api/admin/shop", async (HttpRequest request) =>
{
    if (!IsAdmin(request)) return Results.Json(Error("Ban can dang nhap quan tri."), statusCode: 401);
    var store = ReadStore();
    var body = (await JsonNode.ParseAsync(request.Body))?.AsObject() ?? new JsonObject();
    var shopName = RequiredText(body["shopName"], 80);
    if (shopName is null) return Results.Json(Error("Ten shop chua hop le."), statusCode: 400);
    store["shopName"] = shopName;
    WriteStore(store);
    return Results.Json(AdminSummary(store));
});

app.MapPost("/api/admin/products", async (HttpRequest request) =>
{
    if (!IsAdmin(request)) return Results.Json(Error("Ban can dang nhap quan tri."), statusCode: 401);
    var store = ReadStore();
    var body = (await JsonNode.ParseAsync(request.Body))?.AsObject() ?? new JsonObject();
    var name = RequiredText(body["name"], 100);
    var price = body["price"]?.GetValue<double>() ?? -1;
    if (name is null || price < 0) return Results.Json(Error("Thong tin san pham chua hop le."), statusCode: 400);
    var image = body["image"]?.ToString().Trim() ?? "";
    if (image.Length > 2_200_000) image = image[..2_200_000];
    store["products"]!.AsArray().Add(new JsonObject
    {
        ["id"] = Guid.NewGuid().ToString(),
        ["name"] = name,
        ["price"] = price,
        ["description"] = body["description"]?.ToString().Trim() ?? "",
        ["image"] = image,
        ["isActive"] = true
    });
    WriteStore(store);
    return Results.Json(AdminSummary(store), statusCode: 201);
});

app.MapPatch("/api/admin/products/{id}/status", async (HttpRequest request, string id) =>
{
    if (!IsAdmin(request)) return Results.Json(Error("Ban can dang nhap quan tri."), statusCode: 401);
    var store = ReadStore();
    var product = store["products"]!.AsArray().OfType<JsonObject>().FirstOrDefault(item => item["id"]?.ToString() == id);
    if (product is null) return Results.Json(Error("Khong tim thay san pham."), statusCode: 404);
    var body = (await JsonNode.ParseAsync(request.Body))?.AsObject() ?? new JsonObject();
    product["isActive"] = body["isActive"]?.GetValue<bool>() != false;
    WriteStore(store);
    return Results.Json(AdminSummary(store));
});

app.MapDelete("/api/admin/products/{id}", (HttpRequest request, string id) =>
{
    if (!IsAdmin(request)) return Results.Json(Error("Ban can dang nhap quan tri."), statusCode: 401);
    var store = ReadStore();
    var products = store["products"]!.AsArray();
    for (var i = products.Count - 1; i >= 0; i--)
    {
        if (products[i]?["id"]?.ToString() == id) products.RemoveAt(i);
    }
    WriteStore(store);
    return Results.Json(AdminSummary(store));
});

app.MapDelete("/api/admin/orders", (HttpRequest request) =>
{
    if (!IsAdmin(request)) return Results.Json(Error("Ban can dang nhap quan tri."), statusCode: 401);
    var store = ReadStore();
    store["orders"] = new JsonArray();
    WriteStore(store);
    return Results.Json(AdminSummary(store));
});

app.MapPost("/api/orders", async (HttpRequest request) =>
{
    var store = ReadStore();
    var body = (await JsonNode.ParseAsync(request.Body))?.AsObject() ?? new JsonObject();
    var requested = body["items"] as JsonArray ?? new JsonArray(new JsonObject
    {
        ["productId"] = body["productId"]?.ToString(),
        ["quantity"] = body["quantity"]?.GetValue<int>() ?? 0
    });
    var name = RequiredText(body["name"], 80);
    var phone = RequiredText(body["phone"], 40);
    var address = RequiredText(body["address"], 300);
    var note = body["note"]?.ToString().Trim() ?? "";
    if (note.Length > 300) note = note[..300];
    var items = new JsonArray();
    foreach (var requestedItem in requested.OfType<JsonObject>())
    {
        var productId = requestedItem["productId"]?.ToString();
        var quantity = requestedItem["quantity"]?.GetValue<int>() ?? 0;
        var product = store["products"]!.AsArray().OfType<JsonObject>().FirstOrDefault(item => item["id"]?.ToString() == productId);
        if (product is null || product["isActive"]?.GetValue<bool>() == false || quantity < 1)
        {
            return Results.Json(Error("Thong tin don hang chua hop le."), statusCode: 400);
        }
        var price = product["price"]?.GetValue<double>() ?? 0;
        items.Add(new JsonObject
        {
            ["productId"] = product["id"]!.ToString(),
            ["productName"] = product["name"]!.ToString(),
            ["price"] = price,
            ["quantity"] = quantity,
            ["total"] = price * quantity
        });
    }
    if (items.Count == 0 || name is null || phone is null || address is null)
    {
        return Results.Json(Error("Thong tin don hang chua hop le."), statusCode: 400);
    }
    var total = items.OfType<JsonObject>().Sum(item => item["total"]?.GetValue<double>() ?? 0);
    var quantityTotal = items.OfType<JsonObject>().Sum(item => item["quantity"]?.GetValue<int>() ?? 0);
    var productName = string.Join(", ", items.OfType<JsonObject>().Select(item => $"{item["productName"]} x{item["quantity"]}"));
    var order = new JsonObject
    {
        ["id"] = Guid.NewGuid().ToString(),
        ["createdAt"] = DateTimeOffset.UtcNow.ToString("O"),
        ["items"] = items,
        ["productName"] = productName,
        ["quantity"] = quantityTotal,
        ["total"] = total,
        ["name"] = name,
        ["phone"] = phone,
        ["address"] = address,
        ["note"] = note
    };
    store["orders"]!.AsArray().Add(order);
    WriteStore(store);
    return Results.Json(new JsonObject { ["ok"] = true, ["orderId"] = order["id"]!.ToString() }, statusCode: 201);
});

app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(publicDir) });
app.UseStaticFiles(new StaticFileOptions { FileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(publicDir) });

EnsureStore();
app.Run();
