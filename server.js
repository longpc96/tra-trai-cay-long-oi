const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const PUBLIC_DIR_CANDIDATES = [
  path.join(__dirname, "public"),
  path.join(process.cwd(), "public"),
  path.join(__dirname, "order-web-upload", "public"),
  path.join(process.cwd(), "order-web-upload", "public"),
  path.join(__dirname, "order-web-online", "public"),
  path.join(process.cwd(), "order-web-online", "public")
];
const PUBLIC_DIR = PUBLIC_DIR_CANDIDATES.find(dir => fs.existsSync(path.join(dir, "index.html"))) || PUBLIC_DIR_CANDIDATES[0];
const MAX_BODY_SIZE = 3_000_000;
const MAX_IMAGE_LENGTH = 2_200_000;
const SHOP_TIME_ZONE = "Asia/Bangkok";
const shopDateFormatter = new Intl.DateTimeFormat("vi-VN", {
  timeZone: SHOP_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric"
});
const sessions = new Set();
const adminEvents = new Set();
let storeMutationQueue = Promise.resolve();

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    writeStore({
      shopName: "Trà Trái Cây Long Ơi",
      bankQr: "",
      bank: {
        code: "MB",
        accountNumber: "9916617122001",
        accountName: "VU DUC LONG",
        transferPrefix: "LONGOI"
      },
      openingHours: {
        open: "10:00",
        close: "23:00"
      },
      products: [
        {
          id: crypto.randomUUID(),
          name: "Trà trái cây mẫu",
          price: 25000,
          description: "Bạn có thể đổi thành sản phẩm thật trong trang quản trị.",
          image: "",
          isActive: true
        }
      ],
      orders: []
    });
  }
}

function readStore() {
  ensureStore();
  const store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!store.shopName || store.shopName === "Shop Order") {
    store.shopName = "Trà Trái Cây Long Ơi";
  }
  store.bankQr = store.bankQr || "";
  store.bank = {
    code: store.bank?.code || "MB",
    accountNumber: store.bank?.accountNumber || "9916617122001",
    accountName: store.bank?.accountName || "VU DUC LONG",
    transferPrefix: store.bank?.transferPrefix || "LONGOI"
  };
  store.openingHours = {
    open: store.openingHours?.open || "10:00",
    close: store.openingHours?.close || "23:00"
  };
  store.products = (store.products || []).map(product => ({
    ...product,
    isActive: product.isActive !== false
  }));
  store.orders = store.orders || [];
  store.orders = store.orders.map(order => ({
    ...order,
    status: order.status || "pending"
  }));
  return store;
}

function writeStore(store) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function normalizeStore(store) {
  store = store || {};
  if (!store.shopName || store.shopName === "Shop Order") store.shopName = "TrÃ  TrÃ¡i CÃ¢y Long Æ i";
  store.bankQr = store.bankQr || "";
  store.bank = {
    code: store.bank?.code || "MB",
    accountNumber: store.bank?.accountNumber || "9916617122001",
    accountName: store.bank?.accountName || "VU DUC LONG",
    transferPrefix: store.bank?.transferPrefix || "LONGOI"
  };
  store.openingHours = {
    open: store.openingHours?.open || "10:00",
    close: store.openingHours?.close || "23:00"
  };
  store.products = (store.products || []).map(product => ({ ...product, isActive: product.isActive !== false }));
  store.orders = (store.orders || []).map(order => ({ ...order, status: order.status || "pending" }));
  return store;
}

async function supabaseRequest(pathname, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || data?.error || "Supabase request failed");
  return data;
}

async function loadStore() {
  if (!USE_SUPABASE) return readStore();
  try {
    const rows = await supabaseRequest("app_store?id=eq.main&select=data");
    if (rows.length) return normalizeStore(rows[0].data);
    const store = readStore();
    await supabaseRequest("app_store", {
      method: "POST",
      body: JSON.stringify({ id: "main", data: store })
    });
    return store;
  } catch (error) {
    console.error(`Supabase load failed: ${error.message}`);
    return readStore();
  }
}

async function saveStore(store) {
  store = normalizeStore(store);
  if (!USE_SUPABASE) {
    writeStore(store);
    return;
  }
  try {
    await supabaseRequest("app_store?id=eq.main", {
      method: "PATCH",
      body: JSON.stringify({ data: store, updated_at: new Date().toISOString() })
    });
  } catch (error) {
    console.error(`Supabase save failed: ${error.message}`);
    writeStore(store);
  }
}

