# Dual-pane file manager s drag & drop — návrh

Dátum: 2026-10-06
Stav: čaká na schválenie

## Cieľ

V záložke File Ops si používateľ otvorí dva panely vedľa seba. Každý panel
ukazuje nezávisle zvolený zdroj: disk servera (Local), Remote zdroj (SMB/FTP)
alebo konzolu cez PS5 FTP. Typické kombinácie sú konzola + disk servera a
konzola + konzola (tá istá aj dve rôzne). Súbory a priečinky sa medzi panelmi
prenášajú pretiahnutím myšou.

Hotové je to vtedy, keď používateľ pretiahne súbor alebo priečinok z jedného
panela do druhého, zvolí Kopírovať alebo Presunúť, a prenos prebehne na
serveri cez frontu, viditeľný v Queue, aj keď prehliadač zavrie.

## Rozhodnutia od používateľa

- „PC“ znamená disk servera (zdroj Local), nie zariadenie s prehliadačom.
- Po pustení sa vždy zobrazí menu Kopírovať / Presunúť / Zrušiť.
- PS5 na oboch stranách musí fungovať.
- V prvej verzii je Remote zdroj (SMB/FTP) iba zdrojom, nie cieľom.
- Kopírovanie PS5 → PS5 ide cez dočasný priečinok na disku servera.

## Rozsah prvej verzie

| Z → Do | Kopírovať | Presunúť |
|---|---|---|
| Local → PS5 | fronta (existujúci upload) | fronta, potom zmazanie zdroja |
| PS5 → Local | fronta (nový smer) | fronta, potom zmazanie na PS5 |
| PS5 → tá istá PS5 | fronta cez dočasný priečinok | okamžitý FTP rename (existuje) |
| PS5 → iná PS5 | fronta cez dočasný priečinok | fronta, potom zmazanie zdroja |
| Local → Local | existujúce `/convert/local/copy` | existujúce `/convert/local/move` |
| Remote → PS5 | fronta (existujúci upload) | fronta, potom zmazanie zdroja |
| Remote → Local | fronta (nový smer) | fronta, potom zmazanie zdroja |
| čokoľvek → Remote | nepodporované, panel pustenie odmietne | nepodporované |

Mimo rozsahu: zápis do Remote zdrojov, priame streamovanie PS5 → PS5 bez
disku servera, pretiahnutie súborov z plochy prehliadača, pokračovanie
prerušeného prenosu od miesta prerušenia.

## Frontend

### Komponenty

- `DualPane.jsx` (nový): vykreslí dve inštancie `FileBrowser` vedľa seba,
  drží polohu oboch panelov (zdroj, konzola, cesta) a rozhoduje, čo sa stane
  po pustení. Pod 900 px šírky sú panely pod sebou.
- `FileBrowser.jsx` (úprava): nové voliteľné props
  - `paneId` — `'left'` alebo `'right'`
  - `onLocationChange({ kind, ftpIp, smbId, path })` — hlási polohu rodičovi
  - `onDropItems(payload, destPath)` — volá sa po pustení na panel alebo na
    riadok priečinka
  - `reloadSignal` — číslo; zmena vynúti znovunačítanie zoznamu
  Bez týchto props sa komponent správa presne ako dnes (Convert ho používa
  ďalej v jednopanelovom režime).
- `TransferMenu.jsx` (nový): malé menu Kopírovať / Presunúť / Zrušiť pri
  mieste pustenia. Ak backend vráti konflikt, zobrazí zoznam kolidujúcich
  názvov a voľbu Prepísať.
- `lib/transferPlan.js` (nový, čistá funkcia): z dvojice (zdroj, cieľ, op)
  vráti, ktorú cestu použiť: `ftp-rename`, `local-copy`, `local-move`,
  `queue` alebo `unsupported` s dôvodom. Jediné miesto, kde žije tabuľka
  vyššie; testovateľné bez UI.

### Drag & drop

- Riadky sú `draggable`. Ak je ťahaný riadok súčasťou viacnásobného výberu,
  ťahá sa celý výber, inak len ten riadok.
- Prenáša sa `dataTransfer` typu `application/x-p5m-items` s JSON:
  `{ pane, kind, ftpIp, smbId, path, items: [{ name, isDir, size }] }`.
- Cieľom je plocha panela (cieľ = aktuálna cesta) alebo riadok priečinka
  (cieľ = cesta/priečinok). Platný cieľ sa pri prechode zvýrazní.
- Pustenie do toho istého priečinka toho istého zdroja sa ignoruje.
- Dotykové zariadenia: pri neprázdnom výbere má panel tlačidlá
  „Kopírovať do druhého panela“ a „Presunúť do druhého panela“, ktoré robia
  to isté bez ťahania.

### Zapnutie režimu

V sub-záložke Browser vo File Ops pribudne prepínač „Dva panely“; voľba sa
pamätá v `localStorage`. Ľavý panel používa uložené predvolené umiestnenie
ako dnes, pravý si pamätá posledný zdroj a cestu v `localStorage`
(`enableSaveDefault={false}`).

## Backend

### Prenosová fronta

Existujúca `ftpUploadQ` v `routes/convert.js` sa rozšíri, nevzniká druhá
fronta. Persistencia, pause/resume/retry a zobrazenie v Queue tak fungujú
bez ďalšej práce. Položka dostane nové polia:

