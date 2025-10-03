# FamCall — dokumentace (čeština)

Tento dokument vysvětluje, jak spustit aplikaci FamCall (Rodina), nasadit ji na Netlify a spravovat uživatele.

## Lokální spuštění v Codespaces

1. Otevřete repozitář ve Codespaces.
2. V rootu spusťte:

```bash
npm install
npm run dev
```

Tím se spustí backend a frontend (skriptem `concurrently`). Backend běží na portu 3001, frontend na 5173.

## Nasazení na Netlify

1. V Netlify vytvořte nový projekt z tohoto repozitáře.
2. Build command: `npm run build:all`
3. Publish directory: `frontend/dist`
4. V produkci nastavte v Netlify proměnnou `BACKEND_URL` na veřejnou URL backendu (např. z Renderu). Frontend volá API přes `/.netlify/functions/proxy`, která žádosti přesměruje na `BACKEND_URL`.

### Backend na Render (doporučeno)

1. V kořeni repa je `render.yaml`. Na https://render.com → New → Blueprint → vyberte repozitář → potvrďte.
2. Po deploy získáte URL (např. `https://rodina-backend.onrender.com`).
3. Tuto URL nastavte v Netlify jako `BACKEND_URL` a redeployněte web.

Poznámky:
- Perzistence: nastavte v Renderu disk a proměnné `UPLOADS_DIR` (např. `/opt/render/project/src/uploads`) a volitelně `DATA_DIR` (pokud chcete `db.json` držet jinde – defaultně se použije stejné místo jako `UPLOADS_DIR`).
- Přidejte do Renderu případné klíče (Pusher, VAPID, XIRSYS) dle potřeby.

## Správa PINů a profilů

- PINy jsou ukládány jako bcrypt hash v `backend/db.json`.
- Pro změnu PINu nebo smazání uživatele: upravte `backend/db.json` a restartujte backend (`npm run dev` v `backend/`).

## Přidávání funkcí

- Frontend: upravujte `frontend/src/`.
- Backend: upravujte `backend/src/`.
- Pro audio/video hovory doporučujeme implementovat WebRTC a použít Socket.IO jako signaling server.

## Řešení build chyb

- Spusťte lokálně `npm run build:all` a opravte chyby podle výpisu.
- U Netlify zkontrolujte logy buildu.

## Bezpečnost a omezení

Toto je rodinná aplikace s minimální ochranou. PINy jsou hashovány, ale plná bezpečnost a škálovatelnost vyžaduje další kroky (HTTPS, ověřování, rate-limiting).

## Další kroky

- Přidat serverless funkce pro obrázky na Netlify nebo hostovat uploady zvlášť.
- Přidat další testy a E2E testy.
