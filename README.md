# SRT Scraper v2

Scraper de e-Servicios SRT que **solo inserta movimientos de casos que ya existen** en tu tabla `casos_srt`.

## Lógica de Funcionamiento

```
┌─────────────────────┐
│  e-Servicios SRT    │
│  (AFIP)             │
│  Expedientes:       │
│  - 61485/25         │
│  - 247790/25        │
│  - etc...           │
└──────────┬──────────┘
           │
           ▼
    ┌──────────────┐
    │   MATCHING   │
    │  por numero  │
    │    SRT       │
    └──────┬───────┘
           │
     ┌─────┴─────┐
     │           │
     ▼           ▼
 ✅ MATCH    ⚪ SIN MATCH
 Inserta     No hace
 movs        nada
```

## Matching

El sistema compara:
- **e-Servicios**: `61485/25` (campo `Nro`)
- **casos_srt**: `/ 61485-25` o `CABA / 61485-25` o `61485/25` (campo `numero_srt`)

Normaliza ambos formatos para poder comparar.

## Endpoints

### `POST /srt/expedientes`
Obtiene lista de expedientes de e-Servicios SRT (sin insertar nada).

### `POST /srt/test-matching`
Muestra qué expedientes matchean con `casos_srt` (sin insertar nada).

### `POST /srt/importar-movimientos-masivo`
Importa movimientos de todos los expedientes que matchean.

```bash
curl -X POST https://tu-app.up.railway.app/srt/importar-movimientos-masivo \
  -H "Content-Type: application/json" \
  -d '{"usuario":"20313806198","password":"BebeTeam2024"}'
```

### `POST /srt/novedades-diarias`
Solo procesa expedientes con comunicaciones sin leer.

### `GET /srt/movimientos/:caso_srt_id`
Ver movimientos guardados de un caso.

## Deploy en Railway

### Variables de entorno:
```env
SUPABASE_URL=https://wdgdbbcwcrirpnfdmykh.supabase.co
SUPABASE_KEY=tu_service_role_key
PORT=3000
```

## GitHub Actions (Cron)

Secrets requeridos:
- `SCRAPER_URL`: URL de Railway
- `AFIP_CUIT`: 20313806198
- `AFIP_PASSWORD`: BebeTeam2024

## SQL

Ejecutar `supabase/001_movimientos_srt.sql` en Supabase.
