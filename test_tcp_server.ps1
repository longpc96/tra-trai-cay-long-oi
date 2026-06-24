$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Public = Join-Path $Root "public"
$DataDir = Join-Path $Root "data"
$DataFile = Join-Path $DataDir "store.json"
$Port = if ($env:PORT) { [int]$env:PORT } else { 3000 }
$AdminPassword = if ($env:ADMIN_PASSWORD) { $env:ADMIN_PASSWORD } else { "1234" }
$Sessions = [System.Collections.Generic.HashSet[string]]::new()

function Write-Store($Store) {
  if (!(Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }
  $Store | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $DataFile -Encoding UTF8
}

function Ensure-Store {
  if (!(Test-Path $DataFile)) {
    Write-Store @{
      shopName = "Shop Order"
      products = @(@{ id = [guid]::NewGuid().ToString(); name = "San pham mau"; price = 99000; description = "San pham mau"; image = ""; isActive = $true })
      orders = @()
    }
  }
}

function Read-Store {
  Ensure-Store
  $store = Get-Content -LiteralPath $DataFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($null -eq $store.products) { $store | Add-Member -Force -NotePropertyName products -NotePropertyValue @() }
  if ($null -eq $store.orders) { $store | Add-Member -Force -NotePropertyName orders -NotePropertyValue @() }
  foreach ($product in @($store.products)) {
    if ($null -eq $product.PSObject.Properties["isActive"]) {
      $product | Add-Member -Force -NotePropertyName isActive -NotePropertyValue $true
    }
  }
  $store
}

function Required-Text($Value, [int]$Max) {
  $text = "$Value".Trim()
  if (!$text -or $text.Length -gt $Max) { return $null }
  $text
}

function Add-Item($ArrayValue, $Item) {
  @(@($ArrayValue) + $Item)
}

function Public-Shop($Store) {
  @{
    shopName = $Store.shopName
    products = @($Store.products | Where-Object { $_.isActive -ne $false })
  }
}

function Admin-Summary($Store) {
  $revenue = 0
  $sold = 0
  foreach ($order in @($Store.orders)) {
    $revenue += [double]$order.total
    if ($order.items) {
      foreach ($item in @($order.items)) { $sold += [int]$item.quantity }
    } else {
      $sold += [int]$order.quantity
    }
  }
  @{
    shopName = $Store.shopName
    products = @($Store.products)
    orders = @($Store.orders)
    summary = @{ totalRevenue = $revenue; totalOrders = @($Store.orders).Count; totalSold = $sold }
  }
}

function Is-Admin($Headers) {
  if (!$Headers.ContainsKey("authorization")) { return $false }
  $auth = $Headers["authorization"]
  if (!$auth.StartsWith("Bearer ")) { return $false }
  $Sessions.Contains($auth.Substring(7))
}

function Response-Bytes([int]$Status, [string]$Type, [byte[]]$Body) {
  $reason = switch ($Status) { 200 { "OK" } 201 { "Created" } 400 { "Bad Request" } 401 { "Unauthorized" } 404 { "Not Found" } default { "Server Error" } }
  $header = "HTTP/1.1 $Status $reason`r`nContent-Type: $Type`r`nContent-Length: $($Body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
  [byte[]]$head = [Text.Encoding]::UTF8.GetBytes($header)
  $all = New-Object byte[] ($head.Length + $Body.Length)
  [Array]::Copy($head, 0, $all, 0, $head.Length)
  [Array]::Copy($Body, 0, $all, $head.Length, $Body.Length)
  $all
}

function Json-Response([int]$Status, $Data) {
  $json = $Data | ConvertTo-Json -Depth 40
  Response-Bytes $Status "application/json; charset=utf-8" ([Text.Encoding]::UTF8.GetBytes($json))
}

function Static-Response($Path) {
  if ($Path -eq "/") { $Path = "/index.html" }
  $relative = [Uri]::UnescapeDataString($Path.TrimStart("/"))
  $target = [IO.Path]::GetFullPath((Join-Path $Public $relative))
  $publicFull = [IO.Path]::GetFullPath($Public)
  if (!$target.StartsWith($publicFull) -or !(Test-Path -LiteralPath $target -PathType Leaf)) {
    return Json-Response 404 @{ error = "Not found" }
  }
  $ext = [IO.Path]::GetExtension($target).ToLowerInvariant()
  $type = switch ($ext) {
    ".html" { "text/html; charset=utf-8" }
    ".css" { "text/css; charset=utf-8" }
    ".js" { "application/javascript; charset=utf-8" }
    ".png" { "image/png" }
    ".jpg" { "image/jpeg" }
    ".jpeg" { "image/jpeg" }
    ".webp" { "image/webp" }
    default { "application/octet-stream" }
  }
  Response-Bytes 200 $type ([IO.File]::ReadAllBytes($target))
}

function Handle-Request($Method, $Path, $Headers, $BodyText) {
  $store = Read-Store
  $body = if ($BodyText) { $BodyText | ConvertFrom-Json } else { @{} }

  if ($Method -eq "GET" -and $Path -eq "/api/shop") { return Json-Response 200 (Public-Shop $store) }

  if ($Method -eq "POST" -and $Path -eq "/api/admin/login") {
    if ("$($body.password)" -ne $AdminPassword) { return Json-Response 401 @{ error = "Sai mat khau." } }
    $token = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
    [void]$Sessions.Add($token)
    return Json-Response 200 @{ token = $token }
  }

  if ($Method -eq "GET" -and $Path -eq "/api/admin/dashboard") {
    if (!(Is-Admin $Headers)) { return Json-Response 401 @{ error = "Ban can dang nhap quan tri." } }
    return Json-Response 200 (Admin-Summary $store)
  }

  if ($Method -eq "POST" -and $Path -eq "/api/orders") {
    $requested = if ($body.items) { @($body.items) } else { @(@{ productId = $body.productId; quantity = $body.quantity }) }
    $name = Required-Text $body.name 80
    $phone = Required-Text $body.phone 40
    $address = Required-Text $body.address 300
    $note = "$($body.note)".Trim()
    if ($note.Length -gt 300) { $note = $note.Substring(0, 300) }
    $items = @()
    foreach ($requestItem in $requested) {
      $product = @($store.products | Where-Object { $_.id -eq $requestItem.productId })[0]
      $qty = [int]$requestItem.quantity
      if (!$product -or $product.isActive -eq $false -or $qty -lt 1) { return Json-Response 400 @{ error = "Thong tin don hang chua hop le." } }
      $items += @{ productId = $product.id; productName = $product.name; price = [double]$product.price; quantity = $qty; total = [double]$product.price * $qty }
    }
    if (!$name -or !$phone -or !$address -or @($items).Count -eq 0) { return Json-Response 400 @{ error = "Thong tin don hang chua hop le." } }
    $total = 0; $qtyTotal = 0
    foreach ($item in $items) { $total += $item.total; $qtyTotal += $item.quantity }
    $order = @{
      id = [guid]::NewGuid().ToString()
      createdAt = [DateTimeOffset]::UtcNow.ToString("o")
      items = @($items)
      productName = (($items | ForEach-Object { "$($_.productName) x$($_.quantity)" }) -join ", ")
      quantity = $qtyTotal
      total = $total
      name = $name
      phone = $phone
      address = $address
      note = $note
    }
    $store.orders = Add-Item $store.orders $order
    Write-Store $store
    return Json-Response 201 @{ ok = $true; orderId = $order.id }
  }

  if ($Path.StartsWith("/api/admin/") -and !(Is-Admin $Headers)) { return Json-Response 401 @{ error = "Ban can dang nhap quan tri." } }

  if ($Method -eq "PUT" -and $Path -eq "/api/admin/shop") {
    $shopName = Required-Text $body.shopName 80
    if (!$shopName) { return Json-Response 400 @{ error = "Ten shop chua hop le." } }
    $store.shopName = $shopName
    Write-Store $store
    return Json-Response 200 (Admin-Summary $store)
  }

  if ($Method -eq "POST" -and $Path -eq "/api/admin/products") {
    $name = Required-Text $body.name 100
    $price = [double]$body.price
    if (!$name -or $price -lt 0) { return Json-Response 400 @{ error = "Thong tin san pham chua hop le." } }
    $image = "$($body.image)".Trim()
    if ($image.Length -gt 2200000) { $image = $image.Substring(0, 2200000) }
    $product = @{ id = [guid]::NewGuid().ToString(); name = $name; price = $price; description = "$($body.description)".Trim(); image = $image; isActive = $true }
    $store.products = Add-Item $store.products $product
    Write-Store $store
    return Json-Response 201 (Admin-Summary $store)
  }

  if ($Method -eq "PATCH" -and $Path -like "/api/admin/products/*/status") {
    $id = [Uri]::UnescapeDataString(($Path -split "/")[-2])
    $product = @($store.products | Where-Object { $_.id -eq $id })[0]
    if (!$product) { return Json-Response 404 @{ error = "Khong tim thay san pham." } }
    $product.isActive = ($body.isActive -ne $false)
    Write-Store $store
    return Json-Response 200 (Admin-Summary $store)
  }

  if ($Method -eq "DELETE" -and $Path -eq "/api/admin/orders") {
    $store.orders = @()
    Write-Store $store
    return Json-Response 200 (Admin-Summary $store)
  }

  if ($Method -eq "DELETE" -and $Path -like "/api/admin/products/*") {
    $id = [Uri]::UnescapeDataString(($Path -split "/")[-1])
    $store.products = @($store.products | Where-Object { $_.id -ne $id })
    Write-Store $store
    return Json-Response 200 (Admin-Summary $store)
  }

  Static-Response $Path
}

Ensure-Store
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse("127.0.0.1"), $Port)
$listener.Start()
Write-Host "Test server running on http://localhost:$Port"

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $buffer = New-Object byte[] 3145728
    $total = 0
    $stream.ReadTimeout = 2000
    do {
      $read = $stream.Read($buffer, $total, $buffer.Length - $total)
      if ($read -le 0) { break }
      $total += $read
      $textSoFar = [Text.Encoding]::UTF8.GetString($buffer, 0, $total)
      $headerEnd = $textSoFar.IndexOf("`r`n`r`n")
      if ($headerEnd -ge 0) {
        $headersText = $textSoFar.Substring(0, $headerEnd)
        $contentLength = 0
        foreach ($line in $headersText -split "`r`n") {
          if ($line.ToLowerInvariant().StartsWith("content-length:")) { $contentLength = [int]$line.Split(":", 2)[1].Trim() }
        }
        $needed = $headerEnd + 4 + $contentLength
        if ($total -ge $needed) { break }
      }
    } while ($total -lt $buffer.Length)

    $raw = [Text.Encoding]::UTF8.GetString($buffer, 0, $total)
    $headerEnd = $raw.IndexOf("`r`n`r`n")
    $headerText = if ($headerEnd -ge 0) { $raw.Substring(0, $headerEnd) } else { $raw }
    $bodyText = if ($headerEnd -ge 0) { $raw.Substring($headerEnd + 4) } else { "" }
    $lines = $headerText -split "`r`n"
    $requestLine = $lines[0] -split " "
    $method = $requestLine[0]
    $path = ($requestLine[1] -split "\?")[0]
    $headers = @{}
    foreach ($line in $lines[1..($lines.Count - 1)]) {
      if ($line -match ":") {
        $parts = $line.Split(":", 2)
        $headers[$parts[0].Trim().ToLowerInvariant()] = $parts[1].Trim()
      }
    }
    [byte[]]$response = Handle-Request $method $path $headers $bodyText
    $stream.Write($response, 0, $response.Length)
  } catch {
    try {
      [byte[]]$response = Json-Response 500 @{ error = $_.Exception.Message }
      $stream.Write($response, 0, $response.Length)
    } catch {}
  } finally {
    $client.Close()
  }
}
