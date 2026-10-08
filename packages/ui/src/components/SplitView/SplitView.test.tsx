import '../../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { dividerTarget, keyboardDelta, maxPaneSize, resolvePaneResize } from './layout';
import { SplitPane, SplitView } from './SplitView';

describe('resolvePaneResize', () => {
  const c = { min: 180, max: 360, collapsible: true };
  it('clamps to [min, max] and rounds', () => {
    expect(resolvePaneResize(250.4, c)).toEqual({ size: 250, collapsed: false });
    expect(resolvePaneResize(500, c)).toEqual({ size: 360, collapsed: false });
    expect(resolvePaneResize(120, c)).toEqual({ size: 180, collapsed: false });
  });
  it('snaps collapsible panes closed below half of their minimum', () => {
    expect(resolvePaneResize(89, c)).toEqual({ size: undefined, collapsed: true });
    expect(resolvePaneResize(89, { ...c, collapsible: false })).toEqual({ size: 180, collapsed: false });
  });
  it('respects the room the neighbours can give', () => {
    expect(resolvePaneResize(340, c, 300)).toEqual({ size: 300, collapsed: false });
    // never below the minimum, even when there is no room
    expect(resolvePaneResize(340, c, 100)).toEqual({ size: 180, collapsed: false });
  });
});

describe('dividerTarget / maxPaneSize / keyboardDelta', () => {
  it('resizes the fixed neighbour of a divider', () => {
    expect(dividerTarget({ fixed: true }, { fixed: false })).toBe('before');
    expect(dividerTarget({ fixed: false }, { fixed: true })).toBe('after');
    expect(dividerTarget({ fixed: false }, { fixed: false })).toBeNull();
  });
  it('computes the slack of flexible panes', () => {
    expect(maxPaneSize(200, [{ size: 800, min: 300 }])).toBe(700);
    expect(maxPaneSize(200, [{ size: 250, min: 300 }])).toBe(200);
  });
  it('maps arrow keys to signed steps', () => {
    expect(keyboardDelta('ArrowRight', true, false, 1)).toBe(10);
    expect(keyboardDelta('ArrowRight', true, true, 1)).toBe(50);
    expect(keyboardDelta('ArrowRight', true, false, -1)).toBe(-10);
    expect(keyboardDelta('ArrowDown', false, false, 1)).toBe(10);
    expect(keyboardDelta('ArrowUp', true, false, 1)).toBeNull();
    expect(keyboardDelta('a', true, false, 1)).toBeNull();
  });
});

function stubWidth(el: Element, width: number) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, bottom: 600, right: width, width, height: 600, toJSON: () => ({}),
  } as DOMRect);
}

function renderSplit(props: { onSize?: (n: number) => void; onCollapsed?: (c: boolean) => void; collapsed?: boolean }) {
  const utils = render(
    <SplitView>
      <SplitPane
        id="sidebar"
        label="Sidebar"
        size={220}
        minSize={180}
        maxSize={360}
        collapsible
        collapsed={props.collapsed ?? false}
        onSizeChange={props.onSize}
        onCollapsedChange={props.onCollapsed}
      >
        <div>Sidebar content</div>
      </SplitPane>
      <SplitPane id="main" minSize={300}>
        <div>Main content</div>
      </SplitPane>
    </SplitView>,
  );
  const sidebar = utils.container.querySelector('[data-split-pane="sidebar"]')!;
  const main = utils.container.querySelector('[data-split-pane="main"]')!;
  stubWidth(sidebar, 220);
  stubWidth(main, 800);
  return utils;
}

describe('SplitView', () => {
  it('renders panes with an accessible, focusable divider', () => {
    renderSplit({});
    const sep = screen.getByRole('separator', { name: 'Resize Sidebar' });
    expect(sep.getAttribute('aria-valuenow')).toBe('220');
    expect(sep.getAttribute('aria-valuemin')).toBe('180');
    expect(sep.getAttribute('aria-valuemax')).toBe('360');
    expect(sep.tabIndex).toBe(0);
    expect(screen.getByText('Main content')).toBeTruthy();
  });

  it('resizes with the keyboard (Shift for big steps, Home/End for the limits)', () => {
    const onSize = vi.fn();
    renderSplit({ onSize });
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(onSize).toHaveBeenLastCalledWith(230);
    fireEvent.keyDown(sep, { key: 'ArrowLeft', shiftKey: true });
    expect(onSize).toHaveBeenLastCalledWith(180);
    fireEvent.keyDown(sep, { key: 'End' });
    expect(onSize).toHaveBeenLastCalledWith(360);
  });

  it('collapses with Return and double-click', () => {
    const onCollapsed = vi.fn();
    renderSplit({ onCollapsed });
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'Enter' });
    expect(onCollapsed).toHaveBeenLastCalledWith(true);
    fireEvent.doubleClick(sep);
    expect(onCollapsed).toHaveBeenCalledTimes(2);
  });

  it('follows the pointer while dragging and snaps closed past half the minimum', () => {
    const onSize = vi.fn();
    const onCollapsed = vi.fn();
    renderSplit({ onSize, onCollapsed });
    const sep = screen.getByRole('separator');
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientX: 220 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 262 });
    expect(onSize).toHaveBeenLastCalledWith(262);
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 60 });
    expect(onCollapsed).toHaveBeenLastCalledWith(true);
    fireEvent.pointerUp(sep, { pointerId: 1, clientX: 60 });
    expect(document.documentElement.classList.contains('hh-split-resizing-x')).toBe(false);
  });

  it('hides collapsed panes from assistive technology but keeps them mounted', () => {
    renderSplit({ collapsed: true });
    const pane = document.querySelector('[data-split-pane="sidebar"]')!;
    expect(pane.getAttribute('aria-hidden')).toBe('true');
    expect(pane.textContent).toContain('Sidebar content');
  });
});
