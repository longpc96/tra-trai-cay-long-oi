let adminToken = sessionStorage.getItem("adminToken") || "";
let publicData = { shopName: "Trà Trái Cây Long Ơi", products: [], bankQr: "" };
let cart = [];
let dashboardRefreshTimer = null;
let dashboardEventSource = null;
const MAX_IMAGE_SIZE = 1.5 * 1024 * 1024;
const DASHBOARD_REFRESH_MS = 5000;

const money = value => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(value || 0);

function showMessage(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle("error", isError);
  element.classList.add("show");
}

function hideMessage(element) {
  element.classList.remove("show", "error");
  element.textContent = "";
}

async function request(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Có lỗi xảy ra.");
  return data;
}

function createText(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve("");
    if (!file.type.startsWith("image/")) return reject(new Error("File được chọn không phải ảnh."));
    if (file.size > MAX_IMAGE_SIZE) return reject(new Error("Ảnh quá lớn. Vui lòng chọn ảnh dưới 1.5MB."));

    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Không đọc được ảnh."));
    reader.readAsDataURL(file);
  });
}

function renderImagePreview(dataUrl, selector = "#imagePreview") {
  const preview = document.querySelector(selector);
  preview.innerHTML = "";
  preview.classList.toggle("hidden", !dataUrl);
  if (!dataUrl) return;

  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = "Ảnh sản phẩm";
  preview.appendChild(img);
}

function setShopName(name) {
  const shopName = name || "Trà Trái Cây Long Ơi";
  document.querySelector("#shopName").textContent = shopName;
  document.querySelector("#customerShopName").textContent = shopName;
  document.querySelector("#shopNameInput").value = shopName;
}

function renderBankQr() {
  const selected = document.querySelector('input[name="paymentMethod"]:checked')?.value || "cash";
  const box = document.querySelector("#bankQrBox");
  box.innerHTML = "";
  box.classList.toggle("hidden", selected !== "bank");
  if (selected !== "bank") return;

  if (!publicData.bankQr) {
    box.appendChild(createText("div", "Chủ shop chưa thêm QR ngân hàng.", "empty"));
    return;
  }

  const img = document.createElement("img");
  img.src = publicData.bankQr;
  img.alt = "QR ngân hàng";
  box.appendChild(img);
  box.appendChild(createText("strong", "Quét QR để chuyển khoản"));
}

function switchView(viewName) {
  document.querySelectorAll(".tab").forEach(item => {
    item.classList.toggle("active", item.dataset.view === viewName);
  });
  document.querySelectorAll(".view").forEach(view => view.classList.remove("active"));
  document.querySelector(`#${viewName}`).classList.add("active");
}

function filteredProducts() {
  const keyword = document.querySelector("#productSearch").value.trim().toLowerCase();
  if (!keyword) return publicData.products;
  return publicData.products.filter(product => product.name.toLowerCase().includes(keyword));
}

function renderProducts() {
  const products = filteredProducts();
  const productList = document.querySelector("#products");
  productList.innerHTML = "";
  document.querySelector("#publicProductCount").textContent = publicData.products.length;

  if (!products.length) {
    productList.appendChild(createText("div", "Hiện chưa có sản phẩm đang mở bán.", "empty"));
    return;
  }

  products.forEach(product => {
    const card = document.createElement("article");
    card.className = "product-card";

    const image = document.createElement("div");
    image.className = "product-image";
    if (product.image) {
      const img = document.createElement("img");
      img.src = product.image;
      img.alt = product.name;
      image.appendChild(img);
    } else {
      image.textContent = "O";
    }

    const body = document.createElement("div");
    body.className = "product-body";
    body.appendChild(createText("h3", product.name));
    body.appendChild(createText("div", money(product.price), "price"));
    body.appendChild(createText("div", product.description || "Liên hệ shop để biết thêm chi tiết.", "description"));

    const button = document.createElement("button");
    button.className = "btn add";
    button.type = "button";
    button.textContent = "Thêm vào giỏ";
    button.addEventListener("click", () => addToCart(product.id));
    body.appendChild(button);

    card.append(image, body);
    productList.appendChild(card);
  });
}

function addToCart(productId) {
  const product = publicData.products.find(item => item.id === productId);
  if (!product) return;
  const existing = cart.find(item => item.productId === productId);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({ productId, quantity: 1 });
  }
  renderCart();
}

function updateCartQuantity(productId, delta) {
  const item = cart.find(entry => entry.productId === productId);
  if (!item) return;
  item.quantity += delta;
  cart = cart.filter(entry => entry.quantity > 0);
  renderCart();
}

