# RFC-001 — AlphaNex: de escrow P2P a exchange spot custodial (CEX)

| Campo | Valor |
|---|---|
| Estado | Borrador para revisión |
| Alcance | Ledger, matching, custodia y controles de ops del MVP de 90 días |
| Mercados | ANX/USDT, ETH/USDT (spot) |
| Redes | EVM. En este repo solo Anvil local (31337) y Sepolia (11155111) |
| Código de referencia | `02-matching-engine`, `03-ledger`, `04-api`, `05-blockchain-custody`, `06-web-trading-ui`, `07-ops` |

> English version: [`RFC-001-architecture.en.md`](./RFC-001-architecture.en.md)

## 1. Contexto

Hoy AlphaNex funciona como **escrow P2P**. Cada operación bloquea ETH en un contrato (`P2PEscrow.sol`) hasta que un verificador confirma el pago fiat. En ese modelo la custodia *es* el contrato: el estado on-chain es el único libro, y cada operación se liquida por separado.

Un CEX invierte ese modelo:

- Los usuarios **depositan** en wallets que controla el exchange.
- El trading ocurre **off-chain**, contra un ledger interno.
- Solo los **depósitos y retiros** tocan la cadena.

Eso aporta velocidad y formación de precio. El costo es que el exchange pasa a tener una **deuda con cada usuario**, y debe demostrar en todo momento que esos pasivos están respaldados por activos.

Este RFC fija la arquitectura para que esa prueba sea estructural y no una aspiración.

## 2. Objetivos / fuera de alcance

**Objetivos (90 días)**
1. Ledger de partida doble como única fuente de verdad de los saldos.
2. Motor de matching precio-tiempo determinista para dos mercados spot.
3. Depósito y retiro para una familia de activos EVM (ETH más ERC-20 USDT/ANX en la misma red), con confirmaciones, manejo de reorgs y conciliación.
4. UI de trading conectada a la API y al WebSocket reales.
5. Controles de ops: congelar usuario/mercado, retiros con cuatro ojos, log de auditoría a prueba de manipulación y checklist de staging.

**Fuera de alcance (diferido de forma explícita)**
- Mainnet.
- Rieles fiat.
- Margin y derivados.
- Multi-chain.
- Custodia MPC/HSM (se deja la interfaz; ver §6.4).
- Integración con un proveedor de KYC.
- Escalado horizontal del matching (ver §8).

## 3. Arquitectura general

```
            ┌──────────── UI Web (Next.js) ───────────┐
            │  REST (sesión Bearer)    WS /ws          │
            └──────────────┬───────────────────────────┘
                           ▼
┌──────────────────────── API (Fastify) ─────────────────────────┐
│ auth · rate limit · idempotencia · admin/ops · auditoría       │
│                                                                │
│  ExchangeService ── mutex por mercado ──► MatchingEngine (RAM) │
│        │ una tx de BD por comando                              │
│        ▼                                                       │
│  Ledger (Postgres, partida doble, asientos solo-append)        │
│        ▲                       ▲                               │
│  DepositService           WithdrawalService ──HMAC──► Firmante │
└────────┼───────────────────────┼───────────────────────────────┘
         │                       │ tx firmada cruda      (proceso aparte,
   Proceso watcher          Difusor                      único dueño de la clave)
   (confirmaciones, reorgs)      │
         └──────── RPC EVM (Anvil / Sepolia) ◄───────┘
```

**Fronteras de confianza**
- La **API nunca tiene una clave privada**. Solo tiene una **xpub** (direcciones de depósito) y un secreto HMAC para hablar con el firmante.
- El **firmante** aplica su propia política, sin depender de la API (§6.3).

## 4. Ledger

