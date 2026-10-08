import { TimeCurveCard } from './card.js';
import { TimeCurveCardEditor } from './editor.js';

export { TimeCurveCard, TimeCurveCardEditor };

window.customCards = window.customCards ?? [];
if (!window.customCards.some((c) => c.type === 'time-curve-card')) {
  window.customCards.push({
    type: 'time-curve-card',
    name: 'Time Curve Card',
    description:
      'Dessinez une courbe journali\u{e8}re (luminosit\u{e9}, temp\u{e9}rature, temp\u{e9}rature de couleur\u{2026}) en d\u{e9}pla\u{e7}ant des points.',
    // The card renders with its stub config (getStubConfig picks an input_text from hass).
    preview: true,
  });
}

// One-line version banner so a stale cached resource is obvious in the console.
console.info(
  `%c TIME-CURVE-CARD %c v${__CARD_VERSION__} `,
  'color: white; background: #e67e22; font-weight: 700;',
  'color: #e67e22; background: white; font-weight: 700;',
);
