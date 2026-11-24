/// <reference types="vite/client" />
import type { PublicUser, AccountStats } from '../games/shared/protocol.ts';
export interface AccountUI {
  refresh(): Promise<unknown>;
  getUser(): PublicUser | null;
  getStats(): AccountStats | null;
  onChange(callback: (user: PublicUser | null, stats: AccountStats | null) => void): void;
  openLogin(): void;
}
declare global {
  const __FLIGHT_BANNED_WORDS__: readonly string[];
  interface Window {
    accountUI?: AccountUI;
    gameInstance?: import('../games/flight/js/types.ts').GameRuntime;
    main?: import('../games/flight/js/types.ts').GameRuntime;
    gameState?: typeof import('../games/flight/js/gameState.ts').gameState;
    uiUpdater?: typeof import('../games/flight/js/uiUpdater.ts').uiUpdater;
    gameInfo?: typeof import('../games/flight/js/gameInfo.ts').gameInfo;
    botController?: typeof import('../games/flight/js/botController.ts').botController;
    audioManager?: typeof import('../games/flight/js/audioManager.ts').audioManager;
    eventHandler?: typeof import('../games/flight/js/eventHandler.ts').eventHandler;
    aiTakeoverManager?: typeof import('../games/flight/js/aiTakeoverManager.ts').aiTakeoverManager;
    playerNameManager?: typeof import('../games/flight/js/playerNameManager.ts').playerNameManager;
    playerIdManager?: typeof import('../games/flight/js/playerIdManager.ts').playerIdManager;
    activePlayerManager?: typeof import('../games/flight/js/activePlayerManager.ts').activePlayerManager;
    energyManager?: typeof import('../games/flight/js/energyManager.ts').energyManager;
    energyDisplay?: typeof import('../games/flight/js/energyDisplay.ts').energyDisplay;
    progressDisplay?: typeof import('../games/flight/js/progressDisplay.ts').progressDisplay;
    skillManager?: typeof import('../games/flight/js/skillManager.ts').skillManager;
    multiplayerGameManager?: typeof import('../games/flight/js/multiplayerGameManager.ts').multiplayerGameManager;
    multiplayerManager?: typeof import('../games/flight/js/multiplayerManager.ts').multiplayerManager;
    reconnectManager?: typeof import('../games/flight/js/reconnectManager.ts').reconnectManager;
    playerSetup?: import('../games/flight/js/indexMain.ts').PlayerSetup;
    WebSocketClient?: typeof import('../games/flight/js/websocketClient.ts').WebSocketClient;
    wsClient?: import('../games/flight/js/websocketClient.ts').WebSocketClient;
    boardRotation?: number;
    boardRotationTotal?: number;
    syncInitialEnergySliders?: () => void;
    toggleDebugPanel?: () => void;
    clipboardData?: DataTransfer;
    webkitAudioContext?: typeof AudioContext;
  }
}
