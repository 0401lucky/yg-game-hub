import type { FlightAction, PackedAction, PackedReplay, ReplayActionTuple, ReplayArchive } from '../flight/types.ts';

/** Shared replay tuples. Codes and omitted trailing zeros remain wire-compatible. */
export const REPLAY_FORMAT = 1;
const ACTION_CODES: Record<string, number> = { roll: 0, move: 1, item: 2, skip: 3, teleport: 4 };
const ACTION_NAMES = ['roll', 'move', 'item', 'skip', 'teleport'];
const RAW_CODE = 9;
const ITEM_CODES: Record<string, number> = { 'remote-dice': 1, 'polyhedral-dice': 2, teleport: 3, mysteryBox: 4 };
const ITEM_NAMES = [null, 'remote-dice', 'polyhedral-dice', 'teleport', 'mysteryBox'] as const;
const REASON_CODES: Record<string, number> = { mysteryBox: 1 };
const REASON_NAMES = [null, 'mysteryBox'] as const;

export function encodeReplayAction(action: Partial<FlightAction> = {}): ReplayActionTuple {
    return trimTrailingZeros(buildActionTuple(action));
}

function buildActionTuple(action: Partial<FlightAction> = {}): ReplayActionTuple {
    const code = ACTION_CODES[action.type ?? ''];
    if (code === undefined) return [RAW_CODE, action as FlightAction];
    switch (action.type) {
        case 'roll':
            return [0, action.value || 0, action.maxDice || 0, ITEM_CODES[action.item ?? ''] || 0];
        case 'move':
        case 'teleport':
            return [code, action.chessIndex || 0];
        case 'item':
            return [2, ITEM_CODES[action.item ?? ''] || 0];
        case 'skip':
            return [3, REASON_CODES[action.reason ?? ''] || 0];
        default:
            return [RAW_CODE, action as FlightAction];
    }
}

export function decodeReplayAction(tuple: readonly unknown[] = []): FlightAction | null {
    const [code, a = 0, b = 0, c = 0] = tuple as [number, number, number, number];
    // Preserve the legacy default for an incomplete raw tuple as well.
    if (code === RAW_CODE) return a as unknown as FlightAction;
    switch (ACTION_NAMES[code]) {
        case 'roll': {
            const action: Extract<FlightAction, { type: 'roll' }> = { type: 'roll' };
            if (a) action.value = a;
            if (b) { action.maxDice = b; action.noBonus = true; }
            if (c && ITEM_NAMES[c]) action.item = ITEM_NAMES[c];
            return action;
        }
        case 'move': return { type: 'move', chessIndex: a };
        case 'teleport': return { type: 'teleport', chessIndex: a };
        case 'item': return { type: 'item', item: ITEM_NAMES[a] || null };
        case 'skip': {
            const action: Extract<FlightAction, { type: 'skip' }> = { type: 'skip' };
            if (REASON_NAMES[a]) action.reason = REASON_NAMES[a];
            return action;
        }
        default: return null;
    }
}

function trimTrailingZeros<Tuple extends unknown[]>(tuple: Tuple, keep = 1): Tuple {
    let end = tuple.length;
    while (end > keep && tuple[end - 1] === 0 && typeof tuple[end - 1] === 'number') end -= 1;
    return tuple.slice(0, end) as Tuple;
}

export function encodeArchive(archive: ReplayArchive | PackedReplay): PackedReplay;
export function encodeArchive(archive: null | undefined): null;
export function encodeArchive(archive: ReplayArchive | PackedReplay | null | undefined): PackedReplay | null;
export function encodeArchive(archive: ReplayArchive | PackedReplay | null | undefined): PackedReplay | null {
    if (!archive) return null;
    if (archive.format === REPLAY_FORMAT) return archive;
    return {
        format: REPLAY_FORMAT,
        engineVersion: archive.engineVersion,
        mode: archive.mode || '',
        seed: archive.seed,
        colors: archive.colors,
        pieceCount: archive.pieceCount,
        happy: archive.happy ? 1 : 0,
        skillMode: archive.skillMode ? 1 : 0,
        startEnergy: archive.startEnergy || 0,
        players: (archive.players || []).map(player => [player.color, player.nickname, player.isAI ? 1 : 0, player.emoji || '']),
        finished: archive.finished ? 1 : 0,
        winner: archive.winner || 0,
        turn: archive.turn || 0,
        actionCount: (archive.actions || []).length,
        actions: (archive.actions || []).map(item => trimTrailingZeros([item.p, ...encodeReplayAction(item.a)] as PackedAction, 2)),
    };
}

export function decodeArchive(packed: ReplayArchive | PackedReplay): ReplayArchive;
export function decodeArchive(packed: null | undefined): null | undefined;
export function decodeArchive(packed: ReplayArchive | PackedReplay | null | undefined): ReplayArchive | null | undefined;
export function decodeArchive(packed: ReplayArchive | PackedReplay | null | undefined): ReplayArchive | null | undefined {
    if (!packed || packed.format !== REPLAY_FORMAT) return packed;
    return {
        engineVersion: packed.engineVersion,
        mode: packed.mode || '',
        seed: packed.seed,
        colors: packed.colors,
        pieceCount: packed.pieceCount,
        happy: Boolean(packed.happy),
        skillMode: Boolean(packed.skillMode),
        startEnergy: packed.startEnergy || 0,
        players: (packed.players || []).map(player => ({ color: player[0], nickname: player[1], isAI: Boolean(player[2]), emoji: player[3] || null })),
        finished: Boolean(packed.finished),
        winner: packed.winner || null,
        turn: packed.turn || 0,
        actionCount: (packed.actions || []).length,
        // Older archives trimmed a bare roll to [player]; recover its missing code.
        actions: (packed.actions || []).map(item => {
            const rest = item.slice(1);
            return { p: item[0], a: decodeReplayAction(rest.length ? rest : [0])! };
        }),
    };
}