function cartDetails() {
  return cart
    .map(item => {
      const product = publicData.products.find(entry => entry.id === item.productId);
      if (!product) return null;
      return { ...item, product, total: product.price * item.quantity };
    })
    .filter(Boolean);
}

function renderCart() {
  const items = cartDetails();
  const cartBox = document.querySelector("#cartItems");
  cartBox.innerHTML = "";

  if (!items.length) {
    cartBox.appendChild(createText("div", "Giỏ hàng đang trống.", "empty"));
  } else {
    const header = document.createElement("div");
    header.className = "cart-item header";
    header.append(createText("span", "Sản phẩm"), createText("span", "Số lượng"), createText("span", "Thành tiền"));
    cartBox.appendChild(header);

    items.forEach(item => {
      const row = document.createElement("div");
      row.className = "cart-item";

      const name = createText("strong", item.product.name);
      const total = createText("span", money(item.total));

      const qty = document.createElement("div");
      qty.className = "qty-control";
      const minus = document.createElement("button");
      minus.type = "button";
      minus.textContent = "-";
      minus.addEventListener("click", () => updateCartQuantity(item.productId, -1));
      const count = createText("strong", item.quantity);
      const plus = document.createElement("button");
      plus.type = "button";
      plus.textContent = "+";
      plus.addEventListener("click", () => updateCartQuantity(item.productId, 1));
      qty.append(minus, count, plus);

      row.append(name, qty, total);
      cartBox.appendChild(row);
    });
  }

  const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const total = items.reduce((sum, item) => sum + item.total, 0);
  document.querySelector("#cartCount").textContent = quantity;
  document.querySelector("#cartTotal").textContent = money(total);
  renderBankQr();
}

function orderItemsText(order) {
  if (Array.isArray(order.items) && order.items.length) {
    return order.items.map(item => `${item.productName} x${item.quantity}`).join("\n");
  }
  return order.productName || "";
}

function orderQuantity(order) {
  if (Array.isArray(order.items) && order.items.length) {
    return order.items.reduce((sum, item) => sum + item.quantity, 0);
  }
  return order.quantity || 0;
}

async function updateOrderStatus(id, action) {
  const data = await request(`/api/admin/orders/${encodeURIComponent(id)}/${action}`, { method: "PATCH" });
  renderDashboard(data);
}

async function deleteCompletedOrder(id) {
  if (!confirm("X\u00f3a \u0111\u01a1n n\u00e0y kh\u1ecfi doanh thu?")) return;
  const data = await request(`/api/admin/orders/${encodeURIComponent(id)}`, { method: "DELETE" });
  renderDashboard(data);
}

