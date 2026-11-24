import type { AccountSocket } from '../../../backend/gameModule.ts';
import { flightServerProtocol } from '../protocol.ts';
import type { FlightServerMessage } from '../protocol.ts';

export function send(ws: AccountSocket, message: FlightServerMessage): void {
  ws.send(flightServerProtocol.encode(message));
}