async function runStoreMutation(mutator) {
  const run = storeMutationQueue.then(async () => {
    const store = await loadStore();
    const result = await mutator(store);
    await saveStore(store);
    return result ?? store;
  });
  storeMutationQueue = run.catch(() => {});
  return run;
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function isAdmin(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return sessions.has(token);
}

function requiredText(value, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength) return null;
  return text;
}

function timeText(value, fallback) {
  const text = String(value || "").trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
}

function shopDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return shopDateFormatter.format(new Date());
  return shopDateFormatter.format(date);
}

function publicShop(store) {
  return {
    shopName: store.shopName,
    bankQr: store.bankQr || "",
    bank: store.bank,
    openingHours: store.openingHours,
    products: store.products.filter(product => product.isActive !== false)
  };
}

function adminSummary(store) {
  const completedOrders = store.orders.filter(order => order.status === "completed");
  const totalRevenue = completedOrders.reduce((sum, order) => sum + order.total, 0);
  const totalSold = completedOrders.reduce((sum, order) => {
    if (Array.isArray(order.items)) {
      return sum + order.items.reduce((itemSum, item) => itemSum + item.quantity, 0);
    }
    return sum + (order.quantity || 0);
  }, 0);
  const revenueByDateMap = new Map();
  const productSalesByDateMap = new Map();
  for (const order of completedOrders) {
    const dateKey = shopDateKey(order.createdAt);
    const current = revenueByDateMap.get(dateKey) || { date: dateKey, totalRevenue: 0, totalOrders: 0, totalSold: 0 };
    current.totalRevenue += order.total || 0;
    current.totalOrders += 1;
    current.totalSold += orderQuantity(order);
    revenueByDateMap.set(dateKey, current);

    const dayProducts = productSalesByDateMap.get(dateKey) || new Map();
    const items = Array.isArray(order.items) && order.items.length
      ? order.items
      : [{ productName: order.productName || "Sản phẩm", quantity: order.quantity || 0, total: order.total || 0 }];
    for (const item of items) {
      const productName = item.productName || "Sản phẩm";
      const product = dayProducts.get(productName) || { productName, quantity: 0, totalRevenue: 0 };
      product.quantity += Number(item.quantity) || 0;
      product.totalRevenue += Number(item.total) || ((Number(item.price) || 0) * (Number(item.quantity) || 0));
      dayProducts.set(productName, product);
    }
    productSalesByDateMap.set(dateKey, dayProducts);
  }
  const productSalesByDate = Array.from(productSalesByDateMap.entries()).map(([date, products]) => ({
    date,
    products: Array.from(products.values()).sort((a, b) => b.quantity - a.quantity)
  })).reverse();

  return {
    shopName: store.shopName,
    bankQr: store.bankQr || "",
    bank: store.bank,
    openingHours: store.openingHours,
    products: store.products,
    orders: store.orders,
    summary: {
      totalRevenue,
      totalOrders: completedOrders.length,
      totalSold,
      revenueByDate: Array.from(revenueByDateMap.values()).reverse(),
      productSalesByDate
    }
  };
}

function orderQuantity(order) {
  if (Array.isArray(order.items)) {
    return order.items.reduce((sum, item) => sum + item.quantity, 0);
  }
  return order.quantity || 0;
}

function adminOrders(store) {
  const summary = adminSummary(store).summary;
  return {
    orders: store.orders,
    summary
  };
}

function writeAdminEvent(res, data) {
  res.write(`event: orders\ndata: ${JSON.stringify(data)}\n\n`);
}

async function notifyAdminOrders() {
  if (!adminEvents.size) return;
  const data = adminOrders(await loadStore());
  for (const client of Array.from(adminEvents)) {
    try {
      writeAdminEvent(client.res, data);
    } catch {
      adminEvents.delete(client);
    }
  }
}

async function handleAdminOrderEvents(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const token = url.searchParams.get("token") || "";
  if (!sessions.has(token)) return send(res, 401, { error: "Ban can dang nhap quan tri." });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive"
  });

  const client = { res };
  adminEvents.add(client);
  writeAdminEvent(res, adminOrders(await loadStore()));

  const keepAlive = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    adminEvents.delete(client);
  });
}

function serveStatic(req, res) {
  const safePath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden", "text/plain; charset=utf-8");

  fs.readFile(filePath, (error, data) => {
    if (error) {
      return send(
        res,
        404,
        `Not found: ${safePath}\nExpected public folder at: ${PUBLIC_DIR}\nMake sure public/index.html exists.`,
        "text/plain; charset=utf-8"
      );
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp"
    };
    send(res, 200, data, types[ext] || "application/octet-stream");
  });
}

