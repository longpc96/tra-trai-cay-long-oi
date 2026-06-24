import json
import mimetypes
import os
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA_DIR = ROOT / "data"
DATA_FILE = DATA_DIR / "store.json"
PORT = int(os.environ.get("PORT", "3000"))
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "1234")
SESSIONS = set()


def ensure_store():
    DATA_DIR.mkdir(exist_ok=True)
    if not DATA_FILE.exists():
        write_store(
            {
                "shopName": "Shop Order",
                "products": [
                    {
                        "id": str(uuid.uuid4()),
                        "name": "San pham mau",
                        "price": 99000,
                        "description": "Ban co the doi thanh san pham that trong trang quan tri.",
                        "image": "",
                        "isActive": True,
                    }
                ],
                "orders": [],
            }
        )


def read_store():
    ensure_store()
    with DATA_FILE.open("r", encoding="utf-8") as file:
        store = json.load(file)
    store["products"] = [
        {**product, "isActive": product.get("isActive") is not False}
        for product in store.get("products", [])
    ]
    store["orders"] = store.get("orders", [])
    return store


def write_store(store):
    DATA_DIR.mkdir(exist_ok=True)
    with DATA_FILE.open("w", encoding="utf-8") as file:
        json.dump(store, file, ensure_ascii=False, indent=2)


def public_shop(store):
    return {
        "shopName": store.get("shopName", "Shop Order"),
        "products": [product for product in store["products"] if product.get("isActive") is not False],
    }


def admin_summary(store):
    total_revenue = sum(order.get("total", 0) for order in store["orders"])
    total_sold = 0
    for order in store["orders"]:
        if isinstance(order.get("items"), list):
            total_sold += sum(item.get("quantity", 0) for item in order["items"])
        else:
            total_sold += order.get("quantity", 0)
    return {
        "shopName": store.get("shopName", "Shop Order"),
        "products": store["products"],
        "orders": store["orders"],
        "summary": {
            "totalRevenue": total_revenue,
            "totalOrders": len(store["orders"]),
            "totalSold": total_sold,
        },
    }


def required_text(value, max_length):
    text = str(value or "").strip()
    if not text or len(text) > max_length:
        return None
    return text


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 3_000_000:
            raise ValueError("Body too large")
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def is_admin(self):
        header = self.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        return token in SESSIONS

    def do_GET(self):
        if self.path == "/api/shop":
            return self.send_json(200, public_shop(read_store()))
        if self.path == "/api/admin/dashboard":
            if not self.is_admin():
                return self.send_json(401, {"error": "Ban can dang nhap quan tri."})
            return self.send_json(200, admin_summary(read_store()))
        return self.serve_static()

    def do_POST(self):
        if self.path == "/api/admin/login":
            body = self.read_json()
            if str(body.get("password", "")) != ADMIN_PASSWORD:
                return self.send_json(401, {"error": "Sai mat khau."})
            token = uuid.uuid4().hex + uuid.uuid4().hex
            SESSIONS.add(token)
            return self.send_json(200, {"token": token})

        if self.path == "/api/orders":
            store = read_store()
            body = self.read_json()
            requested = body.get("items")
            if not isinstance(requested, list):
                requested = [{"productId": body.get("productId"), "quantity": body.get("quantity")}]
            name = required_text(body.get("name"), 80)
            phone = required_text(body.get("phone"), 40)
            address = required_text(body.get("address"), 300)
            note = str(body.get("note") or "").strip()[:300]
            items = []
            for requested_item in requested:
                product = next((item for item in store["products"] if item["id"] == requested_item.get("productId")), None)
                quantity = int(requested_item.get("quantity") or 0)
                if not product or product.get("isActive") is False or quantity < 1:
                    return self.send_json(400, {"error": "Thong tin don hang chua hop le."})
                items.append(
                    {
                        "productId": product["id"],
                        "productName": product["name"],
                        "price": product["price"],
                        "quantity": quantity,
                        "total": product["price"] * quantity,
                    }
                )
            if not items or not name or not phone or not address:
                return self.send_json(400, {"error": "Thong tin don hang chua hop le."})
            order = {
                "id": str(uuid.uuid4()),
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "items": items,
                "productName": ", ".join(f"{item['productName']} x{item['quantity']}" for item in items),
                "quantity": sum(item["quantity"] for item in items),
                "total": sum(item["total"] for item in items),
                "name": name,
                "phone": phone,
                "address": address,
                "note": note,
            }
            store["orders"].append(order)
            write_store(store)
            return self.send_json(201, {"ok": True, "orderId": order["id"]})

        if self.path == "/api/admin/products":
            if not self.is_admin():
                return self.send_json(401, {"error": "Ban can dang nhap quan tri."})
            store = read_store()
            body = self.read_json()
            name = required_text(body.get("name"), 100)
            price = float(body.get("price") or 0)
            if not name or price < 0:
                return self.send_json(400, {"error": "Thong tin san pham chua hop le."})
            store["products"].append(
                {
                    "id": str(uuid.uuid4()),
                    "name": name,
                    "price": price,
                    "description": str(body.get("description") or "").strip()[:500],
                    "image": str(body.get("image") or "").strip()[:2_200_000],
                    "isActive": True,
                }
            )
            write_store(store)
            return self.send_json(201, admin_summary(store))

        return self.send_json(404, {"error": "Not found"})

    def do_PUT(self):
        if self.path == "/api/admin/shop":
            if not self.is_admin():
                return self.send_json(401, {"error": "Ban can dang nhap quan tri."})
            store = read_store()
            body = self.read_json()
            shop_name = required_text(body.get("shopName"), 80)
            if not shop_name:
                return self.send_json(400, {"error": "Ten shop chua hop le."})
            store["shopName"] = shop_name
            write_store(store)
            return self.send_json(200, admin_summary(store))
        return self.send_json(404, {"error": "Not found"})

    def do_PATCH(self):
        if not self.path.startswith("/api/admin/products/") or not self.path.endswith("/status"):
            return self.send_json(404, {"error": "Not found"})
        if not self.is_admin():
            return self.send_json(401, {"error": "Ban can dang nhap quan tri."})
        store = read_store()
        parts = self.path.split("/")
        product_id = unquote(parts[-2])
        product = next((item for item in store["products"] if item["id"] == product_id), None)
        if not product:
            return self.send_json(404, {"error": "Khong tim thay san pham."})
        body = self.read_json()
        product["isActive"] = body.get("isActive") is not False
        write_store(store)
        return self.send_json(200, admin_summary(store))

    def do_DELETE(self):
        if self.path == "/api/admin/orders":
            if not self.is_admin():
                return self.send_json(401, {"error": "Ban can dang nhap quan tri."})
            store = read_store()
            store["orders"] = []
            write_store(store)
            return self.send_json(200, admin_summary(store))

        if self.path.startswith("/api/admin/products/"):
            if not self.is_admin():
                return self.send_json(401, {"error": "Ban can dang nhap quan tri."})
            store = read_store()
            product_id = unquote(self.path.split("/")[-1])
            store["products"] = [product for product in store["products"] if product["id"] != product_id]
            write_store(store)
            return self.send_json(200, admin_summary(store))

        return self.send_json(404, {"error": "Not found"})

    def serve_static(self):
        route = "/index.html" if self.path == "/" else self.path.split("?")[0]
        target = (PUBLIC / unquote(route.lstrip("/"))).resolve()
        if not str(target).startswith(str(PUBLIC.resolve())) or not target.exists():
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    ensure_store()
    print(f"Test server running on http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
