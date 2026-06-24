# Web Order Online

Đây là bản web order có server riêng. Khách có thể đặt hàng qua internet, còn phần quản trị cần mật khẩu để xem doanh thu, đơn hàng và thêm/xóa sản phẩm.

Giao diện khách được làm theo kiểu trang order: banner shop, danh mục, tìm kiếm sản phẩm, danh sách sản phẩm và giỏ hàng. Không có logo hoặc thương hiệu PosApp.

## Chạy thử trên máy

```powershell
cd outputs/order-web-online
npm start
```

Sau đó mở:

```text
http://localhost:3000
```

Tài khoản quản trị mặc định là `admin`.

Mật khẩu quản trị mặc định là `1234`.

## Đưa lên mạng bằng Render

1. Tạo tài khoản GitHub.
2. Tạo repository mới và upload toàn bộ thư mục `order-web-online`.
3. Vào Render, chọn `New` -> `Web Service`.
4. Kết nối repository GitHub vừa tạo.
5. Thiết lập:
   - Runtime: `Node`
   - Build Command: để trống hoặc dùng `npm install`
   - Start Command: `npm start`
6. Trong phần Environment, thêm biến:
   - `ADMIN_USERNAME`: tài khoản quản trị của bạn
   - `ADMIN_PASSWORD`: mật khẩu quản trị của bạn
7. Deploy, sau đó Render sẽ cấp cho bạn một đường link public để gửi khách.

## Lưu ý quan trọng

Dữ liệu đang lưu trong file `data/store.json`. Khi dùng hosting miễn phí không có ổ lưu trữ bền vững, dữ liệu có thể mất khi service restart hoặc redeploy. Nếu bán hàng thật, bạn nên dùng một trong các cách sau:

- Render có persistent disk.
- Railway/Render kèm volume hoặc database.
- VPS riêng.
- Nâng cấp app sang database như PostgreSQL/Supabase.

Không gửi mật khẩu quản trị cho khách. Khách chỉ cần dùng tab `Đặt hàng`.

## Đóng/mở sản phẩm

Trong tab `Quản trị`, phần `Sản phẩm đang bán` có nút:

- `Đóng bán`: dùng khi sản phẩm hết hàng. Khách sẽ không thấy và không đặt được sản phẩm đó.
- `Mở bán lại`: dùng khi sản phẩm có hàng trở lại. Sản phẩm sẽ hiện lại ở trang đặt hàng.

## Thêm ảnh sản phẩm

Trong form `Thêm sản phẩm`, bạn có thể:

- Bấm `Chọn ảnh từ máy` để upload ảnh trực tiếp trên web.
- Hoặc dán `Link ảnh` nếu ảnh đã có sẵn trên mạng.

Nếu chọn ảnh từ máy, nên dùng ảnh dưới 1.5MB để web chạy nhẹ và dữ liệu không quá lớn.

## Thêm QR ngân hàng

Vào tab `Quản trị` -> `Thông tin shop`, bạn có thể:

- Bấm `Chọn QR ngân hàng` để upload ảnh QR trực tiếp.
- Hoặc dán link ảnh QR vào ô `Hoặc dán link QR ngân hàng`.

Sau khi bấm `Lưu thông tin shop`, khách chọn `Chuyển khoản` trong phần thanh toán sẽ thấy QR để quét chuyển tiền.

## Xử lý đơn hàng và doanh thu

Khi khách gửi đơn, đơn sẽ nằm trong `Đơn mới cần xử lý`.

- Bấm `Hoàn thành`: đơn được chuyển vào `Đơn đã hoàn thành / Doanh thu` và bắt đầu được tính vào doanh thu.
- Bấm `Hủy`: đơn không được tính vào doanh thu.

Tổng doanh thu chỉ tính các đơn đã hoàn thành.
