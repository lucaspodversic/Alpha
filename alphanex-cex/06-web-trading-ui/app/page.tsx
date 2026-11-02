// EN: Home → default market. / ES: Inicio → mercado por defecto.
import { redirect } from 'next/navigation';

export default function Home() {
  // EN: Server-side redirect: no client JS needed.
  // ES: Redirección en el servidor: no hace falta JS en el cliente.
  redirect('/trade/ETH-USDT');
}
