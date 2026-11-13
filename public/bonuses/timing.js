// OBS может обработать событие позже его короткой анимации.
// Показываем свежие события полностью; старые не воспроизводим после долгого простоя.
export function canShowBonus(popup, serverNow) {
  return !!popup && Number.isFinite(popup.at) && serverNow - popup.at < 10000;
}