function renderOrderDashboard(data) {
  document.querySelector("#totalRevenue").textContent = money(data.summary.totalRevenue);
  document.querySelector("#totalOrders").textContent = data.summary.totalOrders;
  document.querySelector("#totalSold").textContent = data.summary.totalSold;

  const dailyRevenue = document.querySelector("#dailyRevenue");
  if (dailyRevenue) {
    dailyRevenue.innerHTML = "";
    const days = data.summary.revenueByDate || [];
    if (!days.length) {
      const tr = document.createElement("tr");
      const td = createText("td", "Ch\u01b0a c\u00f3 doanh thu.", "empty");
      td.colSpan = 4;
      tr.appendChild(td);
      dailyRevenue.appendChild(tr);
    } else {
      days.forEach(day => {
        const tr = document.createElement("tr");
        [day.date, money(day.totalRevenue), day.totalOrders, day.totalSold].forEach(value => {
          const td = document.createElement("td");
          td.textContent = value;
          tr.appendChild(td);
        });
        dailyRevenue.appendChild(tr);
      });
    }
  }

  const pendingOrders = data.orders.filter(order => (order.status || "pending") === "pending");
  const completedOrders = data.orders.filter(order => order.status === "completed");

  const pending = document.querySelector("#pendingOrders");
  pending.innerHTML = "";
  if (!pendingOrders.length) {
    const tr = document.createElement("tr");
    const td = createText("td", "Ch\u01b0a c\u00f3 \u0111\u01a1n m\u1edbi.", "empty");
    td.colSpan = 7;
    tr.appendChild(td);
    pending.appendChild(tr);
  } else {
    pendingOrders.slice().reverse().forEach(order => {
      const tr = document.createElement("tr");
      const createdAt = new Date(order.createdAt).toLocaleString("vi-VN");
      [
        createdAt,
        `${order.name}\n${order.phone}`,
        orderItemsText(order),
        orderQuantity(order),
        money(order.total),
        order.address
      ].forEach(value => {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      });
      const actionTd = document.createElement("td");
      const actions = document.createElement("div");
      actions.className = "order-actions";
      const done = createText("button", "Ho\u00e0n th\u00e0nh", "btn small");
      done.type = "button";
      done.addEventListener("click", () => updateOrderStatus(order.id, "complete"));
      const cancel = createText("button", "H\u1ee7y", "btn danger small");
      cancel.type = "button";
      cancel.addEventListener("click", () => updateOrderStatus(order.id, "cancel"));
      actions.append(done, cancel);
      actionTd.appendChild(actions);
      tr.appendChild(actionTd);
      pending.appendChild(tr);
    });
  }

  const orders = document.querySelector("#orders");
  orders.innerHTML = "";
  if (!completedOrders.length) {
    const tr = document.createElement("tr");
    const td = createText("td", "Ch\u01b0a c\u00f3 \u0111\u01a1n h\u00e0ng.", "empty");
    td.colSpan = 7;
    tr.appendChild(td);
    orders.appendChild(tr);
  } else {
    completedOrders.slice().reverse().forEach(order => {
      const tr = document.createElement("tr");
      const createdAt = new Date(order.createdAt).toLocaleString("vi-VN");
      [
        createdAt,
        `${order.name}\n${order.phone}`,
        orderItemsText(order),
        orderQuantity(order),
        money(order.total),
        order.address,
        order.note || ""
      ].forEach(value => {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      });
      const actionTd = document.createElement("td");
      const remove = createText("button", "X\u00f3a doanh thu", "btn danger small");
      remove.type = "button";
      remove.addEventListener("click", () => deleteCompletedOrder(order.id));
      actionTd.appendChild(remove);
      tr.appendChild(actionTd);
      orders.appendChild(tr);
    });
  }
}

async function refreshOrdersQuietly() {
  if (!adminToken || document.hidden) return;
  try {
    const data = await request("/api/admin/orders/live");
    renderOrderDashboard(data);
  } catch (error) {
    stopDashboardAutoRefresh();
  }
}

function startDashboardAutoRefresh() {
  if (dashboardEventSource || dashboardRefreshTimer) return;
  if ("EventSource" in window) {
    dashboardEventSource = new EventSource(`/api/admin/orders/events?token=${encodeURIComponent(adminToken)}`);
    dashboardEventSource.addEventListener("orders", event => {
      renderOrderDashboard(JSON.parse(event.data));
    });
    dashboardEventSource.onerror = () => {
      if (dashboardEventSource) {
        dashboardEventSource.close();
        dashboardEventSource = null;
      }
      if (!adminToken) return;
      if (!dashboardRefreshTimer) {
        refreshOrdersQuietly();
        dashboardRefreshTimer = setInterval(refreshOrdersQuietly, DASHBOARD_REFRESH_MS);
      }
    };
    return;
  }
  dashboardRefreshTimer = setInterval(refreshOrdersQuietly, DASHBOARD_REFRESH_MS);
}

function stopDashboardAutoRefresh() {
  if (dashboardEventSource) {
    dashboardEventSource.close();
    dashboardEventSource = null;
  }
  if (dashboardRefreshTimer) {
    clearInterval(dashboardRefreshTimer);
    dashboardRefreshTimer = null;
  }
}

