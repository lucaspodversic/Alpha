/**
 * EN: In-process event bus feeding WebSocket subscribers. In a multi-instance deployment this
 *     would be Postgres LISTEN/NOTIFY or Redis pub/sub (see RFC).
 * ES: Bus de eventos en proceso que alimenta a los suscriptores WebSocket. En un despliegue con
 *     varias instancias sería Postgres LISTEN/NOTIFY o Redis pub/sub (ver RFC).
 */
import { EventEmitter } from 'node:events';

// EN: Channel naming: book:<market>, trades:<market>, user:<id> (private), plus `admin` for alerts.
// ES: Nombres de canal: book:<mercado>, trades:<mercado>, user:<id> (privado), más `admin` para alertas.
export type BusEvent =
  | { channel: `book:${string}`; data: unknown }
  | { channel: `trades:${string}`; data: unknown }
  | { channel: `user:${string}`; data: unknown };

export class EventBus {
  private readonly ee = new EventEmitter();
  constructor() {
    // EN: Many sockets may subscribe. / ES: Muchos sockets pueden suscribirse.
    this.ee.setMaxListeners(0);
  }
  /** EN: Publishes to a channel. / ES: Publica en un canal. */
  publish(channel: string, data: unknown): void {
    this.ee.emit(channel, data);
  }
  /** EN: Subscribes; returns an unsubscribe fn. / ES: Se suscribe; devuelve una función para desuscribirse. */
  subscribe(channel: string, fn: (data: unknown) => void): () => void {
    this.ee.on(channel, fn);
    return () => this.ee.off(channel, fn);
  }
}
