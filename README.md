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
4. İkiniz de uygulamayı açıp **"Hesap oluştur"** ile kaydolun (adınızı seçerek).
   - Hane en fazla 2 kişi kabul eder; üçüncü kayıt veritabanı tarafından reddedilir.
   - İkiniz de kaydolduktan sonra Supabase → Authentication → Sign In / Providers → **"Allow new users to sign up"** seçeneğini kapatmanız önerilir.

## Telefona yükleme

- **iPhone (Safari):** Siteyi aç → Paylaş butonu → **Ana Ekrana Ekle**.
- **Android (Chrome):** Siteyi aç → ⋮ menü → **Ana ekrana ekle / Uygulamayı yükle**.

## Yerelde deneme

```
npx serve .
```
