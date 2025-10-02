# FamCall (Rodina)

Kompletní jednoduchá rodinná komunikační aplikace (MVP) — přihlášení přes 4-místný PIN, profilová fotka, chat a volání.

Struktura projektu:

- `frontend/` — React + Vite aplikace (UI, chat, přihlášení)
- `backend/` — Express server s Socket.IO (API, real-time)
- `assets/` — zvuky a ikony
- `tests/` — základní testy
- `docs/` — dokumentace v češtině

Podrobné instrukce najdete v `docs/README_CZ.md`.

Rychlý start (lokálně):

1. Nainstalujte závislosti v rootu (instalace nainstaluje i frontend/backend):

```bash
npm install
cd frontend && npm install
cd ../backend && npm install
```

2. Spusťte vývojové servery:

```bash
npm run dev
```

3. Pro nasazení na Netlify: vytvořte projekt, nastavte build command `npm run build:all` a publish `frontend/dist`.

Poznámka: tento repozitář obsahuje jednoduché MVP implementace. Pro produkční nasazení doporučujeme oddělené hostování backendu, HTTPS a další bezpečnostní prvky.
