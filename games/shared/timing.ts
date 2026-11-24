import type { FlightEvent } from '../flight/types.ts';

/** One timing table for client playback and server bots. */
export const STEP_MS = 190;
export const DICE_FLASH_MS = 500;
export const SKIP_SHAKE_MS = 900;
export const ITEM_ACTIVATE_MS = 700;
const EVENT_MS: Partial<Record<FlightEvent['type'], number>> = {
    dice: DICE_FLASH_MS, skip: SKIP_SHAKE_MS, launch: STEP_MS,
    jump: 310, fly: 310, finish: 500, collide: 200, collision_bonus: 200,
    teleport: 400, reset: 500, item_activate: ITEM_ACTIVATE_MS, mystery_box: 2100,
};
export function eventsDuration(events: FlightEvent[] | null | undefined): number {
    let ms = 0;
    for (const event of events || []) {
        if (event.type === 'walk') { ms += (event.path ? event.path.length : 1) * STEP_MS; continue; }
        ms += EVENT_MS[event.type] || 0;
    }
    return ms;
}
