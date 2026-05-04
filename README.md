# WebScrapingAI Key Router

Ten projekt dziala jako warstwa posrednia miedzy Twoim serwisem a WebScrapingAI.
Backend trzyma wiele kluczy w env, wybiera klucz z najwyzszym `remaining_api_calls` i wystawia dashboard do podgladu ich stanu.

Kazde wychodzace zapytanie do WebScrapingAI jest wymuszane z:

- `proxy=residential`
- `js=true`

Klient nie moze tego nadpisac.

## Endpointy

- `GET /html` - kompatybilny endpoint typu drop-in replacement dla `https://api.webscraping.ai/html`.
- `GET /resolve-stream` - resolve hosta Dood/MyVidPlay do stabilnego playback URL na tym API.
- `GET /stream` - proxy streamu dla mp4 oraz HLS/m3u8 z utrzymaniem sesji, cookies i naglowkow hosta.
- `POST /api/proxy` - glowny endpoint proxy do WebScrapingAI.
- `POST /api/chat` - alias zgodnosciowy do `POST /api/proxy`.
- `GET /api/status` - odczyt aktualnego stanu cache kluczy.
- `POST /api/status` - wymuszenie pelnego odswiezenia wszystkich kluczy.

## Kompatybilny GET /html

Endpoint `GET /html` przyjmuje parametry query zgodne z WebScraping.AI: `api_key`, `url`, `js`, `wait_for`, `proxy`, `country`, `device`, `timeout`, `js_timeout`, `headers`.

- `api_key` mozna przekazac w query albo w headerze `x-api-key`; backend porownuje go z `WEBSCRAPINGAI_COMPAT_API_KEY`, a jesli jej nie ma to z `APP_PASSWORD`.
- Przy poprawnym scrape odpowiedz ma status `200`, body jako surowy HTML oraz naglowki `x-target-status` i `x-target-url`.
- Jesli target zwroci `403` albo `404`, endpoint nadal odpowiada `200`, a rzeczywisty status targetu jest dostepny w `x-target-status`.
- `headers` musi byc JSON stringiem z obiektem naglowkow dla requestu do strony docelowej.

Przyklad 1:

```bash
curl "http://localhost:3000/html?api_key=TEST&url=https%3A%2F%2Fexample.com&js=true"
```

Przyklad 2:

```bash
curl "http://localhost:3000/html?url=https%3A%2F%2Fexample.com%2Flogin&wait_for=%23app&timeout=20000&js_timeout=8000&headers=%7B%22User-Agent%22%3A%22Mozilla%2F5.0%22%7D" ^
  -H "x-api-key: TEST"
```

## Stabilny stream dla hostow video

Nowa warstwa streamingu nie zwraca surowego CDN URL. Zamiast tego:

1. `GET /resolve-stream?url=...` rozwiazuje hosta i tworzy serwerowy ticket z TTL.
2. Odpowiedz zawiera stabilny `playbackUrl` na tym API.
3. `GET /stream?ticket=...` proxyfikuje bajty albo playlisty przez ten sam backend.
4. Dla HLS wszystkie playlisty, nested playlisty, segmenty, `EXT-X-KEY` i `EXT-X-MAP` sa przepisywane na `/stream?ticket=...&asset=...`.

To ogranicza problem `error_wrong_ip` i `RELOAD`, bo klient nigdy nie dostaje surowego URL z obcego CDN, a API utrzymuje cookies, referer i origin po swojej stronie.

Przyklad resolve:

```bash
curl "http://localhost:3000/resolve-stream?api_key=TEST&url=https%3A%2F%2Fdoodstream.com%2Fe%2Fabc123&debug=1"
```

Przyklad odtwarzania mp4 lub root HLS:

```bash
curl -i "http://localhost:3000/stream?ticket=STREAM_TICKET"
```

Przyklad Range dla mp4:

```bash
curl -i "http://localhost:3000/stream?ticket=STREAM_TICKET" -H "Range: bytes=0-127"
```

Przyklad HLS po resolve:

```bash
curl -i "http://localhost:3000/stream?ticket=STREAM_TICKET"
```

Jesli root stream jest HLS, odpowiedz bedzie playlista `m3u8`, a wszystkie kolejne URI w tej playliscie beda juz wskazywaly z powrotem na to API.

### Env dla streamingu

Opcjonalne zmienne:

```env
STREAM_SESSION_TTL_SECONDS=1800
MAX_STREAM_SESSIONS=200
STREAM_CORS_ALLOW_ORIGIN=*
STREAM_RESOLVE_MAX_DEPTH=4
```

### Jak API utrzymuje stabilnosc sesji/IP

- Resolve i stream nie dziela surowego CDN URL z klientem.
- Dla root playback backend ponawia resolve po stronie serwera przed pobraniem aktualnego media URL.
- Dla HLS backend przepina playlisty i rozpoznaje child assets po indeksie wpisu w playliscie, a nie po starym signed URL.
- Cookies, referer, origin i user-agent sa trzymane po stronie API przez TTL ticketu.
- Gdy upstream odda HTML, `error_wrong_ip` albo `RELOAD`, endpoint zwraca kontrolowany blad JSON zamiast udawanego sukcesu.

