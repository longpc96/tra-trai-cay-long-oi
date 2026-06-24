const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_SIZE = 3_000_000;
const MAX_IMAGE_LENGTH = 2_200_000;
const sessions = new Set();

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    writeStore({
      shopName: "Trà Trái Cây Long Ơi",
      bankQr: "",
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

function publicShop(store) {
  return {
    shopName: store.shopName,
    bankQr: store.bankQr || "",
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
  return {
    shopName: store.shopName,
    bankQr: store.bankQr || "",
    products: store.products,
    orders: store.orders,
    summary: {
      totalRevenue,
      totalOrders: completedOrders.length,
      totalSold
    }
  };
}

function serveStatic(req, res) {
  const safePath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden", "text/plain; charset=utf-8");

  fs.readFile(filePath, (error, data) => {
    if (error) return send(res, 404, "Not found", "text/plain; charset=utf-8");
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
  const store = readStore();

  if (req.method === "GET" && req.url === "/api/shop") {
    return send(res, 200, publicShop(store));
  }

  if (req.method === "POST" && req.url === "/api/orders") {
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
    writeStore(store);
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

  if (req.url.startsWith("/api/admin") && !isAdmin(req)) {
    return send(res, 401, { error: "Bạn cần đăng nhập quản trị." });
  }

  if (req.method === "GET" && req.url === "/api/admin/dashboard") {
    return send(res, 200, adminSummary(store));
  }

  if (req.method === "PATCH" && req.url.startsWith("/api/admin/orders/")) {
    const parts = req.url.split("/");
    const id = decodeURIComponent(parts[parts.length - 2] || "");
    const action = parts[parts.length - 1];
    if (!["complete", "cancel"].includes(action)) return send(res, 404, { error: "Không tìm thấy API." });

    const order = store.orders.find(item => item.id === id);
    if (!order) return send(res, 404, { error: "Không tìm thấy đơn hàng." });
    order.status = action === "complete" ? "completed" : "cancelled";
    writeStore(store);
    return send(res, 200, adminSummary(store));
  }

  if (req.method === "PUT" && req.url === "/api/admin/shop") {
    const body = await readBody(req);
    const shopName = requiredText(body.shopName, 80);
    const bankQr = String(body.bankQr || "").trim().slice(0, MAX_IMAGE_LENGTH);
    if (!shopName) return send(res, 400, { error: "Tên shop chưa hợp lệ." });
    store.shopName = shopName;
    store.bankQr = bankQr;
    writeStore(store);
    return send(res, 200, adminSummary(store));
  }

  if (req.method === "POST" && req.url === "/api/admin/products") {
    const body = await readBody(req);
    const name = requiredText(body.name, 100);
    const price = Number(body.price);
    const description = String(body.description || "").trim().slice(0, 500);
    const image = String(body.image || "").trim().slice(0, MAX_IMAGE_LENGTH);
    if (!name || !Number.isFinite(price) || price < 0) {
      return send(res, 400, { error: "Thông tin sản phẩm chưa hợp lệ." });
    }
    store.products.push({ id: crypto.randomUUID(), name, price, description, image, isActive: true });
    writeStore(store);
    return send(res, 201, adminSummary(store));
  }

  if (req.method === "PATCH" && req.url.startsWith("/api/admin/products/")) {
    const parts = req.url.split("/");
    const id = decodeURIComponent(parts[parts.length - 2] || "");
    const action = parts[parts.length - 1];
    if (action !== "status") return send(res, 404, { error: "Không tìm thấy API." });

    const body = await readBody(req);
    const product = store.products.find(item => item.id === id);
    if (!product) return send(res, 404, { error: "Không tìm thấy sản phẩm." });

    product.isActive = body.isActive !== false;
    writeStore(store);
    return send(res, 200, adminSummary(store));
  }

  if (req.method === "DELETE" && req.url.startsWith("/api/admin/products/")) {
    const id = decodeURIComponent(req.url.split("/").pop());
    store.products = store.products.filter(product => product.id !== id);
    writeStore(store);
    return send(res, 200, adminSummary(store));
  }

  if (req.method === "DELETE" && req.url === "/api/admin/orders") {
    store.orders = [];
    writeStore(store);
    return send(res, 200, adminSummary(store));
  }

  return send(res, 404, { error: "Không tìm thấy API." });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res).catch(error => {
      send(res, 500, { error: error.message || "Server error" });
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  ensureStore();
  console.log(`Order web is running on http://localhost:${PORT}`);
});
