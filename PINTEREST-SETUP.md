# Pinterest bağlantısı

İlk sürüm tek görselli Pin paylaşır: başlık, açıklama, alt metin ve isteğe bağlı ürün linki. Video, carousel ve zamanlama bu sürüme dahil değildir. Instagram araçları değiştirilmez.

## Yetkilendirme

- Uygulama gizli anahtarı erişim tokenı değildir. Ekran görüntüsünde ifşa olmuş anahtarı Pinterest panelinden yenileyin; kod veya sohbet içinde paylaşmayın.
- Paneldeki yalnızca `read` kapsamlı test tokenı yayın için yeterli değildir. Pinterest OAuth ile `pins:write`, `pins:read`, `boards:read`, `boards:write` ve hesap kontrolü için `user_accounts:read` kapsamlarını yetkilendirin. Pinterest Pin oluşturma uç noktası mevcut panoya yazarken de `boards:write` isteyebilir; MCP pano oluşturma aracı sunmasa da bu kapsam yayın için gereklidir.
- Pinterest OAuth kurulumu `/pinterest/connect` ve `/pinterest/callback` üzerinden yapılır. Mevcut MCP şifresiyle korunan kurulumda tek kullanımlık, tarayıcı çerezine bağlı state kontrolü vardır. Otomatik refresh yoktur; süresi dolmadan token yenilenmelidir. Mevcut Claude connector OAuth'u Pinterest OAuth'undan ayrıdır.
- Render Environment: `PINTEREST_ACCESS_TOKEN` yetkili token; `PINTEREST_SANDBOX=false` gerçek API içindir. Sandbox tokenı ile `true` kullanın; bunu gerçek yayın doğrulaması saymayın.
- Kodun Render'a deploy edilmesi gerekir. `/health` içindeki pinterest=true yalnızca tokenın tanımlı olduğunu gösterir; izin veya yayın testi değildir.
- Deploy sonrası Claude araç listesini yenileyin ve önce `pinterest_get_account`, ardından `pinterest_list_boards` çalıştırın. Tüm araçlar mevcut MCP kimlik doğrulamasının arkasındadır.

## Claude akışı

### Bir defalık OAuth kurulumu

1. Pinterest uygulamasının yönlendirme URI listesine tam olarak `https://ecommerce-mcp-jlt3.onrender.com/pinterest/callback` ekleyin.
2. Render Environment: `PINTEREST_CLIENT_ID=1600417`, `PINTEREST_CLIENT_SECRET` (uygulama gizli anahtarı), `PINTEREST_REDIRECT_URI=https://ecommerce-mcp-jlt3.onrender.com/pinterest/callback`, `PINTEREST_SANDBOX=false`. Gerçek gizli anahtarı Git'e yazmayın.
3. Güncel kodu deploy edin. `https://ecommerce-mcp-jlt3.onrender.com/pinterest/connect` adresini açıp mevcut MCP bağlanma şifresini girin. Doğru Pinterest hesabında izin verin.
4. Dönüş sayfasındaki access tokenı Render `PINTEREST_ACCESS_TOKEN` alanına kaydedin. Refresh tokenı güvenli kasada saklayın; mevcut sürüm otomatik yenilemez. Bu hassas sayfanın ekran görüntüsünü paylaşmayın. Yanıt cache edilmez; uygulama callback kodunu loglamaz. Hosting erişim loglarının da query string saklamadığından emin olun.
5. Kurulum oturumu 10 dakika geçerlidir ve tek sunucu sürecinin belleğindedir. Arada deploy/restart olursa yeniden `/pinterest/connect` ile başlayın. Bu kurulum tek instance içindir; çok instance için ortak oturum deposu gerekir.
6. Token kaydedilip servis güncellendikten sonra Claude hesabı ve panoları doğrulasın. Hiçbir test Pin'i kendiliğinden yayınlanmaz.

### Paylaşım

1. Hesabı ve hedef panoyu doğrula; eksik pano seçimini kullanıcıya sor.
2. Claude'un ürettiği görsel mevcut `instagram_create_direct_upload` / PUT akışıyla publicUrl alabilir. Bu yükleme aracı Instagram'a yayın yapmaz. Base64'ü elle yeniden yazma. Gerekli network allowlist ayarlarını koru.
3. `pinterest_preview_pin`: boardId, title, description, imageUrl, link, altText.
4. Görsel, hesap, pano gizliliği ve ürün linkini kullanıcıya göster; açık `SON ONAY: YAYINLA` bekle.
5. Aynı içerik ve previewHash ile `pinterest_publish_pin` çağır. Başarıda gerçek pinId ve Pin linkini sun. Preview hash hedef/içerik değişimini yakalar; görsel URL'sindeki dosya onaydan sonra değiştirilmemelidir.
6. Zaman aşımı/belirsiz sonuçta POST'u tekrar etme; önce Pinterest profilini kontrol et. API seviyesinde kalıcı idempotency bu sürümde yoktur.

Örnek: “Bu görseli Pinterest'te [pano adı] panosuna İngilizce başlık ve açıklamayla hazırla. Ürün bağlantısı: [URL]. Önizlemeyi göster.”

## Resmî kaynaklar

- https://developer.pinterest.com/docs/api/v5/pins-create/
- https://developer.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/
