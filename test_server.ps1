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
  $Store | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $DataFile -Encoding UTF8
}

function Ensure-Store {
  if (!(Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }
  if (!(Test-Path $DataFile)) {
    Write-Store @{
      shopName = "Shop Order"
      products = @(
        @{
          id = [guid]::NewGuid().ToString()
          name = "San pham mau"
          price = 99000
          description = "Ban co the doi thanh san pham that trong trang quan tri."
          image = ""
          isActive = $true
        }
      )
      orders = @()
    }
  }
}

function Read-Store {
  Ensure-Store
  $store = Get-Content -LiteralPath $DataFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($null -eq $store.products) { $store | Add-Member -Force -NotePropertyName products -NotePropertyValue @() }
  if ($null -eq $store.orders) { $store | Add-Member -Force -NotePropertyName orders -NotePropertyValue @() }
  foreach ($product in $store.products) {
    if ($null -eq $product.PSObject.Properties["isActive"]) {
      $product | Add-Member -Force -NotePropertyName isActive -NotePropertyValue $true
    }
  }
  return $store
}

function Send-Json($Response, [int]$Status, $Data) {
  $json = $Data | ConvertTo-Json -Depth 30
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $Response.StatusCode = $Status
  $Response.ContentType = "application/json; charset=utf-8"
  $Response.Headers["Cache-Control"] = "no-store"
  $Response.ContentLength64 = $bytes.Length
  $Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Read-Json($Request) {
  $reader = [System.IO.StreamReader]::new($Request.InputStream, [System.Text.Encoding]::UTF8)
  $body = $reader.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($body)) { return @{} }
  return $body | ConvertFrom-Json
}

function Is-Admin($Request) {
  $header = $Request.Headers["Authorization"]
  if (!$header -or !$header.StartsWith("Bearer ")) { return $false }
  return $Sessions.Contains($header.Substring(7))
}

function Get-PublicShop($Store) {
  @{
    shopName = $Store.shopName
    products = @($Store.products | Where-Object { $_.isActive -ne $false })
  }
}

function Get-AdminSummary($Store) {
  $totalRevenue = 0
  $totalSold = 0
  foreach ($order in $Store.orders) {
    $totalRevenue += [double]$order.total
    if ($order.items) {
      foreach ($item in $order.items) { $totalSold += [int]$item.quantity }
    } else {
      $totalSold += [int]$order.quantity
    }
  }
  @{
    shopName = $Store.shopName
    products = @($Store.products)
    orders = @($Store.orders)
    summary = @{
      totalRevenue = $totalRevenue
      totalOrders = @($Store.orders).Count
      totalSold = $totalSold
    }
  }
}

function Required-Text($Value, [int]$MaxLength) {
  $text = "$Value".Trim()
  if (!$text -or $text.Length -gt $MaxLength) { return $null }
  return $text
}

function Add-ArrayItem($ArrayValue, $Item) {
  $items = @($ArrayValue)
  return @($items + $Item)
}

function Serve-Static($Context) {
  $requestPath = $Context.Request.Url.AbsolutePath
  if ($requestPath -eq "/") { $requestPath = "/index.html" }
  $relative = [System.Uri]::UnescapeDataString($requestPath.TrimStart("/"))
  $target = [System.IO.Path]::GetFullPath((Join-Path $Public $relative))
  $publicFull = [System.IO.Path]::GetFullPath($Public)
  if (!$target.StartsWith($publicFull) -or !(Test-Path -LiteralPath $target -PathType Leaf)) {
    Send-Json $Context.Response 404 @{ error = "Not found" }
    return
  }
  $ext = [System.IO.Path]::GetExtension($target).ToLowerInvariant()
  $types = @{
    ".html" = "text/html; charset=utf-8"
    ".css" = "text/css; charset=utf-8"
    ".js" = "application/javascript; charset=utf-8"
    ".png" = "image/png"
    ".jpg" = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".webp" = "image/webp"
  }
  $bytes = [System.IO.File]::ReadAllBytes($target)
  $Context.Response.StatusCode = 200
  $Context.Response.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { "application/octet-stream" }
  $Context.Response.ContentLength64 = $bytes.Length
  $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

Ensure-Store
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Test server running on http://localhost:$Port"

while ($listener.IsListening) {
  $context = $listener.GetContext()
  try {
    $req = $context.Request
    $res = $context.Response
    $path = $req.Url.AbsolutePath
    $store = Read-Store

    if ($req.HttpMethod -eq "GET" -and $path -eq "/api/shop") {
      Send-Json $res 200 (Get-PublicShop $store)
    } elseif ($req.HttpMethod -eq "POST" -and $path -eq "/api/admin/login") {
      $body = Read-Json $req
      if ("$($body.password)" -ne $AdminPassword) { Send-Json $res 401 @{ error = "Sai mat khau." } }
      else {
        $token = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N"))
        [void]$Sessions.Add($token)
        Send-Json $res 200 @{ token = $token }
      }
    } elseif ($req.HttpMethod -eq "GET" -and $path -eq "/api/admin/dashboard") {
      if (!(Is-Admin $req)) { Send-Json $res 401 @{ error = "Ban can dang nhap quan tri." } }
      else { Send-Json $res 200 (Get-AdminSummary $store) }
    } elseif ($req.HttpMethod -eq "POST" -and $path -eq "/api/orders") {
      $body = Read-Json $req
      $requested = if ($body.items) { @($body.items) } else { @(@{ productId = $body.productId; quantity = $body.quantity }) }
      $name = Required-Text $body.name 80
      $phone = Required-Text $body.phone 40
      $address = Required-Text $body.address 300
      $note = "$($body.note)".Trim()
      if ($note.Length -gt 300) { $note = $note.Substring(0, 300) }
      $items = @()
      foreach ($requestedItem in $requested) {
        $product = @($store.products | Where-Object { $_.id -eq $requestedItem.productId })[0]
        $quantity = [int]$requestedItem.quantity
        if (!$product -or $product.isActive -eq $false -or $quantity -lt 1) {
          Send-Json $res 400 @{ error = "Thong tin don hang chua hop le." }
          throw "handled"
        }
        $items += @{
          productId = $product.id
          productName = $product.name
          price = [double]$product.price
          quantity = $quantity
          total = [double]$product.price * $quantity
        }
      }
      if (!$name -or !$phone -or !$address -or @($items).Count -eq 0) { Send-Json $res 400 @{ error = "Thong tin don hang chua hop le." } }
      else {
        $total = 0
        $quantityTotal = 0
        foreach ($item in $items) { $total += $item.total; $quantityTotal += $item.quantity }
        $order = @{
          id = [guid]::NewGuid().ToString()
          createdAt = [DateTimeOffset]::UtcNow.ToString("o")
          items = @($items)
          productName = (($items | ForEach-Object { "$($_.productName) x$($_.quantity)" }) -join ", ")
          quantity = $quantityTotal
          total = $total
          name = $name
          phone = $phone
          address = $address
          note = $note
        }
        $store.orders = Add-ArrayItem $store.orders $order
        Write-Store $store
        Send-Json $res 201 @{ ok = $true; orderId = $order.id }
      }
    } elseif ($req.HttpMethod -eq "PUT" -and $path -eq "/api/admin/shop") {
      if (!(Is-Admin $req)) { Send-Json $res 401 @{ error = "Ban can dang nhap quan tri." } }
      else {
        $body = Read-Json $req
        $shopName = Required-Text $body.shopName 80
        if (!$shopName) { Send-Json $res 400 @{ error = "Ten shop chua hop le." } }
        else {
          $store.shopName = $shopName
          Write-Store $store
          Send-Json $res 200 (Get-AdminSummary $store)
        }
      }
    } elseif ($req.HttpMethod -eq "POST" -and $path -eq "/api/admin/products") {
      if (!(Is-Admin $req)) { Send-Json $res 401 @{ error = "Ban can dang nhap quan tri." } }
      else {
        $body = Read-Json $req
        $name = Required-Text $body.name 100
        $price = [double]$body.price
        if (!$name -or $price -lt 0) { Send-Json $res 400 @{ error = "Thong tin san pham chua hop le." } }
        else {
          $image = "$($body.image)".Trim()
          if ($image.Length -gt 2200000) { $image = $image.Substring(0, 2200000) }
          $product = @{
            id = [guid]::NewGuid().ToString()
            name = $name
            price = $price
            description = "$($body.description)".Trim()
            image = $image
            isActive = $true
          }
          $store.products = Add-ArrayItem $store.products $product
          Write-Store $store
          Send-Json $res 201 (Get-AdminSummary $store)
        }
      }
    } elseif ($req.HttpMethod -eq "PATCH" -and $path -like "/api/admin/products/*/status") {
      if (!(Is-Admin $req)) { Send-Json $res 401 @{ error = "Ban can dang nhap quan tri." } }
      else {
        $id = [System.Uri]::UnescapeDataString(($path -split "/")[-2])
        $product = @($store.products | Where-Object { $_.id -eq $id })[0]
        if (!$product) { Send-Json $res 404 @{ error = "Khong tim thay san pham." } }
        else {
          $body = Read-Json $req
          $product.isActive = ($body.isActive -ne $false)
          Write-Store $store
          Send-Json $res 200 (Get-AdminSummary $store)
        }
      }
    } elseif ($req.HttpMethod -eq "DELETE" -and $path -eq "/api/admin/orders") {
      if (!(Is-Admin $req)) { Send-Json $res 401 @{ error = "Ban can dang nhap quan tri." } }
      else {
        $store.orders = @()
        Write-Store $store
        Send-Json $res 200 (Get-AdminSummary $store)
      }
    } elseif ($req.HttpMethod -eq "DELETE" -and $path -like "/api/admin/products/*") {
      if (!(Is-Admin $req)) { Send-Json $res 401 @{ error = "Ban can dang nhap quan tri." } }
      else {
        $id = [System.Uri]::UnescapeDataString(($path -split "/")[-1])
        $store.products = @($store.products | Where-Object { $_.id -ne $id })
        Write-Store $store
        Send-Json $res 200 (Get-AdminSummary $store)
      }
    } else {
      Serve-Static $context
    }
  } catch {
    if ($_.Exception.Message -ne "handled" -and !$context.Response.OutputStream.CanWrite) {
      Send-Json $context.Response 500 @{ error = $_.Exception.Message }
    } elseif ($_.Exception.Message -ne "handled") {
      try { Send-Json $context.Response 500 @{ error = $_.Exception.Message } } catch {}
    }
  } finally {
    try { $context.Response.Close() } catch {}
  }
}