- `op`: `'copy'` | `'move'` (predvolene `'copy'`)
- `source_kind`: pribúda `'ps5-ftp'` (k `local`, `remote-smb`, `remote-ftp`)
- `source_ip`: IP zdrojovej konzoly pri `ps5-ftp`
- `dest_kind`: `'ps5-ftp'` (predvolené, dnešné správanie) | `'local'`
- `dest_local_path`: cieľový priečinok pri `dest_kind: 'local'`
- `batch_id`, `source_root`: spoločné pre položky z jedného pustenia

Staré položky bez týchto polí sa správajú ako doteraz.

### Vykonanie položky (`executeFtpUploadJob`)

1. Získanie zdroja na disk servera:
   - `local` — použije sa priamo;
   - `remote-*` — staging ako dnes;
   - `ps5-ftp` — stiahnutie z konzoly. Ak je cieľ `local`, sťahuje sa rovno
     do cieľového priečinka pod dočasným menom `.<názov>.part` a po dokončení
     sa premenuje. Inak do dočasného priečinka v `getDiskTmpRoot()`.
2. Pred stiahnutím kontrola voľného miesta (`fs.statfs`) voči veľkosti
   súboru; pri nedostatku položka zlyhá s jasnou chybou.
3. Zápis do cieľa: `ps5-ftp` cez existujúci `uploadFileResilient`; `local`
   kópiou, ak už súbor nie je na mieste z kroku 1.
4. Overenie: veľkosť v cieli sa musí rovnať veľkosti zdroja.
5. Pri `op: 'move'` sa zdrojový súbor zmaže až po úspešnom overení. Keď je
   dokončená posledná položka dávky a všetky skončili `completed`, zmažú sa
   prázdne priečinky pod `source_root`. Priečinok, v ktorom niečo ostalo,
   sa nemaže.
6. Dočasné súbory sa upracú vo `finally`, vrátane `.part` pri chybe.

Postup v percentách pri smere PS5 → Local ráta stiahnuté bajty; pri
PS5 → PS5 je prvá polovica stiahnutie a druhá upload.

### Endpoint

`POST /api/convert/transfer/queue`

```json
{
  "op": "copy",
  "overwrite": false,
  "src": { "kind": "ftp", "ip": "192.168.1.50", "path": "/data/homebrew/x", "is_dir": true },
  "dst": { "kind": "local", "path": "/mnt/games" }
}
```

- `src.kind`: `local` | `ftp` | `smb` (pri `smb` aj `source_id`);
  `dst.kind`: `local` | `ftp`.
- Priečinok sa rozbalí na položky po súboroch so zachovaním štruktúry,
  rovnako ako dnešný `/ftp/upload/queue`. Na prechádzanie priečinka na PS5
  pribudne `walkPs5DirFiles(ip, path)` podľa vzoru `walkSourceDirFiles`.
- Lokálne cesty (zdroj aj cieľ) prechádzajú cez `isLocalPathAllowed`.
- Ak v cieli už existuje položka s rovnakým menom a `overwrite` nie je
  `true`, vráti `409` s `{ conflicts: [názvy] }` a nič nezaradí.
- Odmietne cieľ vnútri zdroja (kopírovanie priečinka do seba samého).
- Odpoveď: `{ success, count, batch_id, items }`.

Starý `/ftp/upload/queue` ostáva bez zmeny pre existujúce volania.

## Chybové stavy

- Konzola nedostupná pri pustení: chyba z endpointu sa zobrazí ako
  notifikácia, nič sa nezaradí.
- Chyba počas prenosu: položka je `failed`, zdroj ostáva nedotknutý (aj pri
  presune), dá sa zopakovať z Queue.
- Reštart aplikácie počas prenosu: položka sa vráti do `queued` a prenesie
  sa celá odznova; osirotené `.part` súbory prepíše.
- Presun, pri ktorom časť položiek zlyhala: úspešne prenesené súbory sú zo
  zdroja zmazané, zlyhané ostávajú na mieste aj s priečinkom.

## Testovanie

- Backend dnes nemá testy. Pribudne `npm test` (`node --test`) pre čisté
  funkcie: rozbalenie priečinka na položky a výpočet cieľových ciest,
  kontrola „cieľ vnútri zdroja“, detekcia konfliktov.
- Frontend: `lib/transferPlan.js` pokrytý testom pre každý riadok tabuľky
  rozsahu.
- Ručné overenie proti skutočnej konzole s malými súbormi v samostatnom
  testovacom priečinku pod `/data/homebrew`: každý riadok tabuľky, priečinok
  s podpriečinkami, konflikt mien, zrušenie v menu, presun so zlyhaním
  uprostred (odpojenie konzoly).
- Vizuálna kontrola dvoch panelov na šírke desktopu a mobilu.

## Dotknuté súbory

- `frontend/src/components/DualPane.jsx` (nový)
- `frontend/src/components/TransferMenu.jsx` (nový)
- `frontend/src/lib/transferPlan.js` (nový)
- `frontend/src/components/FileBrowser.jsx` (drag zdroj/cieľ, nové props)
- `frontend/src/components/FileOps.jsx` (prepínač režimu)
- `frontend/src/components/Queue.jsx` (smer a operácia pri položke)
- `frontend/src/styles.css` (rozloženie panelov, zvýraznenie cieľa)
- `backend/src/routes/convert.js` (polia položky, executor, endpoint)
- `backend/package.json` (skript `test`)