function renderDashboard(data) {
  setShopName(data.shopName);
  publicData = { shopName: data.shopName, bankQr: data.bankQr || "", products: data.products.filter(product => product.isActive !== false) };
  document.querySelector("#bankQrInput").value = data.bankQr || "";
  renderImagePreview(data.bankQr || "", "#bankQrPreview");
  renderProducts();
  renderCart();

  document.querySelector("#totalRevenue").textContent = money(data.summary.totalRevenue);
  document.querySelector("#totalOrders").textContent = data.summary.totalOrders;
  document.querySelector("#totalSold").textContent = data.summary.totalSold;

  const adminProducts = document.querySelector("#adminProducts");
  adminProducts.innerHTML = "";
  if (!data.products.length) {
    adminProducts.appendChild(createText("div", "Chưa có sản phẩm.", "empty"));
  } else {
    data.products.forEach(product => {
      const row = document.createElement("div");
      row.className = "admin-product";
      const info = document.createElement("div");
      info.appendChild(createText("strong", product.name));
      info.appendChild(createText("div", money(product.price), "price"));
      info.appendChild(createText("div", product.isActive === false ? "Đang đóng bán" : "Đang mở bán", product.isActive === false ? "status closed" : "status open"));

      const controls = document.createElement("div");
      controls.className = "admin-product-actions";

      const statusButton = document.createElement("button");
      statusButton.className = product.isActive === false ? "btn" : "btn secondary";
      statusButton.type = "button";
      statusButton.textContent = product.isActive === false ? "Mở bán lại" : "Đóng bán";
      statusButton.addEventListener("click", () => toggleProductStatus(product.id, product.isActive === false));

      const button = document.createElement("button");
      button.className = "btn danger";
      button.type = "button";
      button.textContent = "Xóa";
      button.addEventListener("click", () => deleteProduct(product.id));

      controls.append(statusButton, button);
      row.append(info, controls);
      adminProducts.appendChild(row);
    });
  }

  renderOrderDashboard(data);
  return;

  const pendingOrders = data.orders.filter(order => (order.status || "pending") === "pending");
  const completedOrders = data.orders.filter(order => order.status === "completed");

  const pending = document.querySelector("#pendingOrders");
  pending.innerHTML = "";
  if (!pendingOrders.length) {
    const tr = document.createElement("tr");
    const td = createText("td", "Chưa có đơn mới.", "empty");
    td.colSpan = 7;
    tr.appendChild(td);
    pending.appendChild(tr);
  } else {
    pendingOrders.slice().reverse().forEach(order => {
      const tr = document.createElement("tr");
      const createdAt = new Date(order.createdAt).toLocaleString("vi-VN");
      [
        createdAt,
        `${order.name}\n${order.phone}`,
        orderItemsText(order),
        orderQuantity(order),
        money(order.total),
        order.address
      ].forEach(value => {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      });
      const actionTd = document.createElement("td");
      const actions = document.createElement("div");
      actions.className = "order-actions";
      const done = createText("button", "Hoàn thành", "btn small");
      done.type = "button";
      done.addEventListener("click", () => updateOrderStatus(order.id, "complete"));
      const cancel = createText("button", "Hủy", "btn danger small");
      cancel.type = "button";
      cancel.addEventListener("click", () => updateOrderStatus(order.id, "cancel"));
      actions.append(done, cancel);
      actionTd.appendChild(actions);
      tr.appendChild(actionTd);
      pending.appendChild(tr);
    });
  }

  const orders = document.querySelector("#orders");
  orders.innerHTML = "";
  if (!completedOrders.length) {
    const tr = document.createElement("tr");
    const td = createText("td", "Chưa có đơn hàng.", "empty");
    td.colSpan = 7;
    tr.appendChild(td);
    orders.appendChild(tr);
  } else {
    completedOrders.slice().reverse().forEach(order => {
      const tr = document.createElement("tr");
      const createdAt = new Date(order.createdAt).toLocaleString("vi-VN");
      [
        createdAt,
        `${order.name}\n${order.phone}`,
        orderItemsText(order),
        orderQuantity(order),
        money(order.total),
        order.address,
        order.note || ""
      ].forEach(value => {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      });
      orders.appendChild(tr);
    });
  }
}

async function loadPublicShop() {
  publicData = await request("/api/shop");
  setShopName(publicData.shopName);
  publicData.bankQr = publicData.bankQr || "";
  renderProducts();
  renderCart();
}

async function loadDashboard() {
  const data = await request("/api/admin/dashboard");
  renderDashboard(data);
}

async function deleteProduct(id) {
  if (!confirm("Xóa sản phẩm này?")) return;
  const data = await request(`/api/admin/products/${encodeURIComponent(id)}`, { method: "DELETE" });
  cart = cart.filter(item => item.productId !== id);
  renderDashboard(data);
}

async function toggleProductStatus(id, shouldOpen) {
  const data = await request(`/api/admin/products/${encodeURIComponent(id)}/status`, {
    method: "PATCH",
    body: JSON.stringify({ isActive: shouldOpen })
  });
  if (!shouldOpen) cart = cart.filter(item => item.productId !== id);
  renderDashboard(data);
}

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    switchView(tab.dataset.view);
  });
});

document.querySelector("#customerEntry").addEventListener("click", () => switchView("customer"));
document.querySelector("#adminEntry").addEventListener("click", () => switchView("admin"));

document.querySelector("#productSearch").addEventListener("input", renderProducts);
document.querySelectorAll('input[name="paymentMethod"]').forEach(input => {
  input.addEventListener("change", renderBankQr);
});