### 4.1 Modelo
- **Las cuentas** son códigos estructurados, así cada saldo se describe solo:

  | Cuenta | Tipo | Saldo normal |
  |---|---|---|
  | `user:<id>:<ACTIVO>:available` | pasivo | acreedor |
  | `user:<id>:<ACTIVO>:locked` | pasivo | acreedor |
  | `user:<id>:<ACTIVO>:withdrawing` | pasivo | acreedor |
  | `fees:<ACTIVO>` | ingreso | acreedor |
  | `custody:<wallet>:<ACTIVO>` | activo | deudor |
  | `expense:gas:<ACTIVO>` | gasto | deudor |
  | `equity:<nombre>:<ACTIVO>` | patrimonio | acreedor |

- **Los asientos** tienen ≥2 **movimientos**, todos enteros `NUMERIC(78,0)` en la unidad mínima del activo (wei, 1e-6 USDT). No hay coma flotante en ninguna parte: el motor y la API usan `bigint`, y la UI usa decimales como string.
- Cada asiento lleva una **clave de idempotencia** (`deposit:<txHash>:<logIndex>`, `trade:<mercado>:<seq>`, `withdrawal:<id>:reserve`, …). Re-postear la misma clave no hace nada y devuelve el asiento original. Eso es lo que hace seguro reintentar tras una caída.
- Los saldos están **materializados** y se actualizan en la misma transacción que los movimientos. Las filas se bloquean en un orden determinista (ids ordenados) para evitar deadlocks.

### 4.2 Invariantes (las chequea `checkInvariants()`, expuesta en `/admin/invariants` y ejecutada en CI)
1. Cada asiento cuadra por activo: Σdebe = Σhaber.
2. El saldo materializado es igual a la suma de movimientos, en cada cuenta.
3. Por activo, los saldos deudores igualan a los acreedores (los libros cierran). En concreto: **custodia + gastos = pasivos con usuarios + comisiones + patrimonio**.
4. Ninguna cuenta que prohíbe negativos queda negativa. Además, un `CHECK` de la BD lo impone al escribir.
5. (On-chain, §6.5) El saldo on-chain de las wallets controladas es igual a la custodia del ledger, ajustada por retiros en vuelo.

### 4.3 Flujos canónicos
| Evento | Movimientos |
|---|---|
| Depósito confirmado | D `custody:hot` / H `user:available` |
| Colocar orden | D `user:available` / H `user:locked` (retención) |
| Trade | D comprador `locked` quote / H vendedor `available` quote − fee vendedor; D vendedor `locked` base / H comprador `available` base − fee comprador; fees → `fees:*` |
| Cancelación / sobrante | D `user:locked` / H `user:available` |
| Pedido de retiro | D `available` (monto+fee) / H `withdrawing` |
| Retiro minado | D `withdrawing` / H `custody:hot` (monto), H `fees` (fee); gas: D `expense:gas` / H `custody:hot` |
| Retiro rechazado / revertido | D `withdrawing` / H `available` |

**Convención de comisiones.** El comprador paga la comisión en el activo que recibe (base) y el vendedor la paga en quote. Por eso una retención nunca necesita margen extra para la comisión, y la retención de una compra límite es exactamente `precio × cantidad`.

## 5. Matching

- **Propiedad.** Un libro de órdenes en memoria por mercado, con **un solo escritor** por mercado (mutex de promesas en la API).
- **Prioridad.** Precio-tiempo. El precio de ejecución es siempre el del maker.
- **Tipos de orden.** LIMIT (GTC, IOC, POST_ONLY) y MARKET.
  - Las compras MARKET están acotadas por `maxQuote`, es decir, por los fondos efectivamente retenidos.
- **Prevención de auto-trade.** Modo "expirar al taker".
- **Aritmética entera.** `tick`, `lot` y los decimales se validan para que `precio × cantidad` sea siempre un entero exacto en unidades quote. Así la liquidación no tiene redondeos.
  - ETH-USDT: tick 0.01, lote 0.0001.
  - ANX-USDT: tick 0.0001, lote 0.01, mínimo 1.
