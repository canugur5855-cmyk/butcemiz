# Bütçemiz — Uğur & İzgi

Ortak ev bütçesi ve alışveriş listesi. iPhone ve Android'de çalışan, ana ekrana yüklenebilen bir web uygulaması (PWA).

## Özellikler

- **Özet:** Seçilen ayın geliri, gideri, kenara kalan para ve tasarruf oranı, o ay yatırıma giden tutar, kişi bazında (Uğur / İzgi) döküm, kategoriye göre giderler, son 12 ayın grafiği, tüm zamanlardaki toplam birikim ve yatırım dağılımı.
- **Hareketler:** Gelir ve gider kayıtları (Hepsi / Benim / Eşimin filtresi). Herkes sadece kendi kaydını ekleyip düzenleyebilir, ama ikiniz de hepsini görürsünüz.
- **Yatırım:** Kenara atılan parayla yapılan yatırımlar (altın, döviz, hisse, fon, mevduat, kripto, BES…).
- **Alışveriş:** Ortak liste. Tikle, kimin aldığı görünsün. "Alınanları temizle" ile listeyi sadeleştir.
- Canlı senkron: bir telefonda eklenen kayıt diğerinde anında görünür.

## Kurulum

1. **Supabase:** Projede SQL Editor'ü aç ve `supabase/schema.sql` dosyasını çalıştır.
2. `config.js` dosyasına projenin URL'sini ve anon (publishable) anahtarını yaz.
3. Klasörü statik bir hostinge yükle (GitHub Pages, Netlify, Cloudflare Pages…). HTTPS şart.
4. Hesaplar kullanıcı adı + şifre ile çalışır (arka planda `kullaniciadi@butcemiz.local`, e-posta gönderilmez).
   Kayıt olma veritabanı seviyesinde kapalıdır; yeni hesap sadece Supabase SQL Editor'den açılabilir.
   Şifreler uygulamadaki 🔑 butonundan değiştirilebilir.

## Telefona yükleme

- **iPhone (Safari):** Siteyi aç → Paylaş butonu → **Ana Ekrana Ekle**.
- **Android (Chrome):** Siteyi aç → ⋮ menü → **Ana ekrana ekle / Uygulamayı yükle**.

## Yerelde deneme

```
npx serve .
```