document.querySelector("#orderForm").addEventListener("submit", async event => {
  event.preventDefault();
  const message = document.querySelector("#orderMessage");
  hideMessage(message);
  const items = cartDetails();
  if (!items.length) {
    showMessage(message, "Vui lòng thêm sản phẩm vào giỏ hàng.", true);
    return;
  }

  try {
    await request("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        items: items.map(item => ({ productId: item.productId, quantity: item.quantity })),
        paymentMethod: document.querySelector('input[name="paymentMethod"]:checked')?.value || "cash",
        name: document.querySelector("#orderName").value,
        phone: document.querySelector("#orderPhone").value,
        address: document.querySelector("#orderAddress").value,
        note: document.querySelector("#orderNote").value
      })
    });
    cart = [];
    event.target.reset();
    renderCart();
    showMessage(message, "Đã gửi đơn hàng. Chủ shop sẽ xác nhận sớm.");
    alert("Đã gửi đơn hàng. Cảm ơn bạn!");
    if (adminToken) loadDashboard();
  } catch (error) {
    showMessage(message, error.message, true);
  }
});

document.querySelector("#loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const message = document.querySelector("#loginMessage");
  hideMessage(message);
  try {
    const data = await request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        username: document.querySelector("#adminUsername").value,
        password: document.querySelector("#adminPassword").value
      })
    });
    adminToken = data.token;
    sessionStorage.setItem("adminToken", adminToken);
    document.querySelector("#loginPanel").classList.add("hidden");
    document.querySelector("#adminPanel").classList.remove("hidden");
    await loadDashboard();
    startDashboardAutoRefresh();
  } catch (error) {
    showMessage(message, error.message, true);
  }
});

document.querySelector("#shopForm").addEventListener("submit", async event => {
  event.preventDefault();
  const uploadedQr = await readImageFile(document.querySelector("#bankQrFile").files[0]);
  const data = await request("/api/admin/shop", {
    method: "PUT",
    body: JSON.stringify({
      shopName: document.querySelector("#shopNameInput").value,
      bankQr: uploadedQr || document.querySelector("#bankQrInput").value
    })
  });
  document.querySelector("#bankQrFile").value = "";
  renderDashboard(data);
});

document.querySelector("#bankQrFile").addEventListener("change", async event => {
  try {
    renderImagePreview(await readImageFile(event.target.files[0]), "#bankQrPreview");
  } catch (error) {
    event.target.value = "";
    renderImagePreview("", "#bankQrPreview");
    alert(error.message);
  }
});

document.querySelector("#productImageFile").addEventListener("change", async event => {
  try {
    renderImagePreview(await readImageFile(event.target.files[0]));
  } catch (error) {
    event.target.value = "";
    renderImagePreview("");
    alert(error.message);
  }
});

document.querySelector("#productForm").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const imageFile = document.querySelector("#productImageFile").files[0];
    const uploadedImage = await readImageFile(imageFile);
    const data = await request("/api/admin/products", {
      method: "POST",
      body: JSON.stringify({
        name: document.querySelector("#productName").value,
        price: Number(document.querySelector("#productPrice").value),
        description: document.querySelector("#productDescription").value,
        image: uploadedImage || document.querySelector("#productImage").value
      })
    });
    event.target.reset();
    renderImagePreview("");
    renderDashboard(data);
  } catch (error) {
    alert(error.message);
  }
});

document.querySelector("#clearOrders").addEventListener("click", async () => {
  if (!confirm("Xóa toàn bộ đơn hàng?")) return;
  const data = await request("/api/admin/orders", { method: "DELETE" });
  renderDashboard(data);
});

document.querySelector("#logout").addEventListener("click", () => {
  adminToken = "";
  sessionStorage.removeItem("adminToken");
  stopDashboardAutoRefresh();
  document.querySelector("#loginPanel").classList.remove("hidden");
  document.querySelector("#adminPanel").classList.add("hidden");
});

loadPublicShop();
if (adminToken) {
  document.querySelector("#loginPanel").classList.add("hidden");
  document.querySelector("#adminPanel").classList.remove("hidden");
  loadDashboard().catch(() => {
    adminToken = "";
    sessionStorage.removeItem("adminToken");
    stopDashboardAutoRefresh();
    document.querySelector("#loginPanel").classList.remove("hidden");
    document.querySelector("#adminPanel").classList.add("hidden");
  });
  startDashboardAutoRefresh();
}