async function handleApi(req, res) {
  let store;
  const getStore = async () => {
    if (!store) store = await loadStore();
    return store;
  };

  if (req.method === "GET" && req.url === "/api/shop") {
    store = await getStore();
    return send(res, 200, publicShop(store));
  }

  if (req.method === "POST" && req.url === "/api/orders") {
    store = await getStore();
    const body = await readBody(req);
    const requestedItems = Array.isArray(body.items)
      ? body.items
      : [{ productId: body.productId, quantity: body.quantity }];
    const name = requiredText(body.name, 80);
    const phone = requiredText(body.phone, 40);
    const address = requiredText(body.address, 300);
    const note = String(body.note || "").trim().slice(0, 300);
    const paymentMethod = body.paymentMethod === "bank" ? "bank" : "cash";
    const items = [];

    for (const requestedItem of requestedItems) {
      const product = store.products.find(item => item.id === requestedItem.productId);
      const quantity = Number(requestedItem.quantity);
      if (!product || product.isActive === false || !Number.isInteger(quantity) || quantity < 1) {
        return send(res, 400, { error: "Thông tin đơn hàng chưa hợp lệ." });
      }
      items.push({
        productId: product.id,
        productName: product.name,
        price: product.price,
        quantity,
        total: product.price * quantity
      });
    }

    if (!items.length || !name || !phone || !address) {
      return send(res, 400, { error: "Thông tin đơn hàng chưa hợp lệ." });
    }

    const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
    const total = items.reduce((sum, item) => sum + item.total, 0);

    const order = {
      id: crypto.randomUUID(),
      status: "pending",
      createdAt: new Date().toISOString(),
      items,
      productName: items.map(item => `${item.productName} x${item.quantity}`).join(", "),
      quantity,
      total,
      name,
      phone,
      address,
      note,
      paymentMethod
    };

    store.orders.push(order);
    await saveStore(store);
    await notifyAdminOrders();
    return send(res, 201, { ok: true, orderId: order.id });
  }

  if (req.method === "POST" && req.url === "/api/admin/login") {
    const body = await readBody(req);
    if (String(body.username || "") !== ADMIN_USERNAME || String(body.password || "") !== ADMIN_PASSWORD) {
      return send(res, 401, { error: "Sai tài khoản hoặc mật khẩu." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.add(token);
    return send(res, 200, { token });
  }

  if (req.method === "GET" && req.url.startsWith("/api/admin/orders/events")) {
    return handleAdminOrderEvents(req, res);
  }

  if (req.url.startsWith("/api/admin") && !isAdmin(req)) {
    return send(res, 401, { error: "Bạn cần đăng nhập quản trị." });
  }

  if (req.method === "GET" && req.url === "/api/admin/dashboard") {
    store = await getStore();
    return send(res, 200, adminSummary(store));
  }

  if (req.method === "GET" && req.url === "/api/admin/orders/live") {
    store = await getStore();
    return send(res, 200, adminOrders(store));
  }

  if (req.method === "PATCH" && req.url.startsWith("/api/admin/orders/")) {
    store = await getStore();
    const parts = req.url.split("/");
    const id = decodeURIComponent(parts[parts.length - 2] || "");
    const action = parts[parts.length - 1];
    if (!["complete", "cancel"].includes(action)) return send(res, 404, { error: "Không tìm thấy API." });

    const order = store.orders.find(item => item.id === id);
    if (!order) return send(res, 404, { error: "Không tìm thấy đơn hàng." });
    order.status = action === "complete" ? "completed" : "cancelled";
    await saveStore(store);
    await notifyAdminOrders();
    return send(res, 200, adminSummary(store));
  }

  if (req.method === "DELETE" && req.url.startsWith("/api/admin/orders/") && req.url !== "/api/admin/orders") {
    store = await getStore();
    const id = decodeURIComponent(req.url.split("/").pop());
    const order = store.orders.find(item => item.id === id);
    if (!order) return send(res, 404, { error: "Khong tim thay don hang." });
    store.orders = store.orders.filter(item => item.id !== id);
    await saveStore(store);
    await notifyAdminOrders();
    return send(res, 200, adminSummary(store));
  }

  if (req.method === "PUT" && req.url === "/api/admin/shop") {
    store = await getStore();
    const body = await readBody(req);
    const shopName = requiredText(body.shopName, 80);
    const bankQr = String(body.bankQr || "").trim().slice(0, MAX_IMAGE_LENGTH);
    const bank = {
      code: requiredText(body.bankCode, 20) || "MB",
      accountNumber: requiredText(body.bankAccountNumber, 40) || "9916617122001",
      accountName: requiredText(body.bankAccountName, 100) || "VU DUC LONG",
      transferPrefix: requiredText(body.bankTransferPrefix, 40) || "LONGOI"
    };
    const openingHours = {
      open: timeText(body.openTime, "10:00"),
      close: timeText(body.closeTime, "23:00")
    };
    if (!shopName) return send(res, 400, { error: "Tên shop chưa hợp lệ." });
    store.shopName = shopName;
    store.bankQr = bankQr;
    store.bank = bank;
    store.openingHours = openingHours;
    await saveStore(store);
    return send(res, 200, adminSummary(store));
  }

  if (req.method === "POST" && req.url === "/api/admin/products") {
    store = await getStore();
    const body = await readBody(req);
    const name = requiredText(body.name, 100);
    const price = Number(body.price);
    const description = String(body.description || "").trim().slice(0, 500);
    const image = String(body.image || "").trim().slice(0, MAX_IMAGE_LENGTH);
    if (!name || !Number.isFinite(price) || price < 0) {
      return send(res, 400, { error: "Thông tin sản phẩm chưa hợp lệ." });
    }
    store.products.push({ id: crypto.randomUUID(), name, price, description, image, isActive: true });
    await saveStore(store);
    return send(res, 201, adminSummary(store));
  }

  if (req.method === "PUT" && req.url.startsWith("/api/admin/products/")) {
    store = await getStore();
    const id = decodeURIComponent(req.url.split("/").pop());
    const product = store.products.find(item => item.id === id);
    if (!product) return send(res, 404, { error: "Không tìm thấy sản phẩm." });

    const body = await readBody(req);
    const name = requiredText(body.name, 100);
    const price = Number(body.price);
    const description = String(body.description || "").trim().slice(0, 500);
    const image = String(body.image || "").trim().slice(0, MAX_IMAGE_LENGTH);
    if (!name || !Number.isFinite(price) || price < 0) {
      return send(res, 400, { error: "Thông tin sản phẩm chưa hợp lệ." });
    }

    product.name = name;
    product.price = price;
    product.description = description;
    product.image = image;
    await saveStore(store);
    return send(res, 200, adminSummary(store));
  }

  if (req.method === "PATCH" && req.url.startsWith("/api/admin/products/") && req.url.endsWith("/status")) {
    const parts = req.url.split("/");
    const id = decodeURIComponent(parts[parts.length - 2] || "");
    const body = await readBody(req);
    const summary = await runStoreMutation(currentStore => {
      const product = currentStore.products.find(item => item.id === id);
      if (!product) {
        const error = new Error("Khong tim thay san pham.");
        error.status = 404;
        throw error;
      }
      product.isActive = body.isActive !== false;
      return adminSummary(currentStore);
    });
    return send(res, 200, summary);
  }

  if (req.method === "PATCH" && req.url.startsWith("/api/admin/products/")) {
    store = await getStore();
    const parts = req.url.split("/");
    const id = decodeURIComponent(parts[parts.length - 2] || "");
    const action = parts[parts.length - 1];
    if (action !== "status") return send(res, 404, { error: "Không tìm thấy API." });

    const body = await readBody(req);
    const product = store.products.find(item => item.id === id);
    if (!product) return send(res, 404, { error: "Không tìm thấy sản phẩm." });

    product.isActive = body.isActive !== false;
    await saveStore(store);
    return send(res, 200, adminSummary(store));
  }

  if (req.method === "DELETE" && req.url.startsWith("/api/admin/products/")) {
    store = await getStore();
    const id = decodeURIComponent(req.url.split("/").pop());
    store.products = store.products.filter(product => product.id !== id);
    await saveStore(store);
    return send(res, 200, adminSummary(store));
  }

  if (req.method === "DELETE" && req.url === "/api/admin/orders") {
    store = await getStore();
    store.orders = [];
    await saveStore(store);
    await notifyAdminOrders();
    return send(res, 200, adminSummary(store));
  }

  return send(res, 404, { error: "Không tìm thấy API." });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res).catch(error => {
      send(res, error.status || 500, { error: error.message || "Server error" });
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  ensureStore();
  console.log(`Order web is running on http://localhost:${PORT}`);
  console.log(`Serving static files from ${PUBLIC_DIR}`);
});
