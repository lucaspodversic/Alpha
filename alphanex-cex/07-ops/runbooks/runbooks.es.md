# AlphaNex CEX — Runbooks de incidentes (ES)

> Alcance: despliegue de referencia en testnet / local. Toda acción de admin queda auditada con motivo obligatorio.
> Regla cero: **primero congelar, después investigar, nunca "arreglar" saldos solo con SQL a mano.**

Todos los endpoints requieren sesión de admin (`Authorization: Bearer <token>`). La API escucha en `127.0.0.1` por defecto.

---

## RB-1 · Reorg crítico (desapareció un depósito ya acreditado)

**Señal:** alerta en el canal `admin` `credited deposit <id> reorged out`; acción de auditoría `deposit.critical_reorg`; estado del depósito `reorged_after_credit`.

**Lo que el sistema ya hizo:** congeló al usuario (órdenes canceladas, trading y retiros bloqueados) y lo auditó. **No** revirtió el crédito (los fondos pueden estar operados).

**Pasos**
1. Confirmar en un explorador / nodo propio que la tx realmente no está (y no que solo tarda en reincluirse). Esperar N confirmaciones más.
2. `POST /admin/reconcile` → se espera un déficit en ese activo (esto además **detiene los retiros automáticamente**, ver RB-2).
3. Decidir con un segundo operador: (a) la tx se reincluyó → nada que hacer; (b) la tx no está → registrar un ajuste auditado contra el saldo del usuario (si queda negativo, se mantiene como cuenta a cobrar en `equity`; NO lo expone la API del MVP — script revisado y ejecutado por dos ingenieros).
4. Descongelar al usuario (`POST /admin/users/:id/freeze {"frozen": false, "reason": "..."}`) solo después de registrar la decisión.
5. Reanudar retiros según RB-2.

## RB-2 · Déficit de conciliación (retiros detenidos automáticamente)

**Señal:** reporte de `reconcile` con `ok: false` y déficit; auditoría `withdrawals.halt` con actor `system`; los usuarios reciben `403 withdrawals_halted`.

**Pasos**
1. `GET /admin/withdrawals/halt` → leer el motivo (lista los activos en déficit).
2. `GET /admin/invariants` → el ledger debe seguir cuadrando (suma = 0, sin negativos). Si no → frenar y escalar (RB-5/RB-6).
3. Explicar la diferencia: retiros `broadcast` sin confirmar (`POST /admin/withdrawals/confirm`), gas gastado sin registrar, reorg crítico (RB-1) o robo (RB-3).
4. Repetir `POST /admin/reconcile` hasta `ok: true` (o hasta que la diferencia residual esté explicada y registrada).
5. Reanudar, con un segundo operador mirando:
   `POST /admin/withdrawals/halt {"halted": false, "reason": "déficit explicado: <ticket>"}` → auditoría `withdrawals.resume`.
6. Detención manual en cualquier momento: mismo endpoint con `{"halted": true, "reason": "..."}` (también es un botón en la UI de Admin).

## RB-3 · Sospecha de compromiso del firmante / clave hot

1. Detener retiros de inmediato (`POST /admin/withdrawals/halt {"halted": true, ...}`).
2. Detener el proceso firmante (es un proceso separado; la API no puede firmar sin él).
3. Rotar `SIGNER_HMAC_SECRET` (API + firmante) y generar una clave hot de testnet **nueva**; mover los fondos restantes de la dirección vieja con una transferencia supervisada.
4. Revisar los logs de política del firmante contra la tabla `withdrawals`: cada tx firmada debe corresponder a un retiro `approved` con 2 aprobadores distintos.
5. `POST /admin/reconcile`, documentar la pérdida (si la hay) como ajuste auditado y reanudar (RB-2 paso 5).

## RB-4 · Retiro trabado o fallido

- `broadcast` por demasiado tiempo: `POST /admin/withdrawals/confirm` vuelve a consultar recibos. Si salió del mempool → pasa a `failed`.
- `failed`: los fondos siguen en `withdrawing`. Se puede volver a `process` o `POST /admin/withdrawals/:id/reject {"reason": ...}` → monto + fee vuelven a `available`.
- **Nunca** rechazar un retiro `broadcast`: todavía puede confirmarse on-chain (pago doble).

## RB-5 · Divergencia libro de órdenes / BD

**Señal:** `GET /admin/invariants` informa libro ≠ órdenes abiertas o bloqueado ≠ retenciones.

1. Congelar el mercado afectado (`POST /admin/markets/:id/freeze`).
2. Reiniciar la API: los libros se reconstruyen **desde la BD** (la BD es la fuente de verdad; el motor es un caché).
3. Repetir invariantes; descongelar cuando estén limpios. Adjuntar la salida al ticket del incidente.

## RB-6 · Ruptura de la cadena de auditoría

**Señal:** `GET /admin/audit/verify` devuelve `ok: false` con el primer `seq` inválido.

1. Tratarlo como incidente de seguridad: alguien saltó el trigger de solo-append (acceso a nivel BD).
2. Detener retiros y congelar todos los mercados; hacer snapshot de la BD.
3. Comparar con backups / WAL para encontrar las filas alteradas; rotar credenciales de la BD.
4. No "reparar" la cadena: iniciar un segmento nuevo solo después de cerrar y documentar el incidente.

## RB-7 · Congelar mercado o usuario (rutina)

- Mercado: `POST /admin/markets/:id/freeze {"frozen": true, "reason": "..."}` — rechaza órdenes nuevas; cancelar sigue permitido.
- Usuario: `POST /admin/users/:id/freeze {"frozen": true, "reason": "..."}` — cancela órdenes abiertas, bloquea trading y retiros.
- Descongelar con `frozen: false`. Cada cambio se ve en el panel de auditoría de la UI de Admin.
