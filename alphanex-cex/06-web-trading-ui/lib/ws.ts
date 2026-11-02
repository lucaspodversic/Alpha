'use client';
/**
 * EN: React hook for the API WebSocket with auto-reconnect + resubscribe.
 * ES: Hook de React para el WebSocket de la API con reconexión y re-suscripción automáticas.
 */
import { useEffect, useRef } from 'react';
import { WS_URL, getToken } from './api';

// EN: Usage: useChannels(['book:ETH-USDT'], (channel, data) => ...). An empty list opens no subscriptions.
// ES: Uso: useChannels(['book:ETH-USDT'], (canal, datos) => ...). Una lista vacía no abre suscripciones.
export function useChannels(channels: string[], onEvent: (channel: string, data: any) => void): void {
  // EN: Keep the latest callback without resubscribing. / ES: Mantener el último callback sin re-suscribir.
  const cb = useRef(onEvent);
  cb.current = onEvent;
  // EN: A stable string key, so a new array with the same channels does not reconnect.
  // ES: Una clave string estable, así un array nuevo con los mismos canales no reconecta.
  const key = channels.join(',');
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      ws = new WebSocket(WS_URL);
      // EN: On every (re)connect: authenticate first (private channels), then resubscribe everything.
      // ES: En cada (re)conexión: autenticar primero (canales privados) y luego re-suscribir todo.
      ws.onopen = () => {
        retry = 0;
        const token = getToken();
        if (token) ws!.send(JSON.stringify({ op: 'auth', token }));
        for (const c of key.split(',').filter(Boolean)) ws!.send(JSON.stringify({ op: 'subscribe', channel: c }));
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(String(e.data));
          // EN: Other frame types (acks, errors) are ignored by the UI.
          // ES: Otros tipos de frame (acks, errores) los ignora la UI.
          if (m.type === 'event') cb.current(m.channel, m.data);
        } catch {
          /* EN: ignore malformed frames / ES: ignorar frames malformados */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        // EN: Exponential backoff up to 10 s. / ES: Backoff exponencial hasta 10 s.
        timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      };
    };
    connect();
    // EN: Cleanup on unmount / channel change: stop reconnecting and close the socket.
    // ES: Limpieza al desmontar / cambiar canales: dejar de reconectar y cerrar el socket.
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [key]);
}
