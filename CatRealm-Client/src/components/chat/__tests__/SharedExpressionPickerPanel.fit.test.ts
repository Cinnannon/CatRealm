import { describe, expect, it } from 'vitest';
import { clampPanelLeft, isInsideExpressionPicker } from '../SharedExpressionPickerPanel';

describe('clampPanelLeft', () => {
  it('keeps the panel at the picker button when it fits', () => {
    expect(clampPanelLeft(100, 480, 1920)).toBe(100);
  });

  it('moves a full-width panel left just enough to stay on screen', () => {
    // Voice/theater side chat on the right edge of a 2000px window.
    expect(clampPanelLeft(1600, 480, 2000)).toBe(2000 - 8 - 480);
  });

  it('never moves the panel past the left gutter', () => {
    expect(clampPanelLeft(0, 480, 400)).toBe(8);
  });
});

describe('isInsideExpressionPicker', () => {
  it('recognises elements inside the portalled panel', () => {
    const panel = document.createElement('div');
    panel.setAttribute('data-expression-picker-panel', '');
    const emote = document.createElement('button');
    panel.appendChild(emote);
    document.body.appendChild(panel);
    expect(isInsideExpressionPicker(emote)).toBe(true);
    expect(isInsideExpressionPicker(document.body)).toBe(false);
    expect(isInsideExpressionPicker(null)).toBe(false);
    panel.remove();
  });
});
