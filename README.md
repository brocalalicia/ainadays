# AïnaDays

Registro de tomas, sueño y pañales de Aïna (3 meses, lactancia materna exclusiva), pensado para usarlo con una mano y a oscuras. Español / francés.

- `public/index.html` — la app completa (sin build, un solo archivo). Funciona sola en el móvil y sincroniza con la API cuando está desplegada.
- `server.js` — API Node (Express) sobre PostgreSQL. Un documento JSON por día en la tabla `dias`.
- `Dockerfile` / `docker-compose.yml` — despliegue en Coolify.

## Desplegar en Coolify

### Opción A (recomendada): base de datos gestionada por Coolify + app desde Dockerfile

1. **Base de datos**: en tu proyecto de Coolify → *New Resource* → *PostgreSQL* (versión 16). Ponle nombre `ainadays-db`. Al arrancar, copia la **Internal connection URL** (algo como `postgres://postgres:xxxx@ainadays-db:5432/postgres`).
2. **App**: *New Resource* → *Public/Private Repository* → `git@github.com:brocalalicia/ainadays.git`, rama `main`, *Build Pack: Dockerfile*. Puerto `3000`.
3. **Variables de entorno** de la app:
   - `DATABASE_URL` = la URL interna del paso 1.
   - `APP_KEY` = una contraseña larga. Es la que la app pide la primera vez que se abre en cada móvil (se guarda en el dispositivo).
   - `PORT` = `3000` (opcional).
4. Asigna un dominio (p. ej. `ainadays.aliciabrocal.cloud`) con HTTPS y pulsa **Deploy**. La tabla se crea sola al arrancar.
5. Comprueba `https://ainadays.aliciabrocal.cloud/api/health` → `{"ok":true}`.

### Opción B: todo en uno con docker-compose

*New Resource* → *Docker Compose* → este repositorio. Define `POSTGRES_PASSWORD` y `APP_KEY` en las variables de entorno de Coolify. El volumen `pgdata` guarda los datos entre despliegues.

## Uso en el móvil

Abre el dominio en Safari/Chrome → *Compartir* → *Añadir a pantalla de inicio*. La primera vez pide la contraseña (`APP_KEY`). Cada persona que registre (tú, tu pareja) hace lo mismo en su móvil; todos ven los mismos datos.

## Importar datos existentes

```bash
API_URL=https://ainadays.aliciabrocal.cloud APP_KEY=... node scripts/import.js datos/2026-09-12.json
```

Acepta ficheros `{ fecha, ev }` o el volcado completo de `localStorage['ritmo.dias']`.

## Desarrollo local

```bash
npm install
cp .env.example .env   # edita DATABASE_URL y APP_KEY
export $(grep -v '^#' .env | xargs) && npm run dev
```

## Modelo de datos

Tabla `dias(fecha DATE PK, doc JSONB, updated_at)`. `doc` = `{ fecha, ev: [...] }` con eventos:

| campo | valores |
|---|---|
| `t` | `toma` · `sueno` · `panal` · `nota` |
| `ini`, `fin` | epoch ms (`fin` = `null` si está en curso) |
| `lado` | `I` · `D` · `A` (solo tomas) |
| `p` | `pipi` · `caca` · `ambos` (solo pañal) |
| `n` | nota libre |