- **Atomicidad.** Cada comando corre en **una transacción de BD**: retener → `engine.submit` → liquidar cada trade en el ledger → persistir órdenes y trades → liberar sobrantes.
  - Si algo falla, la BD hace rollback y el libro se **reconstruye desde la BD**.
  - **La BD es la verdad y el libro es una caché.** Al reiniciar, los libros se reconstruyen desde las órdenes abiertas ordenadas por `seq`. Lo cubre el test `restart rebuild`.
- **Comisiones.** Maker 10 bps y taker 20 bps (configurables por mercado).
- **Interruptores.**
  - Congelar mercado: rechaza órdenes nuevas pero sigue permitiendo cancelar.
  - Congelar usuario: cancela todas sus órdenes abiertas y bloquea trading y retiros.

## 6. Custodia

### 6.1 Depósitos
- **Direcciones.** Cada usuario recibe una dirección derivada de una **xpub** (BIP-44 `m/44'/60'/0'/0/i`). La API rechaza `xprv`/`tprv`.
- **Proceso watcher.** El watcher recorre los bloques, verifica la continuidad de `parentHash`, registra como **pendientes** las transferencias nativas y los logs ERC-20 `Transfer` hacia direcciones conocidas, y las acredita cuando `confirmaciones ≥ umbral` (12 por defecto; configurable por activo). Antes de acreditar vuelve a verificar que el hash del bloque siga siendo canónico.
- **Exactamente una vez.** El id `txHash:logIndex` es la clave de idempotencia del ledger, así que una caída entre "acreditar" y "guardar cursor" no puede acreditar dos veces.

### 6.2 Reorgs
- **Depósito pendiente en un bloque reorganizado.** El depósito queda huérfano y no se postea nada.
- **Desaparece un depósito ya acreditado (crítico).** Significa que la profundidad de confirmación fue corta. **No hay reversión automática**, porque el usuario pudo haber operado o retirado. En cambio:
  1. Se congela al usuario.
  2. Se cancelan sus órdenes abiertas.
  3. Se marca el depósito.
  4. Se emite una alerta para los admins.

  La conciliación mostrará el déficit resultante. Una persona decide la reversión mediante un ajuste auditado.

### 6.3 Retiros (cuatro ojos más firmante independiente)
Máquina de estados: `pending_approval → approved → broadcast → completed | failed`, más `rejected` (reembolso).

- **Pedido.** El pedido del usuario es idempotente (`Idempotency-Key`) y tiene topes por tx y por 24 h móviles para cada activo. Los fondos más la comisión pasan a `withdrawing`.
- **Aprobación.** Deben aprobar **dos admins distintos**, y ninguno puede ser el solicitante.
- **Firma.** El **firmante** (proceso aparte, en 127.0.0.1, con HMAC, ventana de frescura y anti-replay por id de retiro) vuelve a verificar las aprobaciones, la lista de activos permitidos, los topes y la **lista de chainId permitidos** (31337/11155111 por defecto). Devuelve una tx firmada en crudo; la API guarda el hash *antes* de difundirla.
- **Confirmación.** Si el recibo es OK, el retiro se completa y el gas se registra en `expense:gas`. Si revierte, pasa a `failed` y los fondos quedan reservados hasta que un admin los reembolse.

### 6.4 Claves
- **MVP.** Una clave hot de testnet vive solo en el entorno del firmante, y una wallet fría se maneja offline (manual).
- **Camino a producción.** Reemplazar el backend de claves del firmante por un proveedor HSM/MPC detrás del mismo contrato `/sign`. Sumar topes de hot wallet por activo y barridos automáticos hot→fría (`moveCustody`, neutral para el ledger).

### 6.5 Conciliación
`reconcile()` compara los saldos on-chain de las direcciones controladas (hot más direcciones de depósito) con `custody:*` del ledger, ajustando por retiros en vuelo.

- **Déficit.** Es CRÍTICO: se activa automáticamente el interruptor global de retiros (`kv.withdrawals_halted`, actor `system`, auditado como `withdrawals.halt`) y se levanta una alerta en el canal `admin`. Mientras está activo, los pedidos nuevos de retiro y la firma devuelven `403 withdrawals_halted`; aprobar y rechazar siguen funcionando. Un admin reanuda con `POST /admin/withdrawals/halt {"halted": false, "reason": "..."}` (auditado como `withdrawals.resume`) siguiendo el runbook de `07-ops/runbooks/`.
- **Excedente.** Es un AVISO, por ejemplo transferencias sin atribuir o recargas de gas.

