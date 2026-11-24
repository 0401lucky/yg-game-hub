export function showModeRulesModal(): void {
  document.getElementById('modeRulesModal')!.style.display = 'flex';
}
export function hideModeRulesModal(): void {
  document.getElementById('modeRulesModal')!.style.display = 'none';
}
declare global {
  interface Window {
    showModeRulesModal: typeof showModeRulesModal;
    hideModeRulesModal: typeof hideModeRulesModal;
  }
}
window.showModeRulesModal = showModeRulesModal;
window.hideModeRulesModal = hideModeRulesModal;