## Env w Vercel

Po przeniesieniu projektu na inne konto Vercel zmienne srodowiskowe i domeny nie kopiuja sie automatycznie. Po imporcie projektu ustaw je recznie jeszcze raz.

Najlepszy wariant przy 10+ kluczach to osobna zmienna dla kazdego klucza:

```env
APP_PASSWORD=superhaslo
WEBSCRAPINGAI_KEY_01=twoj_klucz_1
WEBSCRAPINGAI_KEY_02=twoj_klucz_2
WEBSCRAPINGAI_KEY_03=twoj_klucz_3
WEBSCRAPINGAI_KEY_04=twoj_klucz_4
WEBSCRAPINGAI_KEY_05=twoj_klucz_5
WEBSCRAPINGAI_KEY_06=twoj_klucz_6
WEBSCRAPINGAI_KEY_07=twoj_klucz_7
WEBSCRAPINGAI_KEY_08=twoj_klucz_8
WEBSCRAPINGAI_KEY_09=twoj_klucz_9
WEBSCRAPINGAI_KEY_10=twoj_klucz_10
```

Fallback tez dziala przez `WEBSCRAPINGAI_KEYS` jako JSON array albo lista rozdzielona przecinkami lub nowymi liniami, ale przy 10 kluczach lepsze sa osobne zmienne.

Jesli `GET /html` zwraca `{"error":"Brak dostepu. Bledny api_key."}` to znaczy, ze na deploymencie jest ustawione `WEBSCRAPINGAI_COMPAT_API_KEY` albo fallbackowo `APP_PASSWORD`, a klient wysyla inny `api_key` lub nie wysyla go wcale.

Minimalny zestaw env po migracji projektu:

```env
WEBSCRAPINGAI_KEY_01=twoj_klucz_1
APP_PASSWORD=superhaslo
```

Opcjonalnie, jesli chcesz miec osobny sekret tylko dla `GET /html`:

```env
WEBSCRAPINGAI_COMPAT_API_KEY=osobny_sekret_dla_html
```

## Jak wysylac request z innego projektu

Przyklad dla `GET /html`:

```http
POST /api/proxy
Content-Type: application/json
x-app-password: superhaslo

{
  "endpoint": "/html",
  "method": "GET",
  "params": {
    "url": "https://example.com",
    "wait_for": "body"
  }
}
```

Przyklad dla `GET /ai/question`:

```http
POST /api/proxy
Content-Type: application/json
x-app-password: superhaslo

{
  "endpoint": "/ai/question",
  "method": "GET",
  "params": {
    "url": "https://example.com",
    "question": "O czym jest ta strona?"
  }
}
```

Przyklad dla `POST /html`:

```http
POST /api/proxy
Content-Type: application/json
x-app-password: superhaslo

{
  "endpoint": "/html",
  "method": "POST",
  "params": {
    "url": "https://httpbin.org/post",
    "body": "username=test&password=demo",
    "headers": {
      "Content-Type": "application/x-www-form-urlencoded"
    }
  }
}
```

Backend sam dopina `api_key`, `proxy=residential` i `js=true`.

## Jak dziala wybor klucza

1. Backend sprawdza wszystkie klucze przez `GET https://api.webscraping.ai/account?api_key=...`.
2. Trzyma wynik w cache w pamieci procesu.
3. Do obslugi requestu wybiera klucz z najwyzszym `remaining_api_calls`.
4. Jesli WebScrapingAI zwroci `402`, `403` albo `429`, backend probuje kolejny klucz.
5. Po odeslaniu odpowiedzi do Twojego zewnetrznego serwisu backend odpala pelny refresh statusow wszystkich kluczy w tle.

To daje Ci szybki wybor przy nastepnym requestcie bez czekania na sprawdzenie wszystkich kluczy od zera.

## Co pokazuje dashboard

Dashboard pokazuje tylko dane z backendu:

- env klucza, na przyklad `WEBSCRAPINGAI_KEY_01`
- zamaskowany podglad klucza
- `remaining_api_calls`
- `remaining_concurrency`
- czas resetu
- status klucza
- ostatni znany koszt requestu z `X-Credits-Used`
- ostatni status celu z `X-Target-Status`
- aktywny najlepszy klucz

## Ważna uwaga o odswiezaniu po odpowiedzi

Mechanizm „najpierw odpowiedz, potem odswiez wszystkie klucze” jest tutaj zrobiony jako best effort. Na zwyklym Node dziala normalnie, ale na Vercel nie ma gwarancji wykonania po kazdym requestcie po stronie cold startow i zatrzymania instancji.

Jesli chcesz bardziej stabilny stan:

1. ustaw Vercel Cron wywolujacy `POST /api/status` co minute,
2. albo przenies cache do Redis, Upstash albo Vercel KV.

Obecna wersja nadal robi to, o co prosiles: po odpowiedzi probuje natychmiast przeliczyc wszystkie klucze w tle."# api.msxx.pl" 