El watcher la ejecuta cada 5 min, y los admins pueden lanzarla a pedido.

## 7. Controles de ops y seguridad
- **Log de auditoría.** Solo-append y **encadenado por hash**: `hash = sha256(prev_hash | seq | at | actor | action | target | details)`. La manipulación se detecta con `/admin/audit/verify`, y los tests lo cubren. Toda acción de admin y todo congelamiento queda auditado, con motivo obligatorio.
- **Sesiones.** Tokens opacos aleatorios; solo se guarda su SHA-256. Las contraseñas usan scrypt.
- **Vincular wallet.** Se hace con un desafío firmado de un solo uso (EIP-191).
- **Manejo de pedidos.**
  - Esquemas JSON estrictos y límites de tamaño del cuerpo.
  - Rate limit global más un límite de auth por IP más estricto.
  - Headers de seguridad y CSP en la UI.
- **Red.** Los servicios escuchan en `127.0.0.1` salvo que se configure `ALLOW_PUBLIC_BIND=true`.
- **Guardas de arranque.** El proceso no arranca con un `CHAIN_ID` que no sea testnet, y el faucet de desarrollo queda apagado a la fuerza con `NODE_ENV=production`.
- **Puerta de staging.** Ver `07-ops/staging-checklist.*.md`.

## 8. Camino de escalado (después del MVP)
1. **Bus de eventos.** Cambiar el `EventBus` en proceso por Redis/NATS. El fan-out de WS escala horizontalmente, mientras el escritor de matching sigue siendo único por mercado, detrás de un lease de líder.
2. **Journal de comandos ordenado.** Pasar de "una tx de BD por comando" a un journal de comandos secuenciado (Kafka o `seq` de Postgres) con proyección asíncrona al ledger. Mantener las claves de idempotencia hace que los invariantes no cambien.
3. **Sharding.** Repartir los mercados entre nodos de matching. El ledger sigue siendo una única BD lógica, particionada por activo si hace falta.

## 9. Migración desde el escrow P2P sin romper la contabilidad
1. **Congelar el camino viejo, no los fondos.** `P2PEscrow.retire()` no tiene vuelta: bloquea escrows *nuevos*, pero `release`/`refund` siguen funcionando, así que ningún usuario queda trabado.
2. **Saldos de apertura.** Quien se suma deposita en su dirección del CEX por la vía normal. No hay "crédito de migración" y **no se crea ningún saldo sin un débito de custodia que lo respalde**.
3. **Convivencia.** P2P y CEX funcionan en paralelo detrás de feature flags. Se sigue el TVL del escrow on-chain, que debería bajar de forma monótona.
4. **Condición para el corte.** El corte exige en staging un chequeo de invariantes en verde, una conciliación limpia y la cadena de auditoría verificada (ver checklist).

## 10. Riesgos y preguntas abiertas
| Riesgo | Mitigación |
|---|---|
| Confirmaciones cortas en L2/testnet | Umbral por activo, congelamiento ante reorg crítico, conciliación |
| API comprometida | Sin claves en la API; el firmante revalida; dos aprobadores; topes |
| Retiro interno malicioso | Regla de cuatro ojos, solicitante ≠ aprobador, cadena de hash de auditoría, topes diarios por activo |
| Divergencia libro/BD | La BD es la verdad; el rollback dispara una reconstrucción; reconstrucción al reiniciar |
| Hot wallet sin fondos | El fondeo de tesorería se registra como patrimonio; alertas de conciliación; política hot→fría |

Preguntas abiertas:
- Elección del proveedor de KYC.
- Niveles de comisión.
- Red para ANX (¿la misma que USDT?).
- Proveedor MPC.
