import '../../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { decimalsOf, formatNumberValue, normalizeNumber, parseNumberInput, stepNumber } from './number';
import { NumberField } from './NumberField';

describe('number rules', () => {
  it('parses lenient user input', () => {
    expect(parseNumberInput('1,256')).toBe(1256);
    expect(parseNumberInput(' 1 256 bp')).toBe(1256);
    expect(parseNumberInput('−5')).toBe(-5);
    expect(parseNumberInput('+3.5')).toBe(3.5);
    expect(parseNumberInput('.5')).toBe(0.5);
    expect(parseNumberInput('62.5 °C')).toBe(62.5);
    expect(parseNumberInput('')).toBeNull();
    expect(parseNumberInput('-')).toBeNull();
    expect(parseNumberInput('12x3')).toBeNull();
    expect(parseNumberInput('abc')).toBeNull();
  });

  it('formats with grouping and limited decimals', () => {
    expect(formatNumberValue(1256, 0)).toBe('1,256');
    expect(formatNumberValue(52.25, 1)).toBe('52.3');
    expect(formatNumberValue(60, 1)).toBe('60');
  });

  it('derives decimals from the step', () => {
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.5)).toBe(1);
    expect(decimalsOf(0.01)).toBe(2);
    expect(decimalsOf(1e-7)).toBe(7);
  });

  it('clamps and rounds', () => {
    expect(normalizeNumber(105, 0, 100, 0)).toBe(100);
    expect(normalizeNumber(-1, 0, 100, 0)).toBe(0);
    expect(normalizeNumber(1.26, 0, 100, 1)).toBe(1.3);
  });

  it('steps onto the step grid like NSStepper', () => {
    expect(stepNumber(60, 1, 0.5, 40, 80, 1)).toBe(60.5);
    expect(stepNumber(60.2, 1, 0.5, 40, 80, 1)).toBe(60.5);
    expect(stepNumber(60.2, -1, 0.5, 40, 80, 1)).toBe(60);
    expect(stepNumber(80, 1, 0.5, 40, 80, 1)).toBe(80);
    expect(stepNumber(null, 1, 1, -Infinity, Infinity, 0)).toBe(0);
    expect(stepNumber(7, 1, 5, 0, 100, 0)).toBe(10);
  });

  it('adds large steps exactly after snapping to the small-step grid', () => {
    expect(stepNumber(60.5, -1, 0.5, 40, 80, 1, 5)).toBe(55.5);
    expect(stepNumber(60.2, 1, 0.5, 40, 80, 1, 5)).toBe(65);
    expect(stepNumber(78, 1, 0.5, 40, 80, 1, 5)).toBe(80);
  });
});

function Harness({ onChange, allowEmpty }: { onChange: (v: number | null) => void; allowEmpty?: boolean }) {
  const [value, setValue] = useState<number | null>(60);
  return (
    <NumberField
      aria-label="Tm"
      value={value}
      unit="°C"
      min={40}
      max={80}
      step={0.5}
      allowEmpty={allowEmpty}
      onValueChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe('NumberField', () => {
  it('exposes spinbutton semantics with the unit in the value text', () => {
    render(<Harness onChange={() => undefined} />);
    const input = screen.getByRole('spinbutton', { name: 'Tm' });
    expect(input.getAttribute('aria-valuenow')).toBe('60');
    expect(input.getAttribute('aria-valuemin')).toBe('40');
    expect(input.getAttribute('aria-valuetext')).toBe('60 °C');
    expect(screen.getByText('°C')).toBeTruthy();
  });

  it('commits typed text on Return, clamped to the range', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '95' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(80);
    expect(input.value).toBe('80');
  });

  it('commits on blur and reverts on Escape', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '55.5' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('60');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '55.5' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(55.5);
  });

  it('reverts invalid text instead of committing it', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'warm' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('60');
  });

  it('clears to null only when allowed', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} allowEmpty />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('steps with the arrow keys (Shift = 10 steps)', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith(60.5);
    fireEvent.keyDown(input, { key: 'ArrowDown', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(55.5);
  });

  it('steps with the stepper buttons', () => {
    const onChange = vi.fn();
    const { container } = render(<Harness onChange={onChange} />);
    const up = container.querySelector('[data-direction="up"]')!;
    fireEvent.pointerDown(up, { pointerId: 1, button: 0 });
    fireEvent.pointerUp(up, { pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(60.5);
  });
});
